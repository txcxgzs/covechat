export type DeviceRecoveryTransfer = {
  version: 1;
  username: string;
  recoverySecret: string;
};

export type DeviceLinkApproval = {
  version: 1;
  linkId: string;
  linkSecret: string;
  requesterPublicKey: string;
};

export type DeviceLinkKeyPair = {
  publicKey: string;
  privateKey: string;
};

const HASH_PREFIX = "#recover=";
const APPROVAL_HASH_PREFIX = "#approve-device=";
const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/u;

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid recovery transfer encoding");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function bytesFromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid binary encoding");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function buildDeviceRecoveryUrl(
  origin: string,
  username: string,
  recoverySecret: string,
): string {
  const normalized = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized) || recoverySecret.trim().length < 20) {
    throw new Error("invalid recovery transfer");
  }
  const payload: DeviceRecoveryTransfer = {
    version: 1,
    username: normalized,
    recoverySecret: recoverySecret.trim(),
  };
  const url = new URL("/", origin);
  url.hash = `recover=${toBase64Url(JSON.stringify(payload))}`;
  return url.toString();
}

export function parseDeviceRecoveryHash(hash: string): DeviceRecoveryTransfer | undefined {
  if (!hash.startsWith(HASH_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(fromBase64Url(hash.slice(HASH_PREFIX.length))) as Partial<DeviceRecoveryTransfer>;
    if (
      parsed.version !== 1
      || typeof parsed.username !== "string"
      || !USERNAME_PATTERN.test(parsed.username)
      || typeof parsed.recoverySecret !== "string"
      || parsed.recoverySecret.length < 20
    ) return undefined;
    return {
      version: 1,
      username: parsed.username,
      recoverySecret: parsed.recoverySecret,
    };
  } catch {
    return undefined;
  }
}

export function buildDeviceApprovalUrl(origin: string, approval: DeviceLinkApproval): string {
  if (
    approval.version !== 1
    || !/^[0-9a-f-]{36}$/u.test(approval.linkId)
    || approval.linkSecret.length < 32
    || approval.requesterPublicKey.length < 32
  ) throw new Error("invalid device link approval");
  const url = new URL("/", origin);
  url.hash = `approve-device=${toBase64Url(JSON.stringify(approval))}`;
  return url.toString();
}

export function parseDeviceApprovalHash(hash: string): DeviceLinkApproval | undefined {
  if (!hash.startsWith(APPROVAL_HASH_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(fromBase64Url(hash.slice(APPROVAL_HASH_PREFIX.length))) as Partial<DeviceLinkApproval>;
    if (
      parsed.version !== 1
      || typeof parsed.linkId !== "string"
      || !/^[0-9a-f-]{36}$/u.test(parsed.linkId)
      || typeof parsed.linkSecret !== "string"
      || parsed.linkSecret.length < 32
      || typeof parsed.requesterPublicKey !== "string"
      || parsed.requesterPublicKey.length < 32
    ) return undefined;
    return parsed as DeviceLinkApproval;
  } catch {
    return undefined;
  }
}

async function importEcdhKey(key: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    JSON.parse(key) as JsonWebKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    usage,
  );
}

export async function createDeviceLinkKeyPair(): Promise<DeviceLinkKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  return {
    publicKey: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    privateKey: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
  };
}

async function deriveTransferKey(privateKey: string, peerPublicKey: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "ECDH",
      public: await importEcdhKey(peerPublicKey, []),
    },
    await importEcdhKey(privateKey, ["deriveKey"]),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptDeviceLinkPayload(
  requesterPublicKey: string,
  linkId: string,
  payload: DeviceRecoveryTransfer,
): Promise<{ approverPublicKey: string; encryptedPayload: string }> {
  const approver = await createDeviceLinkKeyPair();
  const key = await deriveTransferKey(approver.privateKey, requesterPublicKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(linkId) },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return {
    approverPublicKey: approver.publicKey,
    encryptedPayload: JSON.stringify({
      version: 1,
      nonce: bytesToBase64Url(nonce),
      ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    }),
  };
}

export async function decryptDeviceLinkPayload(
  requesterPrivateKey: string,
  approverPublicKey: string,
  linkId: string,
  encryptedPayload: string,
): Promise<DeviceRecoveryTransfer> {
  const wrapper = JSON.parse(encryptedPayload) as { version: number; nonce: string; ciphertext: string };
  if (wrapper.version !== 1) throw new Error("unsupported device link payload");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytesFromBase64Url(wrapper.nonce),
      additionalData: new TextEncoder().encode(linkId),
    },
    await deriveTransferKey(requesterPrivateKey, approverPublicKey),
    bytesFromBase64Url(wrapper.ciphertext),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as DeviceRecoveryTransfer;
  if (parsed.version !== 1 || !USERNAME_PATTERN.test(parsed.username) || parsed.recoverySecret.length < 20) {
    throw new Error("invalid device link payload");
  }
  return parsed;
}
