import type {
  AccountIdentity,
  AttachmentReference,
  AuthSession,
  DirectoryResponse,
  EncryptedBackup,
  EncryptedEnvelope,
  EncryptedAttachment,
  DeviceRecord,
} from "@covechat/protocol";
import {
  signWithAccount,
  signWithDevice,
  signRecoveryChallenge,
  verifySignature,
  type PublishedPreKeyBundle,
  type SecureProfile,
} from "./vault";

const encoder = new TextEncoder();

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export type AuthenticatedProfile = {
  profile: SecureProfile;
  session: AuthSession;
};

export type RecoverySession = {
  accessToken: string;
  expiresAt: number;
};

export type RecoveryBackup = {
  account: AccountIdentity;
  backup: EncryptedBackup;
};

export type ContactSummary = { username: string; createdAt: number };
export type ContactRequests = { incoming: ContactSummary[]; outgoing: ContactSummary[] };

/**
 * Session 自动刷新机制。
 *
 * 服务端 session 有效期 1 小时，手机端长时间挂起后 session 过期，
 * 任何 authenticated 请求都会返回 401。为避免用户被迫重新解锁，
 * api.ts 维护一个可变 session holder：SecurityGate 在解锁/恢复时
 * 调用 registerSessionRef 设置当前 profile + session。
 *
 * authenticatedFetch 在收到 401 时调用 authenticateProfile 重新认证，
 * 更新 holder 中的 session 并通知 onSessionRefreshed 回调（让 UI 同步），
 * 然后重试一次原始请求。
 */
type SessionHolder = {
  profile: SecureProfile;
  session: AuthSession;
  onRefresh?: (session: AuthSession) => void;
};

let sessionHolder: SessionHolder | undefined;

/** SecurityGate 注册当前已认证 profile + session，启用 401 自动重认证。 */
export function registerSessionRef(
  profile: SecureProfile,
  session: AuthSession,
  onRefresh?: (session: AuthSession) => void,
): void {
  sessionHolder = { profile, session, onRefresh };
}

/** SecurityGate 在退出时清除 holder，避免泄露。 */
export function unregisterSessionRef(): void {
  sessionHolder = undefined;
}

async function refreshSession(): Promise<AuthSession | undefined> {
  if (!sessionHolder) return undefined;
  try {
    const fresh = await authenticateProfile(sessionHolder.profile);
    sessionHolder.session = fresh;
    sessionHolder.onRefresh?.(fresh);
    return fresh;
  } catch {
    return undefined;
  }
}

/**
 * 带 401 自动重认证的 fetch 包装。
 * 仅用于需要 Bearer token 的请求；onboarding/recovery 等匿名请求直接用 fetch。
 * 重试只发生一次，避免无限循环。
 */
