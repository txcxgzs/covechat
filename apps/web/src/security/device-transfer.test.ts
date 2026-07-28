import { describe, expect, it } from "vitest";
import { buildDeviceRecoveryUrl, parseDeviceRecoveryHash } from "./device-transfer";

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
