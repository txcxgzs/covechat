import { describe, expect, it } from "vitest";
import { createReplyReference, isReplyReference } from "./message-content";

describe("structured reply references", () => {
  it("creates bounded reply metadata for encrypted payloads", () => {
    const reply = createReplyReference("message-42", `  original\n${"text ".repeat(80)}`);
    expect(reply.messageId).toBe("message-42");
    expect(reply.excerpt.length).toBeLessThanOrEqual(160);
    expect(reply.excerpt).not.toContain("\n");
    expect(isReplyReference(reply)).toBe(true);
  });

  it("rejects malformed or oversized reply metadata", () => {
    expect(isReplyReference({ messageId: "", excerpt: "hello" })).toBe(false);
    expect(isReplyReference({ messageId: "ok", excerpt: "x".repeat(161) })).toBe(false);
    expect(isReplyReference({ messageId: "ok", excerpt: 1 })).toBe(false);
  });
});