async function authenticatedFetch(
  url: string,
  init: RequestInit,
  session: AuthSession,
): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status !== 401) return response;
  // 401：尝试重新认证后重试一次
  const refreshed = await refreshSession();
  if (!refreshed) return response;
  // 用新 token 重建请求
  const retryInit: RequestInit = {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${refreshed.accessToken}`,
    },
  };
  return fetch(url, retryInit);
}

function devicePayload(profile: SecureProfile, prekeyBundle: string): Uint8Array {
  return encoder.encode(JSON.stringify([
    1,
    profile.deviceId,
    profile.username,
    profile.deviceKeys.publicKey,
    profile.signalPreKeyVersion,
    prekeyBundle,
    profile.createdAt,
  ]));
}

function publishedPreKeyBundle(profile: SecureProfile): string {
  return JSON.stringify({
    version: 1,
    signal: profile.signal.preKeyBundle,
    mlsKeyPackage: profile.mls.keyPackage,
  } satisfies PublishedPreKeyBundle);
}

export async function provisionProfile(profile: SecureProfile): Promise<AuthSession> {
  const prekeyBundle = publishedPreKeyBundle(profile);
  const authorizationSignature = await signWithAccount(profile, devicePayload(profile, prekeyBundle));
  const response = await fetch("/api/v1/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account: {
        protocolVersion: 1,
        username: profile.username,
        signingPublicKey: profile.accountKeys.publicKey,
        recoveryPublicKey: profile.recoveryKeys.publicKey,
        recoveryVersion: 1,
      },
      device: {
        protocolVersion: 1,
        deviceId: profile.deviceId,
        username: profile.username,
        signingPublicKey: profile.deviceKeys.publicKey,
        prekeyVersion: profile.signalPreKeyVersion,
        prekeyBundle,
        authorizationSignature,
        createdAt: profile.createdAt,
      },
    }),
  });
  if (!response.ok) throw new Error(`onboarding failed: ${response.status}`);
  return authenticateProfile(profile);
}

export async function authenticateProfile(profile: SecureProfile): Promise<AuthSession> {
  const challengeResponse = await fetch(`/api/v1/auth/challenges/${profile.deviceId}`, { method: "POST" });
  if (!challengeResponse.ok) throw new Error(`challenge failed: ${challengeResponse.status}`);
  const challenge = await challengeResponse.json() as {
    challengeId: string;
    challenge: string;
    expiresAt: number;
  };
  const signature = await signWithDevice(profile, fromBase64Url(challenge.challenge));
  const verifyResponse = await fetch("/api/v1/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
  });
  if (!verifyResponse.ok) throw new Error(`authentication failed: ${verifyResponse.status}`);
  return verifyResponse.json() as Promise<AuthSession>;
}

export async function publishSignalPreKeys(
  profile: SecureProfile,
  session: AuthSession,
): Promise<void> {
  const prekeyVersion = profile.signalPreKeyVersion + 1;
  const prekeyBundle = publishedPreKeyBundle(profile);
  const updatedAt = Math.floor(Date.now() / 1000);
  // authorizationSignature 覆盖了 prekeyVersion/prekeyBundle 字段，
  // prekey 轮换后旧签名会失效，必须同步用账户密钥对新的设备 payload 重签。
  const previousPreKeyVersion = profile.signalPreKeyVersion;
  profile.signalPreKeyVersion = prekeyVersion;
  let authorizationSignature: string;
  try {
    authorizationSignature = await signWithAccount(profile, devicePayload(profile, prekeyBundle));
  } finally {
    // 仅当请求成功后才会真正推进版本号；签名阶段失败需要回滚以保持本地状态一致
    profile.signalPreKeyVersion = previousPreKeyVersion;
  }
  const signature = await signWithDevice(
    profile,
    encoder.encode(JSON.stringify([
      1,
      profile.deviceId,
      prekeyVersion,
      prekeyBundle,
      updatedAt,
    ])),
  );
  const response = await authenticatedFetch(`/api/v1/devices/${profile.deviceId}/prekeys`, {
    method: "PUT",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion: 1,
      prekeyVersion,
      prekeyBundle,
      updatedAt,
      signature,
      authorizationSignature,
    }),
  }, session);
  if (!response.ok) throw new Error(`pre-key publish failed: ${response.status}`);
  profile.signalPreKeyVersion = prekeyVersion;
  profile.signalPublished = true;
  // prekey 轮换后本端在服务端的 device record 已更新，旧 directory 缓存失效，
  // 必须清除以免后续 selfHeal/对端查询复用过期数据。
  invalidateDirectoryCache(profile.username);
}

function authenticatedHeaders(session: AuthSession): HeadersInit {
  return { authorization: `Bearer ${session.accessToken}` };
}

export async function lookupDirectory(
  username: string,
  session: AuthSession,
): Promise<DirectoryResponse> {
  return lookupDirectoryInternal(username, session, false);
}

/**
 * 强制刷新 directory 缓存并重新查询。
 *
 * 用于 prekey 轮换 / self-heal 等场景：本端或对端的设备记录刚发生过变更，
 * 旧缓存不再反映服务端真实状态，必须重新拉取。
 */
async function lookupDirectoryFresh(
  username: string,
  session: AuthSession,
): Promise<DirectoryResponse> {
  return lookupDirectoryInternal(username, session, true);
}

async function lookupDirectoryInternal(
  username: string,
  session: AuthSession,
  forceRefresh: boolean,
): Promise<DirectoryResponse> {
  const normalized = username.trim().toLowerCase();
  if (!forceRefresh) {
    const cached = directoryCacheGet(normalized);
    if (cached) return cached;
  }
  // 并发去重：同一 username 同时进行的查询合并成单个网络请求，
  // 避免收消息循环里多条消息触发并发 lookup 击穿限流。
  // 注意：forceRefresh 模式下不能复用 inflight——可能命中 prekey 轮换前发起的
  // 旧请求，导致 selfHeal 二次验证拿到过期数据而误判服务端未升级。
  if (!forceRefresh) {
    const inflight = directoryInflightGet(normalized);
    if (inflight) return inflight;
  }
  const promise = (async () => {
    const response = await authenticatedFetch(`/api/v1/directory/${encodeURIComponent(normalized)}`, {
      headers: authenticatedHeaders(session),
    }, session);
    if (!response.ok) throw new Error(`directory lookup failed: ${response.status}`);
    const result = await response.json() as DirectoryResponse;
    directoryCacheSet(normalized, result);
    return result;
  })();
  directoryInflightSet(normalized, promise);
  try {
    return await promise;
  } finally {
    // 仅当 inflight 仍指向当前 promise 时才删除。
    // forceRefresh 场景下可能覆盖了之前的 inflight，旧 promise 完成时不应误删新 promise 的记录。
    directoryInflightDeleteIfMatch(normalized, promise);
  }
}

/** 清除指定 username 的 directory 缓存。prekey 轮换后本端设备记录变更，旧缓存失效。 */
function invalidateDirectoryCache(username: string): void {
  const normalized = username.trim().toLowerCase();
  directoryCache.delete(normalized);
}

/**
 * Directory 缓存与并发去重。
 *
 * 服务端对 /v1/directory 按 device_id 限流（60 次/60 秒），但发消息和收消息
 * 循环都会触发 lookupDirectory，活跃对话极易击穿限流返回 429。
 *
 * 这里加两层防御：
 * 1. 短 TTL 内存缓存（30 秒）：同一 username 在 TTL 内复用结果，避免重复请求。
 *    directory 数据本质上是设备 prekey bundle，prekey 轮换频率远低于 30 秒，
 *    即便对端在缓存期内轮换了 prekey，本端建立 session 用的旧 bundle 仍可解密
 *    （Signal 协议设计如此），最多触发一次 prekey 消息重发。
 * 2. in-flight 去重：同一 username 的并发请求合并为单个 fetch。
 */
const DIRECTORY_CACHE_TTL_MS = 30_000;
const directoryCache = new Map<string, { value: DirectoryResponse; expiresAt: number }>();
const directoryInflight = new Map<string, Promise<DirectoryResponse>>();

function directoryCacheGet(username: string): DirectoryResponse | undefined {
  const entry = directoryCache.get(username);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    directoryCache.delete(username);
    return undefined;
  }
  return entry.value;
}

function directoryCacheSet(username: string, value: DirectoryResponse): void {
  directoryCache.set(username, { value, expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS });
}

function directoryInflightGet(username: string): Promise<DirectoryResponse> | undefined {
  return directoryInflight.get(username);
}

function directoryInflightSet(username: string, promise: Promise<DirectoryResponse>): void {
  directoryInflight.set(username, promise);
}

function directoryInflightDeleteIfMatch(
  username: string,
  promise: Promise<DirectoryResponse>,
): void {
  if (directoryInflight.get(username) === promise) {
    directoryInflight.delete(username);
  }
}

/**
 * 自愈检查：验证自己设备在服务端的 authorization_signature 是否仍然有效。
 *
 * 升级前的旧版 prekey 轮换没有同步刷新 authorization_signature，导致服务端已有的
 * 设备记录签名与 prekey_bundle/prekey_version 不一致。任何对端查询 directory 时
 * observeAndCheckIdentity 都会拒绝该设备，消息无法送达。
 *
 * 本函数在解锁后主动查询自己的 directory 并验签；若签名损坏，则同步本地 prekey
 * 版本到服务端值并强制触发一次 prekey 轮换。新版 publishSignalPreKeys 会用账户
 * 密钥对新 payload 重签，服务端 update_prekeys 验证通过后即修复历史脏数据。
 *
 * 修复后会重新查询 directory 二次验证；若服务端仍是旧版（未部署 signature 同步
 * 代码），update_prekeys 会静默忽略 authorizationSignature 字段，二次验证仍失败，
 * 此时抛出明确错误提示部署方升级服务端。
 *
 * @returns true 表示执行了修复（调用方需要 saveSecureProfile）；false 表示无需修复
 * @throws  设备已被 revoke / 不在 directory 中 / 服务端未升级，需要走完整 recovery 流程
 */
export async function selfHealDeviceSignature(
  profile: SecureProfile,
  session: AuthSession,
): Promise<boolean> {
  const directory = await lookupDirectory(profile.username, session);
  const ownDevice = directory.devices.find(
    (device) => device.deviceId === profile.deviceId && !device.revokedAt,
  );
  if (!ownDevice) {
    throw new Error("device not found in directory; recovery required");
  }
  if (await deviceSignatureValid(directory.account.signingPublicKey, ownDevice)) return false;
  // 签名损坏：先把本地 prekey 版本同步到服务端值，再强制轮换。
  // publishSignalPreKeys 会基于当前 signal state 生成新 bundle 并用账户密钥重签，
  // 服务端接受后 device.authorization_signature 即被刷新为有效值。
  profile.signalPreKeyVersion = ownDevice.prekeyVersion;
  await publishSignalPreKeys(profile, session);
  // 二次验证：确认服务端真的更新了 authorization_signature。
  // 旧版服务端 serde 会忽略未知字段 authorizationSignature，返回成功但不更新签名，
  // 此时需要明确告知部署方升级服务端，而不是让用户反复尝试。
  // 必须强制刷新缓存：publishSignalPreKeys 虽然已清除本端缓存，但并发场景下
  // 其他调用可能已经把旧 directory 重新写入缓存，导致二次验证拿到过期数据。
  const refreshed = await lookupDirectoryFresh(profile.username, session);
  const refreshedDevice = refreshed.devices.find(
    (device) => device.deviceId === profile.deviceId && !device.revokedAt,
  );
  if (!refreshedDevice) {
    throw new Error("device disappeared after self-heal; recovery required");
  }
  if (!(await deviceSignatureValid(refreshed.account.signingPublicKey, refreshedDevice))) {
    throw new Error(
      "self-heal failed: server did not persist authorization_signature; "
        + "deploy the updated API before retrying",
    );
  }
  return true;
}

/**
 * 验证 directory 中某个设备的 authorization_signature 是否由对应账户密钥签出。
 * payload 7 元组与 onboarding / update_prekeys 保持一致。
 */
async function deviceSignatureValid(
  accountSigningKey: string,
  device: DeviceRecord,
): Promise<boolean> {
  const payload = encoder.encode(JSON.stringify([
    device.protocolVersion,
    device.deviceId,
    device.username,
    device.signingPublicKey,
    device.prekeyVersion,
    device.prekeyBundle,
    device.createdAt,
  ]));
  return verifySignature(accountSigningKey, payload, device.authorizationSignature);
}

export async function listOwnDevices(session: AuthSession): Promise<DeviceRecord[]> {
  const response = await authenticatedFetch("/api/v1/devices", {
    headers: authenticatedHeaders(session),
  }, session);
  if (!response.ok) throw new Error(`device list failed: ${response.status}`);
  return response.json() as Promise<DeviceRecord[]>;
}

export async function revokeOwnDevice(
  deviceId: string,
  session: AuthSession,
): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/devices/${deviceId}/revoke`, {
    method: "POST",
    headers: authenticatedHeaders(session),
  }, session);
  if (!response.ok) throw new Error(`device revocation failed: ${response.status}`);
}

