import type {
  AttachmentReference,
  AttachmentUploadStatus,
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
  loadAttachmentUploadStatus,
  uploadAttachmentChunk,
} from "./api";
import {
  loadTrustState,
  saveTrustState,
  type PendingAttachmentUpload,
  type SecureProfile,
} from "./vault";

export const ATTACHMENT_CHUNK_SIZE = 1024 * 1024;
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024;
// 单块上传失败后的最大重试次数（不含首次尝试）。
export const ATTACHMENT_CHUNK_MAX_RETRIES = 3;
// 重试初始退避（毫秒），每次翻倍：500ms → 1s → 2s。
const ATTACHMENT_RETRY_BASE_DELAY = 500;
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

async function fileFingerprint(file: File): Promise<string> {
  const contentDigest = toBase64Url(new Uint8Array(
    await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
  ));
  return digest(JSON.stringify({
    contentDigest,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  }));
}

async function savePendingUpload(
  profile: SecureProfile,
  upload: PendingAttachmentUpload,
): Promise<void> {
  const state = await loadTrustState(profile);
  state.pendingAttachmentUploads ??= {};
  state.pendingAttachmentUploads[upload.fingerprint] = upload;
  await saveTrustState(profile, state);
}

async function clearPendingUpload(profile: SecureProfile, fingerprint: string): Promise<void> {
  const state = await loadTrustState(profile);
  if (!state.pendingAttachmentUploads?.[fingerprint]) return;
  delete state.pendingAttachmentUploads[fingerprint];
  await saveTrustState(profile, state);
}

export function reconcileAttachmentUpload(
  upload: PendingAttachmentUpload,
  status: AttachmentUploadStatus,
): Map<number, string> {
  if (
    status.protocolVersion !== 1
    || status.objectId !== upload.objectId
    || status.chunkCount !== upload.chunkCount
    || status.ciphertextSize !== upload.ciphertextSize
    || status.expiresAt !== upload.expiresAt
  ) {
    throw new Error("attachment upload state mismatch");
  }
  const received = new Map<number, string>();
  for (const chunk of status.receivedChunks) {
    if (
      !Number.isInteger(chunk.chunkIndex)
      || chunk.chunkIndex < 0
      || chunk.chunkIndex >= upload.chunkCount
      || !chunk.ciphertextDigest
      || received.has(chunk.chunkIndex)
      || upload.chunkDigests[chunk.chunkIndex] !== chunk.ciphertextDigest
    ) {
      throw new Error("attachment resume digest mismatch");
    }
    received.set(chunk.chunkIndex, chunk.ciphertextDigest);
  }
  return received;
}

function encodedBlobLength(plaintextLength: number): number {
  const encodedCiphertextLength = Math.ceil((plaintextLength + 16) * 4 / 3);
  return JSON.stringify({
    version: 1,
    nonce: "x".repeat(32),
    ciphertext: "x".repeat(encodedCiphertextLength),
  }).length;
}

/// 上传进度回调参数。
/// - uploadedChunks：已成功上传的块数（0..chunkCount）
/// - chunkCount：总块数
/// - uploadedBytes：已上传字节数（明文偏移，便于显示）
/// - totalBytes：文件总字节数
export type UploadProgress = {
  uploadedChunks: number;
  chunkCount: number;
  uploadedBytes: number;
  totalBytes: number;
};

