import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptContactRequest, listContactRequests, listContacts, removeContact, removeContactRequest, sendContactRequest } from "./api";

const session = { accessToken: "session-token", deviceId: "00000000-0000-0000-0000-000000000001", expiresAt: 9999999999 };

afterEach(() => vi.unstubAllGlobals());

describe("contact API", () => {
  it("loads contacts and request queues with bearer authentication", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ username: "alice", createdAt: 1 }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ incoming: [], outgoing: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listContacts(session)).resolves.toEqual([{ username: "alice", createdAt: 1 }]);
    await expect(listContactRequests(session)).resolves.toEqual({ incoming: [], outgoing: [] });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/contacts", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer session-token" }) }));
  });

  it("uses explicit endpoints for the complete request lifecycle", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" }), { status: 200 }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendContactRequest("alice_01", session)).resolves.toEqual({ status: "pending" });
    await acceptContactRequest("alice_01", session);
    await removeContactRequest("alice_01", session);
    await removeContact("alice_01", session);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ["/api/v1/contact-requests/alice_01", "POST"],
      ["/api/v1/contact-requests/alice_01/accept", "POST"],
      ["/api/v1/contact-requests/alice_01", "DELETE"],
      ["/api/v1/contacts/alice_01", "DELETE"],
    ]);
  });
});
