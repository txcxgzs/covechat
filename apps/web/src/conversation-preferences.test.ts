import { beforeEach, describe, expect, it } from "vitest";
import { isConversationMuted, setConversationMuted } from "./conversation-preferences";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  },
  configurable: true,
});

describe("conversation preferences", () => {
  beforeEach(() => memory.clear());

  it("persists mute independently per account and conversation", () => {
    setConversationMuted("Alice", "Bob", true);
    expect(isConversationMuted("alice", "bob")).toBe(true);
    expect(isConversationMuted("alice", "carol")).toBe(false);
    expect(isConversationMuted("other", "bob")).toBe(false);
    setConversationMuted("alice", "bob", false);
    expect(isConversationMuted("alice", "bob")).toBe(false);
  });

  it("fails closed to default preferences for malformed storage", () => {
    memory.set("covechat:conversation-preferences:v1:alice", "not-json");
    expect(isConversationMuted("alice", "bob")).toBe(false);
  });
});
