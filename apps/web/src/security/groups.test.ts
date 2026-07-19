import { describe, expect, it } from "vitest";
import type { SecureProfile } from "./vault";
import { doesMlsSenderMatchEnvelope, isAuthorizedGroupCommit } from "./groups";

function profileWithAdmins(adminDeviceIds: string[]): SecureProfile {
  return {
    deviceId: "device-local",
    mls: {
      groups: [{
        groupId: "group-1",
        conversationId: "conversation-1",
        name: "Test group",
        epoch: 1,
        memberDeviceIds: ["device-local", "device-admin", "device-member"],
        adminDeviceIds,
        invitePolicy: "admins",
        memberLeafIndices: {},
      }],
    },
  } as SecureProfile;
}

describe("MLS membership commit authorization", () => {
  it("accepts a known admin device", () => {
    expect(isAuthorizedGroupCommit(profileWithAdmins(["device-admin"]), "group-1", "device-admin")).toBe(true);
  });

  it("rejects members, unknown groups, and legacy groups without an admin", () => {
    expect(isAuthorizedGroupCommit(profileWithAdmins(["device-admin"]), "group-1", "device-member")).toBe(false);
    expect(isAuthorizedGroupCommit(profileWithAdmins(["device-admin"]), "missing", "device-admin")).toBe(false);
    expect(isAuthorizedGroupCommit(profileWithAdmins([]), "group-1", "device-local")).toBe(false);
  });
});

describe("MLS sender binding", () => {
  it("binds the MLS credential identity to the authenticated envelope device", () => {
    expect(doesMlsSenderMatchEnvelope("alice/device-1", "device-1")).toBe(true);
    expect(doesMlsSenderMatchEnvelope("alice/device-1", "device-2")).toBe(false);
    expect(doesMlsSenderMatchEnvelope("invalid", "device-1")).toBe(false);
  });
});
