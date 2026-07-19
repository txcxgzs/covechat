import { describe, expect, it } from "vitest";
import type { LocalHistoryItem } from "./vault";
import {
  compactConversationHistory,
  MAX_HISTORY_ITEMS_PER_CONVERSATION,
} from "./history";

describe("encrypted local history limits", () => {
  it("removes expired entries and keeps the newest bounded history", () => {
    const now = 10_000;
    const history = Array.from(
      { length: MAX_HISTORY_ITEMS_PER_CONVERSATION + 5 },
      (_, index): LocalHistoryItem => ({
        id: String(index),
        from: "me",
        body: `message-${index}`,
        createdAt: index,
        expiresAt: index === 2 ? now - 1 : undefined,
      }),
    ).reverse();
    const compacted = compactConversationHistory(history, now);
    expect(compacted).toHaveLength(MAX_HISTORY_ITEMS_PER_CONVERSATION);
    expect(compacted[0]?.id).toBe("5");
    expect(compacted.at(-1)?.id).toBe(String(MAX_HISTORY_ITEMS_PER_CONVERSATION + 4));
  });
});
