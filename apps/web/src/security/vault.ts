import initCrypto, {
  wasm_create_local_vault,
  wasm_decrypt_mls_state,
  wasm_decrypt_signal_state,
  wasm_decrypt_trust_state,
  wasm_derive_recovery_signing_keypair,
  wasm_generate_recovery_secret,
  wasm_generate_signing_keypair,
  wasm_open_local_vault,
  wasm_encrypt_signal_state,
  wasm_encrypt_trust_state,
  wasm_encrypt_mls_state,
  wasm_mls_create_device,
  wasm_signal_create_device,
  wasm_sign_payload,
  wasm_verify_signature,
} from "../crypto-wasm/covechat_crypto";

const DATABASE = "covechat-secure";
const STORE = "vault";
const VAULT_KEY = "primary";
const SIGNAL_STATE_KEY = "signal-state";
const MLS_STATE_KEY = "mls-state";
const TRUST_STATE_KEY = "trust-state";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type SigningKeyPair = {
  privateKey: string;
  publicKey: string;
};

export type SignalPreKeyBundle = {
  version: 1;
  ownerName: string;
  deviceId: number;
  registrationId: number;
  identityKey: string;
  preKeyId: number;
  preKeyPublic: string;
  signedPreKeyId: number;
  signedPreKeyPublic: string;
  signedPreKeySignature: string;
  kyberPreKeyId: number;
  kyberPreKeyPublic: string;
  kyberPreKeySignature: string;
};

export type SignalDeviceBootstrap = {
  state: Record<string, unknown>;
  preKeyBundle: SignalPreKeyBundle;
};

export type MlsDeviceBootstrap = {
  state: Record<string, unknown>;
  keyPackage: string;
  groups?: MlsGroupMetadata[];
};

export type MlsGroupMetadata = {
  groupId: string;
  conversationId: string;
  name: string;
  epoch: number;
  memberDeviceIds: string[];
  // 管理员设备列表。创建者默认为管理员；管理员可移除成员、切换邀请策略。
  adminDeviceIds?: string[];
  // 邀请策略：anyone=所有成员可邀请，admins=仅管理员可邀请。
  invitePolicy?: "anyone" | "admins";
  // 加密群策略的单调版本，防止管理员列表回滚。
  policyRevision?: number;
  // deviceId → MLS leafIndex 映射。removeGroupMember 需要 leafIndex 定位成员。
  memberLeafIndices?: Record<string, number>;
};

export type PublishedPreKeyBundle = {
  version: 1;
  signal: SignalPreKeyBundle;
  mlsKeyPackage: string;
};

export type SecureProfile = {
  version: 1;
  username: string;
  accountKeys: SigningKeyPair;
  recoveryKeys: SigningKeyPair;
  deviceId: string;
  deviceKeys: SigningKeyPair;
  signal: SignalDeviceBootstrap;
  mls: MlsDeviceBootstrap;
  signalPreKeyVersion: number;
  signalPublished: boolean;
  recoverySecret: string;
  createdAt: number;
  serverRegistered: boolean;
};

type StoredVault = {
  id: typeof VAULT_KEY;
  version: 1;
  encryptedVault: string;
  updatedAt: number;
};

type StoredSignalState = {
  id: typeof SIGNAL_STATE_KEY;
  version: 1;
  encryptedState: string;
  updatedAt: number;
};

type StoredMlsState = {
  id: typeof MLS_STATE_KEY;
  version: 1;
  encryptedState: string;
  updatedAt: number;
};

type StoredTrustState = {
  id: typeof TRUST_STATE_KEY;
  version: 1;
  encryptedState: string;
  updatedAt: number;
};

export type TrustedIdentity = {
  accountSigningKey: string;
  deviceFingerprints: Record<string, string>;
  verifiedFingerprint?: string;
  verifiedAt?: number;
};

export type TrustState = {
  version: 1;
  identities: Record<string, TrustedIdentity>;
  history?: Record<string, LocalHistoryItem[]>;
  pendingAttachmentUploads?: Record<string, PendingAttachmentUpload>;
};

export type PendingAttachmentUpload = {
  version: 1;
  fingerprint: string;
  objectId: string;
  fileKey: string;
  fileName: string;
  mimeType: string;
  plaintextSize: number;
  lastModified: number;
  chunkCount: number;
  ciphertextSize: number;
  expiresAt: number;
  chunkDigests: Array<string | null>;
};

export type LocalHistoryItem = {
  id: string;
  from: "me" | "them";
  body?: string;
  attachment?: import("@covechat/protocol").AttachmentReference;
  createdAt: number;
  expiresAt?: number;
  reply?: import("./message-content").ReplyReference;
};

let cryptoReady: Promise<unknown> | undefined;

