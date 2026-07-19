import { beforeEach, describe, expect, it, vi } from "vitest";

const vaultMocks = vi.hoisted(() => ({
  loadTrustState: vi.fn(),
  saveTrustState: vi.fn(),
}));

vi.mock("./vault", () => vaultMocks);

import { removeConversationHistoryItems } from "./history";

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
});
