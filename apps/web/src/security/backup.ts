import initCrypto, {
  wasm_decrypt_backup,
  wasm_encrypt_backup,
} from "../crypto-wasm/covechat_crypto";
import type { EncryptedBackup } from "@covechat/protocol";
import type { SecureProfile } from "./vault";

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
  const plaintext = toBase64Url(encoder.encode(JSON.stringify(profile)));
  const ciphertext = wasm_encrypt_backup(
    profile.recoverySecret,
    profile.accountKeys.publicKey,
    plaintext,
  );
  return {
    protocolVersion: 1,
    version: previous ? previous.version + 1 : 1,
    previousDigest: previous?.ciphertextDigest,
    ciphertext,
    ciphertextDigest: await digest(ciphertext),
    createdAt: Math.floor(Date.now() / 1000),
  };
}

export async function decryptBackup(
  backup: EncryptedBackup,
  recoverySecret: string,
  accountPublicKey: string,
): Promise<SecureProfile> {
  if (await digest(backup.ciphertext) !== backup.ciphertextDigest) {
    throw new Error("backup digest mismatch");
  }
  await ensureCrypto();
  const plaintext = wasm_decrypt_backup(
    recoverySecret,
    accountPublicKey,
    backup.ciphertext,
  );
  const profile = JSON.parse(
    decoder.decode(fromBase64Url(plaintext)),
  ) as SecureProfile;
  if (profile.version !== 1 || profile.recoverySecret !== recoverySecret) {
    throw new Error("invalid backup");
  }
  return profile;
}
