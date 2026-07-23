import { describe, expect, it } from "vitest";
import type { SecureProfile } from "./vault";
import {
  doesMlsSenderMatchEnvelope,
  groupMemberUsername,
  groupLeaveRequestRecipient,
  isAuthorizedGroupCommit,
  isAuthorizedGroupPolicy,
} from "./groups";

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

describe("group member presentation", () => {
  it("uses the username derived from authenticated MLS membership", () => {
    const metadata = profileWithAdmins(["device-admin"]).mls.groups?.[0];
    if (!metadata) throw new Error("test group missing");
    metadata.memberUsernames = { "device-admin": "alice" };
    expect(groupMemberUsername(metadata, "device-admin")).toBe("alice");
    expect(groupMemberUsername(metadata, "device-member")).toBeUndefined();
  });
});

describe("encrypted group leave routing", () => {
  it("routes a member leave request only to the current admin", () => {
    expect(groupLeaveRequestRecipient(
      profileWithAdmins(["device-admin"]),
      "group-1",
    )).toBe("device-admin");
  });

  it("requires an admin transfer before the current admin leaves", () => {
    const profile = profileWithAdmins(["device-local"]);
    expect(() => groupLeaveRequestRecipient(profile, "group-1"))
      .toThrow("transfer administration");
  });
});

describe("encrypted group policy", () => {
  it("accepts a monotonic admin transfer authored by the current admin", () => {
    const profile = profileWithAdmins(["device-admin"]);
    const metadata = profile.mls.groups?.[0];
    if (!metadata) throw new Error("test group missing");
    metadata.policyRevision = 3;
    expect(isAuthorizedGroupPolicy(metadata, "device-admin", {
      version: 1,
      type: "group-policy",
      revision: 4,
      adminDeviceIds: ["device-member"],
      invitePolicy: "admins",
      createdAt: 1,
    })).toBe(true);
  });

  it("rejects rollback, a non-admin author, and a non-member replacement", () => {
    const profile = profileWithAdmins(["device-admin"]);
    const metadata = profile.mls.groups?.[0];
    if (!metadata) throw new Error("test group missing");
    metadata.policyRevision = 3;
    const policy = {
      version: 1 as const,
      type: "group-policy" as const,
      revision: 4,
      adminDeviceIds: ["device-member"],
      invitePolicy: "admins" as const,
      createdAt: 1,
    };
    expect(isAuthorizedGroupPolicy(metadata, "device-member", policy)).toBe(false);
    expect(isAuthorizedGroupPolicy(metadata, "device-admin", { ...policy, revision: 3 })).toBe(false);
    expect(isAuthorizedGroupPolicy(metadata, "device-admin", {
      ...policy,
      adminDeviceIds: ["unknown-device"],
    })).toBe(false);
  });
});