export async function listBlockedUsers(session: AuthSession): Promise<string[]> {
  const response = await authenticatedFetch("/api/v1/blocks", {
    headers: authenticatedHeaders(session),
  }, session);
  if (!response.ok) throw new Error(`block list failed: ${response.status}`);
  return response.json() as Promise<string[]>;
}

export async function setUserBlocked(
  username: string,
  blocked: boolean,
  session: AuthSession,
): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/blocks/${encodeURIComponent(username)}`, {
    method: blocked ? "POST" : "DELETE",
    headers: authenticatedHeaders(session),
  }, session);
  if (!response.ok) throw new Error(`block update failed: ${response.status}`);
}

export async function deleteOwnAccount(profile: SecureProfile, session: AuthSession): Promise<void> {
  const createdAt = Math.floor(Date.now() / 1000);
  const signature = await signWithAccount(profile, encoder.encode(JSON.stringify([1, "delete-account", profile.username, createdAt])));
  const response = await authenticatedFetch("/api/v1/account", { method: "DELETE", headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` }, body: JSON.stringify({ username: profile.username, createdAt, signature }) }, session);
  if (!response.ok) throw new Error(`account deletion failed: ${response.status}`);
}

export async function listContacts(session: AuthSession): Promise<ContactSummary[]> {
  const response = await authenticatedFetch("/api/v1/contacts", { headers: authenticatedHeaders(session) }, session);
  if (!response.ok) throw new Error(`contacts failed: ${response.status}`);
  return response.json() as Promise<ContactSummary[]>;
}

