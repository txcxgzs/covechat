import { beforeEach, describe, expect, it, vi } from "vitest";

const vaultMocks = vi.hoisted(() => ({
  loadTrustState: vi.fn(),
  saveTrustState: vi.fn(),
}));

vi.mock("./vault", () => vaultMocks);

import { listConversationHistories, markConversationRead, removeConversationHistoryItems } from "./history";

describe("local history mutations", () => {
  beforeEach(() => {
    vaultMocks.loadTrustState.mockReset();
    vaultMocks.saveTrustState.mockReset();
  });

  it("deletes only the selected local message ids", async () => {
    const state = {
      history: {
        maya: [
          { id: "one", from: "me", body: "keep", createdAt: 1 },
          { id: "two", from: "them", body: "remove", createdAt: 2 },
          { id: "three", from: "me", body: "keep", createdAt: 3 },
        ],
      },
    };
    vaultMocks.loadTrustState.mockResolvedValue(state);

    await removeConversationHistoryItems({} as never, "Maya", ["two"]);

    expect(state.history.maya.map((item) => item.id)).toEqual(["one", "three"]);
    expect(vaultMocks.saveTrustState).toHaveBeenCalledOnce();
  });

  it("counts only unread incoming active messages", async () => {
    vaultMocks.loadTrustState.mockResolvedValue({
      history: {
        alice: [
          { id: "read", from: "them", body: "old", createdAt: 10 },
          { id: "sent", from: "me", body: "mine", createdAt: 30 },
          { id: "unread", from: "them", body: "new", createdAt: 40 },
          { id: "expired", from: "them", body: "gone", createdAt: 50, expiresAt: 1 },
        ],
      },
      conversationReadAt: { alice: 20 },
    });

    const conversations = await listConversationHistories({} as never);

    expect(conversations).toEqual([{ username: "alice", latest: expect.objectContaining({ id: "unread" }), unread: 1 }]);
  });

  it("persists a monotonic read cursor", async () => {
    const state = { conversationReadAt: { alice: 20 } };
    vaultMocks.loadTrustState.mockResolvedValue(state);

    await markConversationRead({} as never, "Alice", 40);
    await markConversationRead({} as never, "Alice", 30);

    expect(state.conversationReadAt.alice).toBe(40);
    expect(vaultMocks.saveTrustState).toHaveBeenCalledOnce();
  });
});
