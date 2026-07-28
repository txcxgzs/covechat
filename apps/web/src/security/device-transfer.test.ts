import { describe, expect, it } from "vitest";
import {
  buildDeviceApprovalUrl,
  buildDeviceRecoveryUrl,
  createDeviceLinkKeyPair,
  decryptDeviceLinkPayload,
  encryptDeviceLinkPayload,
  parseDeviceApprovalHash,
  parseDeviceRecoveryHash,
} from "./device-transfer";

describe("device recovery QR payload", () => {
  it("round trips only through the URL fragment", () => {
    const url = new URL(buildDeviceRecoveryUrl(
      "https://chat.example.com",
      "Alice_01",
      "recovery-secret-that-is-long-enough",
    ));
    expect(url.origin).toBe("https://chat.example.com");
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(url.hash).not.toContain("recovery-secret");
    expect(parseDeviceRecoveryHash(url.hash)).toEqual({
      version: 1,
      username: "alice_01",
      recoverySecret: "recovery-secret-that-is-long-enough",
    });
  });

  it("rejects malformed and unrelated fragments", () => {
    expect(parseDeviceRecoveryHash("#settings")).toBeUndefined();
    expect(parseDeviceRecoveryHash("#recover=not!base64")).toBeUndefined();
    expect(parseDeviceRecoveryHash("#recover=e30")).toBeUndefined();
  });
});

describe("one-time device link", () => {
  it("round trips an approval QR without exposing its fields", () => {
    const approval = {
      version: 1 as const,
      linkId: "5dd76367-a137-4f81-a150-1d604a9d52fe",
      linkSecret: "secret-value-that-is-at-least-32-bytes",
      requesterPublicKey: JSON.stringify({ kty: "EC", crv: "P-256", x: "x", y: "y" }),
    };
    const url = new URL(buildDeviceApprovalUrl("https://chat.example.com", approval));
    expect(url.search).toBe("");
    expect(url.hash).not.toContain(approval.linkSecret);
    expect(parseDeviceApprovalHash(url.hash)).toEqual(approval);
  });

  it("encrypts recovery details so only the requester key can decrypt them", async () => {
    const requester = await createDeviceLinkKeyPair();
    const other = await createDeviceLinkKeyPair();
    const linkId = "5dd76367-a137-4f81-a150-1d604a9d52fe";
    const payload = {
      version: 1 as const,
      username: "alice_01",
      recoverySecret: "recovery-secret-that-is-long-enough",
    };
    const encrypted = await encryptDeviceLinkPayload(requester.publicKey, linkId, payload);
    expect(encrypted.encryptedPayload).not.toContain(payload.recoverySecret);
    await expect(decryptDeviceLinkPayload(
      requester.privateKey,
      encrypted.approverPublicKey,
      linkId,
      encrypted.encryptedPayload,
    )).resolves.toEqual(payload);
    await expect(decryptDeviceLinkPayload(
      other.privateKey,
      encrypted.approverPublicKey,
      linkId,
      encrypted.encryptedPayload,
    )).rejects.toThrow();
  });
});