export async function listContactRequests(session: AuthSession): Promise<ContactRequests> {
  const response = await authenticatedFetch("/api/v1/contact-requests", { headers: authenticatedHeaders(session) }, session);
  if (!response.ok) throw new Error(`contact requests failed: ${response.status}`);
  return response.json() as Promise<ContactRequests>;
}

export async function sendContactRequest(username: string, session: AuthSession): Promise<{ status: "pending" | "accepted" | "contact" }> {
  const response = await authenticatedFetch(`/api/v1/contact-requests/${encodeURIComponent(username)}`, { method: "POST", headers: authenticatedHeaders(session) }, session);
  if (!response.ok) throw new Error(response.status === 404 ? "user-not-found" : response.status === 403 ? "contact-forbidden" : `contact request failed: ${response.status}`);
  return response.json() as Promise<{ status: "pending" | "accepted" | "contact" }>;
}

export async function acceptContactRequest(username: string, session: AuthSession): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/contact-requests/${encodeURIComponent(username)}/accept`, { method: "POST", headers: authenticatedHeaders(session) }, session);
  if (!response.ok) throw new Error(`accept request failed: ${response.status}`);
}

export async function removeContactRequest(username: string, session: AuthSession): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/contact-requests/${encodeURIComponent(username)}`, { method: "DELETE", headers: authenticatedHeaders(session) }, session);
  if (!response.ok) throw new Error(`remove request failed: ${response.status}`);
}

