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
  const response = await fetch(`/api/v1/devices/${profile.deviceId}/prekeys`, {
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
  });
  if (!response.ok) throw new Error(`pre-key publish failed: ${response.status}`);
  profile.signalPreKeyVersion = prekeyVersion;
  profile.signalPublished = true;
}

function authenticatedHeaders(session: AuthSession): HeadersInit {
  return { authorization: `Bearer ${session.accessToken}` };
}

export async function lookupDirectory(
  username: string,
  session: AuthSession,
): Promise<DirectoryResponse> {
  const response = await fetch(`/api/v1/directory/${encodeURIComponent(username)}`, {
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`directory lookup failed: ${response.status}`);
  return response.json() as Promise<DirectoryResponse>;
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
 * @returns true 表示执行了修复（调用方需要 saveSecureProfile）；false 表示无需修复
 * @throws  设备已被 revoke 或不在 directory 中，需要走完整 recovery 流程
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
  const payload = encoder.encode(JSON.stringify([
    ownDevice.protocolVersion,
    ownDevice.deviceId,
    ownDevice.username,
    ownDevice.signingPublicKey,
    ownDevice.prekeyVersion,
    ownDevice.prekeyBundle,
    ownDevice.createdAt,
  ]));
  const valid = await verifySignature(
    directory.account.signingPublicKey,
    payload,
    ownDevice.authorizationSignature,
  );
  if (valid) return false;
  // 签名损坏：先把本地 prekey 版本同步到服务端值，再强制轮换。
  // publishSignalPreKeys 会基于当前 signal state 生成新 bundle 并用账户密钥重签，
  // 服务端接受后 device.authorization_signature 即被刷新为有效值。
  profile.signalPreKeyVersion = ownDevice.prekeyVersion;
  await publishSignalPreKeys(profile, session);
  return true;
}

export async function listOwnDevices(session: AuthSession): Promise<DeviceRecord[]> {
  const response = await fetch("/api/v1/devices", {
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`device list failed: ${response.status}`);
  return response.json() as Promise<DeviceRecord[]>;
}

export async function revokeOwnDevice(
  deviceId: string,
  session: AuthSession,
): Promise<void> {
  const response = await fetch(`/api/v1/devices/${deviceId}/revoke`, {
    method: "POST",
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`device revocation failed: ${response.status}`);
}

export async function listBlockedUsers(session: AuthSession): Promise<string[]> {
  const response = await fetch("/api/v1/blocks", {
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`block list failed: ${response.status}`);
  return response.json() as Promise<string[]>;
}

export async function setUserBlocked(
  username: string,
  blocked: boolean,
  session: AuthSession,
): Promise<void> {
  const response = await fetch(`/api/v1/blocks/${encodeURIComponent(username)}`, {
    method: blocked ? "POST" : "DELETE",
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`block update failed: ${response.status}`);
}

export async function deleteOwnAccount(profile: SecureProfile, session: AuthSession): Promise<void> {
  const createdAt = Math.floor(Date.now() / 1000);
  const signature = await signWithAccount(profile, encoder.encode(JSON.stringify([1, "delete-account", profile.username, createdAt])));
  const response = await fetch("/api/v1/account", { method: "DELETE", headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` }, body: JSON.stringify({ username: profile.username, createdAt, signature }) });
  if (!response.ok) throw new Error(`account deletion failed: ${response.status}`);
}

export async function listContacts(session: AuthSession): Promise<ContactSummary[]> {
  const response = await fetch("/api/v1/contacts", { headers: authenticatedHeaders(session) });
  if (!response.ok) throw new Error(`contacts failed: ${response.status}`);
  return response.json() as Promise<ContactSummary[]>;
}

export async function listContactRequests(session: AuthSession): Promise<ContactRequests> {
  const response = await fetch("/api/v1/contact-requests", { headers: authenticatedHeaders(session) });
  if (!response.ok) throw new Error(`contact requests failed: ${response.status}`);
  return response.json() as Promise<ContactRequests>;
}

export async function sendContactRequest(username: string, session: AuthSession): Promise<{ status: "pending" | "accepted" | "contact" }> {
  const response = await fetch(`/api/v1/contact-requests/${encodeURIComponent(username)}`, { method: "POST", headers: authenticatedHeaders(session) });
  if (!response.ok) throw new Error(response.status === 404 ? "user-not-found" : response.status === 403 ? "contact-forbidden" : `contact request failed: ${response.status}`);
  return response.json() as Promise<{ status: "pending" | "accepted" | "contact" }>;
}

export async function acceptContactRequest(username: string, session: AuthSession): Promise<void> {
  const response = await fetch(`/api/v1/contact-requests/${encodeURIComponent(username)}/accept`, { method: "POST", headers: authenticatedHeaders(session) });
  if (!response.ok) throw new Error(`accept request failed: ${response.status}`);
}

export async function removeContactRequest(username: string, session: AuthSession): Promise<void> {
  const response = await fetch(`/api/v1/contact-requests/${encodeURIComponent(username)}`, { method: "DELETE", headers: authenticatedHeaders(session) });
  if (!response.ok) throw new Error(`remove request failed: ${response.status}`);
}

export async function removeContact(username: string, session: AuthSession): Promise<void> {
  const response = await fetch(`/api/v1/contacts/${encodeURIComponent(username)}`, { method: "DELETE", headers: authenticatedHeaders(session) });
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
  const response = await fetch("/api/v1/reports", {
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
  });
  if (!response.ok) throw new Error(`report submission failed: ${response.status}`);
}

export async function readMailbox(
  session: AuthSession,
): Promise<EncryptedEnvelope[]> {
  const response = await fetch(`/api/v1/mailboxes/${session.deviceId}`, {
    headers: authenticatedHeaders(session),
  });
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
  const response = await fetch("/api/v1/envelopes", {
    method: "POST",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
      "x-idempotency-key": envelope.idempotencyKey,
    },
    body: JSON.stringify({ ...envelope, signature }),
  });
  if (!response.ok) throw new Error(`envelope send failed: ${response.status}`);
}

export async function acknowledgeEnvelope(
  envelopeId: string,
  session: AuthSession,
): Promise<void> {
  const response = await fetch(
    `/api/v1/mailboxes/${session.deviceId}/envelopes/${envelopeId}`,
    { method: "DELETE", headers: authenticatedHeaders(session) },
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
  const response = await fetch("/api/v1/backups/latest", {
    headers: authenticatedHeaders(session),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`backup read failed: ${response.status}`);
  return response.json() as Promise<EncryptedBackup>;
}

export async function uploadBackup(
  backup: EncryptedBackup,
  session: AuthSession,
): Promise<void> {
  const response = await fetch("/api/v1/backups", {
    method: "PUT",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify(backup),
  });
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
  const response = await fetch("/api/v1/attachments", {
    method: "POST",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify({ protocolVersion: 1, ...input }),
  });
  if (!response.ok) throw new Error(`attachment create failed: ${response.status}`);
}

export async function loadAttachmentUploadStatus(
  objectId: string,
  session: AuthSession,
): Promise<import("@covechat/protocol").AttachmentUploadStatus> {
  const response = await fetch(`/api/v1/attachments/${objectId}/upload-status`, {
    headers: authenticatedHeaders(session),
  });
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
  const response = await fetch(
    `/api/v1/attachments/${objectId}/chunks/${chunkIndex}`,
    {
      method: "PUT",
      headers: {
        ...authenticatedHeaders(session),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ciphertext, ciphertextDigest }),
    },
  );
  if (!response.ok) throw new Error(`attachment chunk upload failed: ${response.status}`);
}

export async function finalizeAttachment(
  objectId: string,
  session: AuthSession,
): Promise<void> {
  const response = await fetch(`/api/v1/attachments/${objectId}/finalize`, {
    method: "POST",
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`attachment finalize failed: ${response.status}`);
}

export async function loadAttachmentManifest(
  objectId: string,
  session: AuthSession,
): Promise<EncryptedAttachment> {
  const response = await fetch(`/api/v1/attachments/${objectId}`, {
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`attachment manifest failed: ${response.status}`);
  return response.json() as Promise<EncryptedAttachment>;
}

export async function loadAttachmentChunk(
  objectId: string,
  chunkIndex: number,
  session: AuthSession,
): Promise<{ ciphertext: string; ciphertextDigest: string }> {
  const response = await fetch(
    `/api/v1/attachments/${objectId}/chunks/${chunkIndex}`,
    { headers: authenticatedHeaders(session) },
  );
  if (!response.ok) throw new Error(`attachment chunk read failed: ${response.status}`);
  return response.json() as Promise<{ ciphertext: string; ciphertextDigest: string }>;
}

export async function deleteAttachmentObject(
  reference: AttachmentReference,
  session: AuthSession,
): Promise<void> {
  const response = await fetch(`/api/v1/attachments/${reference.objectId}`, {
    method: "DELETE",
    headers: authenticatedHeaders(session),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`attachment delete failed: ${response.status}`);
  }
}
