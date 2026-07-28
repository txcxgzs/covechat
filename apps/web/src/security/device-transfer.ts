export type DeviceRecoveryTransfer = {
  version: 1;
  username: string;
  recoverySecret: string;
};

const HASH_PREFIX = "#recover=";
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