export async function removeContact(username: string, session: AuthSession): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/contacts/${encodeURIComponent(username)}`, { method: "DELETE", headers: authenticatedHeaders(session) }, session);
  if (!response.ok) throw new Error(`remove contact failed: ${response.status}`);
}

export async function submitAbuseReport(
  profile: SecureProfile,
  session: AuthSession,
  reportedUsername: string,
  disclosedMessageBundle: string,
  context: string,
): Promise<void> {
  const protocolVersion = 1;
  const reportId = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  const reporterSignature = await signWithDevice(
    profile,
    encoder.encode(JSON.stringify([
      protocolVersion,
      reportId,
      reportedUsername,
      disclosedMessageBundle,
      context,
      createdAt,
    ])),
  );
  const response = await authenticatedFetch("/api/v1/reports", {
    method: "POST",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion,
      reportId,
      reportedUsername,
      disclosedMessageBundle,
      context,
      createdAt,
      reporterSignature,
    }),
  }, session);
  if (!response.ok) throw new Error(`report submission failed: ${response.status}`);
}

export async function readMailbox(
  session: AuthSession,
): Promise<EncryptedEnvelope[]> {
  const response = await authenticatedFetch(`/api/v1/mailboxes/${session.deviceId}`, {
    headers: authenticatedHeaders(session),
  }, session);
  if (!response.ok) throw new Error(`mailbox read failed: ${response.status}`);
  return response.json() as Promise<EncryptedEnvelope[]>;
}

export async function sendEnvelope(
  envelope: Omit<EncryptedEnvelope, "signature">,
  profile: SecureProfile,
  session: AuthSession,
): Promise<void> {
  const signature = await signWithDevice(
    profile,
    encoder.encode(JSON.stringify([
      envelope.protocolVersion,
      envelope.envelopeId,
      envelope.senderDeviceId,
      envelope.recipientDeviceId,
      envelope.conversationId,
      envelope.sequence,
      envelope.expiresAt,
      envelope.ciphertext,
      envelope.idempotencyKey,
    ])),
  );
  const response = await authenticatedFetch("/api/v1/envelopes", {
    method: "POST",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
      "x-idempotency-key": envelope.idempotencyKey,
    },
    body: JSON.stringify({ ...envelope, signature }),
  }, session);
  if (!response.ok) throw new Error(`envelope send failed: ${response.status}`);
}

export async function acknowledgeEnvelope(
  envelopeId: string,
  session: AuthSession,
): Promise<void> {
  const response = await authenticatedFetch(
    `/api/v1/mailboxes/${session.deviceId}/envelopes/${envelopeId}`,
    { method: "DELETE", headers: authenticatedHeaders(session) },
    session,
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`envelope acknowledgement failed: ${response.status}`);
  }
}

export function subscribeMailbox(
  session: AuthSession,
  onChanged: () => void,
): () => void {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    `${scheme}//${window.location.host}/api/v1/events/${session.deviceId}`,
    ["covechat", session.accessToken],
  );
  socket.addEventListener("message", (event) => {
    if (event.data === "mailbox.changed") onChanged();
  });
  return () => socket.close(1000, "client closing");
}