function ensureCrypto() {
  cryptoReady ??= initCrypto();
  return cryptoReady;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("secure storage unavailable"));
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = operation(database.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("secure storage operation failed"));
    });
  } finally {
    database.close();
  }
}

export async function hasLocalVault(): Promise<boolean> {
  const record = await transaction<StoredVault | undefined>("readonly", (store) => store.get(VAULT_KEY));
  return record?.version === 1;
}

export async function deleteLocalVault(): Promise<void> {
  await transaction<undefined>("readwrite", (store) => store.clear());
}

export async function createSecureProfile(
  username: string,
  passphrase: string,
): Promise<SecureProfile> {
  await ensureCrypto();
  const normalized = username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/u.test(normalized)) throw new Error("invalid username");
  if (passphrase.length < 12) throw new Error("passphrase too short");
  const recoverySecret = wasm_generate_recovery_secret();
  const deviceId = crypto.randomUUID();
  const signal = JSON.parse(
    wasm_signal_create_device(deviceId, 1),
  ) as SignalDeviceBootstrap;
  const mls = JSON.parse(
    wasm_mls_create_device(`${normalized}/${deviceId}`),
  ) as MlsDeviceBootstrap;
  const profile: SecureProfile = {
    version: 1,
    username: normalized,
    accountKeys: JSON.parse(wasm_generate_signing_keypair()) as SigningKeyPair,
    recoveryKeys: JSON.parse(
      wasm_derive_recovery_signing_keypair(
        recoverySecret,
        toBase64Url(encoder.encode(normalized)),
      ),
    ) as SigningKeyPair,
    deviceId,
    deviceKeys: JSON.parse(wasm_generate_signing_keypair()) as SigningKeyPair,
    signal,
    mls,
    signalPreKeyVersion: 1,
    signalPublished: false,
    recoverySecret,
    createdAt: Math.floor(Date.now() / 1000),
    serverRegistered: false,
  };
  await saveSecureProfile(profile, passphrase);
  return profile;
}

export async function saveSecureProfile(
  profile: SecureProfile,
  passphrase: string,
): Promise<void> {
  await ensureCrypto();
  const plaintext = toBase64Url(encoder.encode(JSON.stringify(profile)));
  const encryptedVault = wasm_create_local_vault(passphrase, plaintext);
  await transaction<IDBValidKey>("readwrite", (store) => store.put({
    id: VAULT_KEY,
    version: 1,
    encryptedVault,
    updatedAt: Date.now(),
  } satisfies StoredVault));
  await saveSignalState(profile);
  await saveMlsState(profile);
}

export async function saveSignalState(profile: SecureProfile): Promise<void> {
  await ensureCrypto();
  const plaintext = toBase64Url(
    encoder.encode(JSON.stringify(profile.signal.state)),
  );
  const encryptedState = wasm_encrypt_signal_state(
    profile.deviceKeys.privateKey,
    plaintext,
  );
  await transaction<IDBValidKey>("readwrite", (store) => store.put({
    id: SIGNAL_STATE_KEY,
    version: 1,
    encryptedState,
    updatedAt: Date.now(),
  } satisfies StoredSignalState));
}

export async function saveMlsState(profile: SecureProfile): Promise<void> {
  await ensureCrypto();
  const plaintext = toBase64Url(
    encoder.encode(JSON.stringify(profile.mls)),
  );
  const encryptedState = wasm_encrypt_mls_state(
    profile.deviceKeys.privateKey,
    plaintext,
  );
  await transaction<IDBValidKey>("readwrite", (store) => store.put({
    id: MLS_STATE_KEY,
    version: 1,
    encryptedState,
    updatedAt: Date.now(),
  } satisfies StoredMlsState));
}

export async function loadTrustState(profile: SecureProfile): Promise<TrustState> {
  await ensureCrypto();
  const record = await transaction<StoredTrustState | undefined>(
    "readonly",
    (store) => store.get(TRUST_STATE_KEY),
  );
  if (!record || record.version !== 1) return { version: 1, identities: {} };
  const plaintext = wasm_decrypt_trust_state(
    profile.deviceKeys.privateKey,
    record.encryptedState,
  );
  const state = JSON.parse(decoder.decode(fromBase64Url(plaintext))) as TrustState;
  if (state.version !== 1 || !state.identities) throw new Error("invalid trust state");
  return state;
}

export async function saveTrustState(
  profile: SecureProfile,
  state: TrustState,
): Promise<void> {
  await ensureCrypto();
  const plaintext = toBase64Url(encoder.encode(JSON.stringify(state)));
  const encryptedState = wasm_encrypt_trust_state(
    profile.deviceKeys.privateKey,
    plaintext,
  );
  await transaction<IDBValidKey>("readwrite", (store) => store.put({
    id: TRUST_STATE_KEY,
    version: 1,
    encryptedState,
    updatedAt: Date.now(),
  } satisfies StoredTrustState));
}