/// 带重试的单块上传。仅对网络错误和 5xx 重试；4xx（含 413 配额超限）不重试。
/// 重试采用指数退避：500ms → 1s → 2s。
async function uploadChunkWithRetry(
  objectId: string,
  chunkIndex: number,
  ciphertext: string,
  ciphertextDigest: string,
  session: AuthSession,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= ATTACHMENT_CHUNK_MAX_RETRIES; attempt += 1) {
    try {
      await uploadAttachmentChunk(objectId, chunkIndex, ciphertext, ciphertextDigest, session);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === ATTACHMENT_CHUNK_MAX_RETRIES) break;
      // 4xx 错误（除 429 外）不重试：配额超限、鉴权失败等不可恢复。
      const message = error instanceof Error ? error.message : "";
      const isClientError = /failed: 4\d{2}$/u.test(message) && !/failed: 429$/u.test(message);
      if (isClientError) break;
      // 指数退避：500ms × 2^attempt
      const delay = ATTACHMENT_RETRY_BASE_DELAY * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export async function encryptAndUploadAttachment(
  file: File,
  profile: SecureProfile,
  session: AuthSession,
  expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  onProgress?: (progress: UploadProgress) => void,
): Promise<AttachmentReference> {
  // 配额前置校验：避免上传到一半才发现超限。
  if (file.size <= 0) {
    throw new Error("attachment file is empty");
  }
  if (file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(`attachment exceeds quota: ${file.size} > ${MAX_ATTACHMENT_SIZE}`);
  }
  await ensureCrypto();
  const fingerprint = await fileFingerprint(file);
  const chunkCount = Math.ceil(file.size / ATTACHMENT_CHUNK_SIZE);
  let ciphertextSize = 0;
  for (let offset = 0; offset < file.size; offset += ATTACHMENT_CHUNK_SIZE) {
    ciphertextSize += encodedBlobLength(
      Math.min(ATTACHMENT_CHUNK_SIZE, file.size - offset),
    );
  }
  const trust = await loadTrustState(profile);
  let upload = trust.pendingAttachmentUploads?.[fingerprint];
  if (
    upload
    && (
      upload.version !== 1
      || upload.plaintextSize !== file.size
      || upload.chunkCount !== chunkCount
      || upload.ciphertextSize !== ciphertextSize
      || upload.expiresAt <= Math.floor(Date.now() / 1000)
    )
  ) {
    await clearPendingUpload(profile, fingerprint);
    upload = undefined;
  }
  if (!upload) {
    upload = {
      version: 1,
      fingerprint,
      objectId: crypto.randomUUID(),
      fileKey: wasm_generate_attachment_key(),
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      plaintextSize: file.size,
      lastModified: file.lastModified,
      chunkCount,
      ciphertextSize,
      expiresAt,
      chunkDigests: Array<string | null>(chunkCount).fill(null),
    };
    await savePendingUpload(profile, upload);
    await createAttachmentObject(
      { objectId: upload.objectId, chunkCount, ciphertextSize, expiresAt },
      session,
    );
  }
  const objectId = upload.objectId;
  const objectContext = toBase64Url(encoder.encode(objectId));
  let received = new Map<number, string>();
  try {
    const status = await loadAttachmentUploadStatus(objectId, session);
    received = reconcileAttachmentUpload(upload, status);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.endsWith(": 404")) throw error;
    await createAttachmentObject(
      { objectId, chunkCount, ciphertextSize, expiresAt: upload.expiresAt },
      session,
    );
  }
  const chunkPlaintextSize = (index: number) => Math.min(
    ATTACHMENT_CHUNK_SIZE,
    file.size - index * ATTACHMENT_CHUNK_SIZE,
  );
  let uploadedBytes = [...received.keys()].reduce(
    (total, index) => total + chunkPlaintextSize(index),
    0,
  );
  onProgress?.({ uploadedChunks: received.size, chunkCount, uploadedBytes, totalBytes: file.size });
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    if (received.has(chunkIndex)) continue;
    const start = chunkIndex * ATTACHMENT_CHUNK_SIZE;
    const plaintext = new Uint8Array(
      await file.slice(start, Math.min(file.size, start + ATTACHMENT_CHUNK_SIZE)).arrayBuffer(),
    );
    const ciphertext = wasm_encrypt_attachment_chunk(
      upload.fileKey,
      objectContext,
      chunkIndex,
      toBase64Url(plaintext),
    );
    const ciphertextDigest = await digest(ciphertext);
    upload.chunkDigests[chunkIndex] = ciphertextDigest;
    await savePendingUpload(profile, upload);
    await uploadChunkWithRetry(
      objectId,
      chunkIndex,
      ciphertext,
      ciphertextDigest,
      session,
    );
    uploadedBytes += plaintext.length;
    received.set(chunkIndex, ciphertextDigest);
    onProgress?.({ uploadedChunks: received.size, chunkCount, uploadedBytes, totalBytes: file.size });
  }
  await finalizeAttachment(objectId, session);
  const chunkDigests = upload.chunkDigests.map((value) => {
    if (!value) throw new Error("attachment upload digest missing");
    return value;
  });
  const reference: AttachmentReference = {
    protocolVersion: 1,
    objectId,
    chunkCount,
    chunkDigests,
    ciphertextSize,
    expiresAt,
    fileKey: upload.fileKey,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    plaintextSize: file.size,
  };
  await clearPendingUpload(profile, fingerprint);
  return reference;
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