export async function loadLatestBackup(
  session: AuthSession,
): Promise<EncryptedBackup | undefined> {
  const response = await authenticatedFetch("/api/v1/backups/latest", {
    headers: authenticatedHeaders(session),
  }, session);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`backup read failed: ${response.status}`);
  return response.json() as Promise<EncryptedBackup>;
}

export async function uploadBackup(
  backup: EncryptedBackup,
  session: AuthSession,
): Promise<void> {
  const response = await authenticatedFetch("/api/v1/backups", {
    method: "PUT",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify(backup),
  }, session);
  if (!response.ok) throw new Error(`backup upload failed: ${response.status}`);
}

export async function authenticateRecovery(
  username: string,
  recoverySecret: string,
): Promise<RecoverySession> {
  const normalized = username.trim().toLowerCase();
  const challengeResponse = await fetch(
    `/api/v1/recovery/challenges/${encodeURIComponent(normalized)}`,
    { method: "POST" },
  );
  if (!challengeResponse.ok) {
    throw new Error(`recovery challenge failed: ${challengeResponse.status}`);
  }
  const challenge = await challengeResponse.json() as {
    challengeId: string;
    challenge: string;
    expiresAt: number;
  };
  const signature = await signRecoveryChallenge(
    recoverySecret,
    normalized,
    fromBase64Url(challenge.challenge),
  );
  const verifyResponse = await fetch("/api/v1/recovery/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
  });
  if (!verifyResponse.ok) {
    throw new Error(`recovery authentication failed: ${verifyResponse.status}`);
  }
  return verifyResponse.json() as Promise<RecoverySession>;
}