async function restoreSignalState(profile: SecureProfile): Promise<void> {
  const record = await transaction<StoredSignalState | undefined>(
    "readonly",
    (store) => store.get(SIGNAL_STATE_KEY),
  );
  if (!record || record.version !== 1) return;
  const plaintext = wasm_decrypt_signal_state(
    profile.deviceKeys.privateKey,
    record.encryptedState,
  );
  profile.signal.state = JSON.parse(
    decoder.decode(fromBase64Url(plaintext)),
  ) as Record<string, unknown>;
}

async function restoreMlsState(profile: SecureProfile): Promise<void> {
  const record = await transaction<StoredMlsState | undefined>(
    "readonly",
    (store) => store.get(MLS_STATE_KEY),
  );
  if (!record || record.version !== 1) return;
  const plaintext = wasm_decrypt_mls_state(
    profile.deviceKeys.privateKey,
    record.encryptedState,
  );
  profile.mls = JSON.parse(
    decoder.decode(fromBase64Url(plaintext)),
  ) as MlsDeviceBootstrap;
}

export async function unlockSecureProfile(passphrase: string): Promise<SecureProfile> {
  await ensureCrypto();
  const record = await transaction<StoredVault | undefined>("readonly", (store) => store.get(VAULT_KEY));
  if (!record || record.version !== 1) throw new Error("vault not found");
  const plaintext = wasm_open_local_vault(passphrase, record.encryptedVault);
  const profile = JSON.parse(decoder.decode(fromBase64Url(plaintext))) as SecureProfile;
  if (profile.version !== 1) throw new Error("unsupported vault version");
  if (!profile.recoveryKeys) {
    profile.recoveryKeys = JSON.parse(
      wasm_derive_recovery_signing_keypair(
        profile.recoverySecret,
        toBase64Url(encoder.encode(profile.username)),
      ),
    ) as SigningKeyPair;
    profile.serverRegistered = false;
  }
  if (!profile.signal) {
    profile.signal = JSON.parse(
      wasm_signal_create_device(profile.deviceId, 1),
    ) as SignalDeviceBootstrap;
    profile.signalPublished = false;
    profile.signalPreKeyVersion = 1;
  } else {
    if (!profile.signalPreKeyVersion) profile.signalPreKeyVersion = 1;
    await restoreSignalState(profile);
  }
  if (!profile.mls) {
    profile.mls = JSON.parse(
      wasm_mls_create_device(`${profile.username}/${profile.deviceId}`),
    ) as MlsDeviceBootstrap;
    profile.signalPublished = false;
  } else {
    await restoreMlsState(profile);
  }
  return profile;
}

export async function signWithDevice(profile: SecureProfile, payload: Uint8Array): Promise<string> {
  await ensureCrypto();
  return wasm_sign_payload(profile.deviceKeys.privateKey, toBase64Url(payload));
}

export async function signWithAccount(profile: SecureProfile, payload: Uint8Array): Promise<string> {
  await ensureCrypto();
  return wasm_sign_payload(profile.accountKeys.privateKey, toBase64Url(payload));
}

export async function verifySignature(publicKey: string, payload: Uint8Array, signature: string): Promise<boolean> {
  await ensureCrypto();
  return wasm_verify_signature(publicKey, toBase64Url(payload), signature);
}

export async function deriveRecoveryKeys(
  recoverySecret: string,
  username: string,
): Promise<SigningKeyPair> {
  await ensureCrypto();
  return JSON.parse(
    wasm_derive_recovery_signing_keypair(
      recoverySecret,
      toBase64Url(encoder.encode(username.trim().toLowerCase())),
    ),
  ) as SigningKeyPair;
}

export async function signRecoveryChallenge(
  recoverySecret: string,
  username: string,
  payload: Uint8Array,
): Promise<string> {
  const keys = await deriveRecoveryKeys(recoverySecret, username);
  return wasm_sign_payload(keys.privateKey, toBase64Url(payload));
}

export async function rotateRecoveredDevice(
  profile: SecureProfile,
): Promise<SecureProfile> {
  await ensureCrypto();
  const deviceId = crypto.randomUUID();
  return {
    ...profile,
    deviceId,
    deviceKeys: JSON.parse(wasm_generate_signing_keypair()) as SigningKeyPair,
    signal: JSON.parse(
      wasm_signal_create_device(deviceId, 1),
    ) as SignalDeviceBootstrap,
    mls: JSON.parse(
      wasm_mls_create_device(`${profile.username}/${deviceId}`),
    ) as MlsDeviceBootstrap,
    signalPreKeyVersion: 1,
    signalPublished: false,
    createdAt: Math.floor(Date.now() / 1000),
    serverRegistered: false,
  };
}
