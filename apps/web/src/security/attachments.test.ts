import { describe, expect, it } from "vitest";
import type { AttachmentUploadStatus } from "@covechat/protocol";
import type { PendingAttachmentUpload } from "./vault";
import { reconcileAttachmentUpload } from "./attachments";

const upload: PendingAttachmentUpload = {
  version: 1,
  fingerprint: "file-fingerprint",
  objectId: "object-1",
  fileKey: "secret",
  fileName: "report.pdf",
  mimeType: "application/pdf",
  plaintextSize: 2_000_000,
  lastModified: 1,
  chunkCount: 2,
  ciphertextSize: 2_000_100,
  expiresAt: 2_000_000_000,
  chunkDigests: ["digest-0", null],
};

function status(receivedChunks: AttachmentUploadStatus["receivedChunks"]): AttachmentUploadStatus {
  return {
    protocolVersion: 1,
    objectId: upload.objectId,
    chunkCount: upload.chunkCount,
    ciphertextSize: upload.ciphertextSize,
    expiresAt: upload.expiresAt,
    finalized: false,
    receivedChunks,
  };
}

describe("attachment upload resume", () => {
  it("accepts a server chunk that matches encrypted local state", () => {
    expect([...reconcileAttachmentUpload(upload, status([
      { chunkIndex: 0, ciphertextDigest: "digest-0" },
    ])).entries()]).toEqual([[0, "digest-0"]]);
  });

  it("fails closed for a digest mismatch or invalid chunk index", () => {
    expect(() => reconcileAttachmentUpload(upload, status([
      { chunkIndex: 0, ciphertextDigest: "tampered" },
    ]))).toThrow("attachment resume digest mismatch");
    expect(() => reconcileAttachmentUpload(upload, status([
      { chunkIndex: 2, ciphertextDigest: "digest-2" },
    ]))).toThrow("attachment resume digest mismatch");
  });

  it("rejects status for another upload object", () => {
    expect(() => reconcileAttachmentUpload(upload, {
      ...status([]),
      objectId: "other-object",
    })).toThrow("attachment upload state mismatch");
  });
});
