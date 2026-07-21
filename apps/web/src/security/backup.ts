import initCrypto, {
  wasm_decrypt_backup,
  wasm_encrypt_backup,
} from "../crypto-wasm/covechat_crypto";
import type { EncryptedBackup } from "@covechat/protocol";
import {
  loadTrustState,
  type SecureProfile,
  type TrustState,
} from "./vault";
import { loadLatestBackup, uploadBackup } from "./api";
import type { AuthSession } from "@covechat/protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
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

async function digest(value: string): Promise<string> {
  return toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
}

export async function createEncryptedBackup(
  profile: SecureProfile,
  previous?: EncryptedBackup,
): Promise<EncryptedBackup> {
  await ensureCrypto();
  const { pendingAttachmentUploads: _deviceLocalUploads, ...portableTrustState } = await loadTrustState(profile);
  const payload = {
    version: 2,
    profile,
    trustState: portableTrustState,
  };
  const plaintext = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const ciphertext = wasm_encrypt_backup(
    profile.recoverySecret,
    profile.accountKeys.publicKey,
    plaintext,
  );
  const backup = {
    protocolVersion: 1 as const,
    version: previous ? previous.version + 1 : 1,
    previousDigest: previous?.ciphertextDigest,
    ciphertext,
    ciphertextDigest: await digest(ciphertext),
    createdAt: Math.floor(Date.now() / 1000),
  };
  localStorage.setItem(`covechat:backup_version:${profile.username}`, backup.version.toString());
  return backup;
}

export type RestoredBackup = {
  profile: SecureProfile;
  trustState: TrustState;
};

export async function decryptBackup(
  backup: EncryptedBackup,
  recoverySecret: string,
  accountPublicKey: string,
): Promise<RestoredBackup> {
  if (await digest(backup.ciphertext) !== backup.ciphertextDigest) {
    throw new Error("backup digest mismatch");
  }
  await ensureCrypto();
  const plaintext = wasm_decrypt_backup(
    recoverySecret,
    accountPublicKey,
    backup.ciphertext,
  );
  const decoded = JSON.parse(
    decoder.decode(fromBase64Url(plaintext)),
  ) as SecureProfile | { version: 2; profile: SecureProfile; trustState: TrustState };
  const profile = decoded.version === 2 && "profile" in decoded ? decoded.profile : decoded;
  const trustState = decoded.version === 2 && "trustState" in decoded
    ? decoded.trustState
    : { version: 1 as const, identities: {} };
  if (profile.version !== 1 || profile.recoverySecret !== recoverySecret) {
    throw new Error("invalid backup");
  }
  const knownVersion = parseInt(localStorage.getItem(`covechat:backup_version:${profile.username}`) || "0", 10);
  if (backup.version < knownVersion) {
    throw new Error("backup rollback detected: version older than local anchor");
  }
  localStorage.setItem(`covechat:backup_version:${profile.username}`, backup.version.toString());
  return { profile, trustState };
}

let pendingSync: Promise<void> = Promise.resolve();
const BACKUP_CONFLICT_RETRIES = 3;

export function syncEncryptedBackup(
  profile: SecureProfile,
  session: AuthSession,
): Promise<void> {
  pendingSync = pendingSync.catch(() => undefined).then(async () => {
    for (let attempt = 0; attempt <= BACKUP_CONFLICT_RETRIES; attempt += 1) {
      const previous = await loadLatestBackup(session);
      try {
        await uploadBackup(await createEncryptedBackup(profile, previous ?? undefined), session);
        return;
      } catch (error) {
        const conflict = error instanceof Error && error.message.endsWith(": 409");
        if (!conflict || attempt === BACKUP_CONFLICT_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** attempt)));
      }
    }
  });
  return pendingSync;
}
