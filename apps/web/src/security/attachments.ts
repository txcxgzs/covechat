import type {
  AttachmentReference,
  AuthSession,
} from "@covechat/protocol";
import initCrypto, {
  wasm_decrypt_attachment_chunk,
  wasm_encrypt_attachment_chunk,
  wasm_generate_attachment_key,
} from "../crypto-wasm/covechat_crypto";
import {
  createAttachmentObject,
  finalizeAttachment,
  loadAttachmentChunk,
  loadAttachmentManifest,
  uploadAttachmentChunk,
} from "./api";

export const ATTACHMENT_CHUNK_SIZE = 1024 * 1024;
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024;
const encoder = new TextEncoder();
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

function encodedBlobLength(plaintextLength: number): number {
  const encodedCiphertextLength = Math.ceil((plaintextLength + 16) * 4 / 3);
  return JSON.stringify({
    version: 1,
    nonce: "x".repeat(32),
    ciphertext: "x".repeat(encodedCiphertextLength),
  }).length;
}

export async function encryptAndUploadAttachment(
  file: File,
  session: AuthSession,
  expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
): Promise<AttachmentReference> {
  if (file.size <= 0 || file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error("invalid attachment size");
  }
  await ensureCrypto();
  const objectId = crypto.randomUUID();
  const objectContext = toBase64Url(encoder.encode(objectId));
  const fileKey = wasm_generate_attachment_key();
  const chunkCount = Math.ceil(file.size / ATTACHMENT_CHUNK_SIZE);
  let ciphertextSize = 0;
  for (let offset = 0; offset < file.size; offset += ATTACHMENT_CHUNK_SIZE) {
    ciphertextSize += encodedBlobLength(
      Math.min(ATTACHMENT_CHUNK_SIZE, file.size - offset),
    );
  }
  await createAttachmentObject(
    { objectId, chunkCount, ciphertextSize, expiresAt },
    session,
  );
  const chunkDigests: string[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * ATTACHMENT_CHUNK_SIZE;
    const plaintext = new Uint8Array(
      await file.slice(start, Math.min(file.size, start + ATTACHMENT_CHUNK_SIZE)).arrayBuffer(),
    );
    const ciphertext = wasm_encrypt_attachment_chunk(
      fileKey,
      objectContext,
      chunkIndex,
      toBase64Url(plaintext),
    );
    const ciphertextDigest = await digest(ciphertext);
    await uploadAttachmentChunk(
      objectId,
      chunkIndex,
      ciphertext,
      ciphertextDigest,
      session,
    );
    chunkDigests.push(ciphertextDigest);
  }
  await finalizeAttachment(objectId, session);
  return {
    protocolVersion: 1,
    objectId,
    chunkCount,
    chunkDigests,
    ciphertextSize,
    expiresAt,
    fileKey,
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    plaintextSize: file.size,
  };
}

export async function downloadAndDecryptAttachment(
  reference: AttachmentReference,
  session: AuthSession,
): Promise<Blob> {
  await ensureCrypto();
  const manifest = await loadAttachmentManifest(reference.objectId, session);
  if (
    manifest.chunkCount !== reference.chunkCount
    || manifest.ciphertextSize !== reference.ciphertextSize
    || manifest.chunkDigests.length !== reference.chunkDigests.length
    || manifest.chunkDigests.some((value, index) => value !== reference.chunkDigests[index])
  ) {
    throw new Error("attachment manifest mismatch");
  }
  const objectContext = toBase64Url(encoder.encode(reference.objectId));
  const plaintextChunks: Uint8Array[] = [];
  let plaintextSize = 0;
  for (let chunkIndex = 0; chunkIndex < manifest.chunkCount; chunkIndex += 1) {
    const chunk = await loadAttachmentChunk(reference.objectId, chunkIndex, session);
    if (
      chunk.ciphertextDigest !== reference.chunkDigests[chunkIndex]
      || await digest(chunk.ciphertext) !== chunk.ciphertextDigest
    ) {
      throw new Error("attachment chunk mismatch");
    }
    const plaintext = fromBase64Url(
      wasm_decrypt_attachment_chunk(
        reference.fileKey,
        objectContext,
        chunkIndex,
        chunk.ciphertext,
      ),
    );
    plaintextSize += plaintext.length;
    plaintextChunks.push(plaintext);
  }
  if (plaintextSize !== reference.plaintextSize) {
    throw new Error("attachment plaintext size mismatch");
  }
  return new Blob(plaintextChunks, { type: reference.mimeType });
}