export async function loadBackupForRecovery(
  session: RecoverySession,
): Promise<RecoveryBackup> {
  const response = await fetch("/api/v1/recovery/backups/latest", {
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) throw new Error(`recovery backup failed: ${response.status}`);
  return response.json() as Promise<RecoveryBackup>;
}

export async function registerRecoveredDevice(
  profile: SecureProfile,
  recoverySession: RecoverySession,
): Promise<AuthSession> {
  const prekeyBundle = JSON.stringify(profile.signal.preKeyBundle);
  const authorizationSignature = await signWithAccount(
    profile,
    devicePayload(profile, prekeyBundle),
  );
  const response = await fetch("/api/v1/recovery/devices", {
    method: "POST",
    headers: {
      authorization: `Bearer ${recoverySession.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion: 1,
      deviceId: profile.deviceId,
      username: profile.username,
      signingPublicKey: profile.deviceKeys.publicKey,
      prekeyVersion: profile.signalPreKeyVersion,
      prekeyBundle,
      authorizationSignature,
      createdAt: profile.createdAt,
    }),
  });
  if (!response.ok) {
    throw new Error(`recovered device registration failed: ${response.status}`);
  }
  return authenticateProfile(profile);
}

export async function createAttachmentObject(
  input: Pick<EncryptedAttachment, "objectId" | "chunkCount" | "ciphertextSize" | "expiresAt">,
  session: AuthSession,
): Promise<void> {
  const response = await authenticatedFetch("/api/v1/attachments", {
    method: "POST",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify({ protocolVersion: 1, ...input }),
  }, session);
  if (!response.ok) throw new Error(`attachment create failed: ${response.status}`);
}

export async function loadAttachmentUploadStatus(
  objectId: string,
  session: AuthSession,
): Promise<import("@covechat/protocol").AttachmentUploadStatus> {
  const response = await authenticatedFetch(`/api/v1/attachments/${objectId}/upload-status`, {
    headers: authenticatedHeaders(session),
  }, session);
  if (!response.ok) throw new Error(`attachment upload status failed: ${response.status}`);
  return response.json() as Promise<import("@covechat/protocol").AttachmentUploadStatus>;
}

export async function uploadAttachmentChunk(
  objectId: string,
  chunkIndex: number,
  ciphertext: string,
  ciphertextDigest: string,
  session: AuthSession,
): Promise<void> {
  const response = await authenticatedFetch(
    `/api/v1/attachments/${objectId}/chunks/${chunkIndex}`,
    {
      method: "PUT",
      headers: {
        ...authenticatedHeaders(session),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ciphertext, ciphertextDigest }),
    },
    session,
  );
  if (!response.ok) throw new Error(`attachment chunk upload failed: ${response.status}`);
}

export async function finalizeAttachment(
  objectId: string,
  session: AuthSession,
): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/attachments/${objectId}/finalize`, {
    method: "POST",
    headers: authenticatedHeaders(session),
  }, session);
  if (!response.ok) throw new Error(`attachment finalize failed: ${response.status}`);
}

export async function loadAttachmentManifest(
  objectId: string,
  session: AuthSession,
): Promise<EncryptedAttachment> {
  const response = await authenticatedFetch(`/api/v1/attachments/${objectId}`, {
    headers: authenticatedHeaders(session),
  }, session);
  if (!response.ok) throw new Error(`attachment manifest failed: ${response.status}`);
  return response.json() as Promise<EncryptedAttachment>;
}

export async function loadAttachmentChunk(
  objectId: string,
  chunkIndex: number,
  session: AuthSession,
): Promise<{ ciphertext: string; ciphertextDigest: string }> {
  const response = await authenticatedFetch(
    `/api/v1/attachments/${objectId}/chunks/${chunkIndex}`,
    { headers: authenticatedHeaders(session) },
    session,
  );
  if (!response.ok) throw new Error(`attachment chunk read failed: ${response.status}`);
  return response.json() as Promise<{ ciphertext: string; ciphertextDigest: string }>;
}

export async function deleteAttachmentObject(
  reference: AttachmentReference,
  session: AuthSession,
): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/attachments/${reference.objectId}`, {
    method: "DELETE",
    headers: authenticatedHeaders(session),
  }, session);
  if (!response.ok && response.status !== 404) {
    throw new Error(`attachment delete failed: ${response.status}`);
  }
}
