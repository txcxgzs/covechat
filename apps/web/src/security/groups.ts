import type {
  AuthSession,
  DirectoryResponse,
} from "@covechat/protocol";
import initCrypto, {
  wasm_mls_add_member,
  wasm_mls_create_group,
  wasm_mls_encrypt,
  wasm_mls_join_group,
  wasm_mls_process,
  wasm_mls_refresh_key_package,
  wasm_mls_remove_member,
} from "../crypto-wasm/covechat_crypto";
import {
  acknowledgeEnvelope,
  lookupDirectory,
  publishSignalPreKeys,
  readMailbox,
  sendEnvelope,
} from "./api";
import {
  saveMlsState,
  type MlsGroupMetadata,
  type PublishedPreKeyBundle,
  type SecureProfile,
} from "./vault";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let cryptoReady: Promise<unknown> | undefined;

type MlsMember = {
  leafIndex: number;
  identity: string;
};

type MlsGroupResult = {
  state: Record<string, unknown>;
  groupId: string;
  epoch: number;
  members: MlsMember[];
};

type MlsCommitResult = MlsGroupResult & {
  commit: string;
  welcome?: string;
};

type MlsMessageResult = {
  state: Record<string, unknown>;
  groupId: string;
  epoch: number;
  ciphertext: string;
};

type MlsProcessedResult = MlsGroupResult & {
  kind: "application" | "commit" | "proposal";
  plaintext?: string;
};

type MlsEnvelope = {
  protocol: "mls-rfc9420";
  kind: "welcome" | "commit" | "application";
  groupId: string;
  name?: string;
  ciphertext: string;
};

export type DecryptedGroupMessage = {
  envelopeId: string;
  groupId: string;
  senderDeviceId: string;
  body: string;
  createdAt: number;
};

function ensureCrypto() {
  cryptoReady ??= initCrypto();
  return cryptoReady;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(hex)) throw new Error("invalid group UUID");
  return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function groups(profile: SecureProfile): MlsGroupMetadata[] {
  profile.mls.groups ??= [];
  return profile.mls.groups;
}

function memberDeviceId(identity: string): string {
  const separator = identity.lastIndexOf("/");
  if (separator < 1) throw new Error("invalid MLS member identity");
  return identity.slice(separator + 1);
}

function updateMetadata(
  profile: SecureProfile,
  result: MlsGroupResult,
  name?: string,
  conversationId?: string,
): MlsGroupMetadata {
  const existing = groups(profile).find((group) => group.groupId === result.groupId);
  const metadata: MlsGroupMetadata = existing ?? {
    groupId: result.groupId,
    conversationId: conversationId ?? crypto.randomUUID(),
    name: name?.trim() || "Encrypted group",
    epoch: result.epoch,
    memberDeviceIds: [],
  };
  metadata.epoch = result.epoch;
  metadata.memberDeviceIds = result.members.map((member) => memberDeviceId(member.identity));
  if (name?.trim()) metadata.name = name.trim();
  if (conversationId) metadata.conversationId = conversationId;
  if (!existing) groups(profile).push(metadata);
  return metadata;
}

function parsePublishedBundle(
  device: DirectoryResponse["devices"][number],
): PublishedPreKeyBundle {
  const bundle = JSON.parse(device.prekeyBundle) as PublishedPreKeyBundle;
  if (
    bundle.version !== 1
    || !bundle.signal
    || typeof bundle.mlsKeyPackage !== "string"
    || !bundle.mlsKeyPackage
  ) {
    throw new Error("recipient device has no valid MLS key package");
  }
  return bundle;
}

async function deliver(
  profile: SecureProfile,
  session: AuthSession,
  metadata: MlsGroupMetadata,
  recipients: string[],
  wrapper: MlsEnvelope,
): Promise<void> {
  const now = Date.now();
  for (const [index, recipientDeviceId] of [...new Set(recipients)].entries()) {
    if (recipientDeviceId === profile.deviceId) continue;
    await sendEnvelope({
      protocolVersion: 1,
      envelopeId: crypto.randomUUID(),
      senderDeviceId: profile.deviceId,
      recipientDeviceId,
      conversationId: metadata.conversationId,
      sequence: now * 1000 + index,
      expiresAt: Math.floor(now / 1000) + 30 * 24 * 60 * 60,
      ciphertext: JSON.stringify(wrapper),
      idempotencyKey: crypto.randomUUID(),
    }, profile, session);
  }
}

export async function createEncryptedGroup(
  profile: SecureProfile,
  name: string,
): Promise<MlsGroupMetadata> {
  await ensureCrypto();
  const conversationId = crypto.randomUUID();
  const result = JSON.parse(wasm_mls_create_group(
    JSON.stringify(profile.mls.state),
    toBase64Url(uuidBytes(conversationId)),
  )) as MlsGroupResult;
  profile.mls.state = result.state;
  const metadata = updateMetadata(profile, result, name, conversationId);
  await saveMlsState(profile);
  return metadata;
}

export async function addGroupMember(
  profile: SecureProfile,
  session: AuthSession,
  groupId: string,
  username: string,
): Promise<MlsGroupMetadata> {
  await ensureCrypto();
  const metadata = groups(profile).find((group) => group.groupId === groupId);
  if (!metadata) throw new Error("group not found");
  const directory = await lookupDirectory(username.trim().toLowerCase(), session);
  const devices = directory.devices.filter((device) => !device.revokedAt);
  if (metadata.memberDeviceIds.length + devices.length > 50) {
    throw new Error("groups are limited to 50 member devices");
  }

  for (const device of devices) {
    if (metadata.memberDeviceIds.includes(device.deviceId)) continue;
    const published = parsePublishedBundle(device);
    const previousMembers = [...metadata.memberDeviceIds];
    const result = JSON.parse(wasm_mls_add_member(
      JSON.stringify(profile.mls.state),
      groupId,
      published.mlsKeyPackage,
    )) as MlsCommitResult;
    profile.mls.state = result.state;
    updateMetadata(profile, result);
    // Persist the epoch transition before any commit or Welcome leaves the device.
    await saveMlsState(profile);
    await deliver(profile, session, metadata, previousMembers, {
      protocol: "mls-rfc9420",
      kind: "commit",
      groupId,
      ciphertext: result.commit,
    });
    if (!result.welcome) throw new Error("OpenMLS did not produce a Welcome");
    await deliver(profile, session, metadata, [device.deviceId], {
      protocol: "mls-rfc9420",
      kind: "welcome",
      groupId,
      name: metadata.name,
      ciphertext: result.welcome,
    });
  }
  return metadata;
}

export async function removeGroupMember(
  profile: SecureProfile,
  session: AuthSession,
  groupId: string,
  leafIndex: number,
): Promise<MlsGroupMetadata> {
  await ensureCrypto();
  const metadata = groups(profile).find((group) => group.groupId === groupId);
  if (!metadata) throw new Error("group not found");
  const previousMembers = [...metadata.memberDeviceIds];
  const result = JSON.parse(wasm_mls_remove_member(
    JSON.stringify(profile.mls.state),
    groupId,
    leafIndex,
  )) as MlsCommitResult;
  profile.mls.state = result.state;
  updateMetadata(profile, result);
  await saveMlsState(profile);
  await deliver(profile, session, metadata, previousMembers, {
    protocol: "mls-rfc9420",
    kind: "commit",
    groupId,
    ciphertext: result.commit,
  });
  return metadata;
}

export async function sendEncryptedGroupText(
  profile: SecureProfile,
  session: AuthSession,
  groupId: string,
  body: string,
): Promise<void> {
  await ensureCrypto();
  const metadata = groups(profile).find((group) => group.groupId === groupId);
  if (!metadata) throw new Error("group not found");
  if (!body.trim()) throw new Error("message must not be empty");
  const plaintext = encoder.encode(JSON.stringify({
    version: 1,
    type: "text",
    body: body.trim(),
    createdAt: Date.now(),
  }));
  const result = JSON.parse(wasm_mls_encrypt(
    JSON.stringify(profile.mls.state),
    groupId,
    toBase64Url(plaintext),
  )) as MlsMessageResult;
  profile.mls.state = result.state;
  metadata.epoch = result.epoch;
  await saveMlsState(profile);
  await deliver(profile, session, metadata, metadata.memberDeviceIds, {
    protocol: "mls-rfc9420",
    kind: "application",
    groupId,
    ciphertext: result.ciphertext,
  });
}

export async function receiveEncryptedGroupMessages(
  profile: SecureProfile,
  session: AuthSession,
): Promise<DecryptedGroupMessage[]> {
  await ensureCrypto();
  const envelopes = await readMailbox(session);
  const messages: DecryptedGroupMessage[] = [];
  for (const envelope of envelopes) {
    try {
      const wrapper = JSON.parse(envelope.ciphertext) as MlsEnvelope;
      if (wrapper.protocol !== "mls-rfc9420") continue;
      if (wrapper.kind === "welcome") {
        const joined = JSON.parse(wasm_mls_join_group(
          JSON.stringify(profile.mls.state),
          wrapper.ciphertext,
        )) as MlsGroupResult;
        if (joined.groupId !== wrapper.groupId) throw new Error("MLS group id mismatch");
        profile.mls.state = joined.state;
        updateMetadata(profile, joined, wrapper.name, envelope.conversationId);
        const refreshed = JSON.parse(wasm_mls_refresh_key_package(
          JSON.stringify(profile.mls.state),
        )) as { state: Record<string, unknown>; keyPackage: string };
        profile.mls.state = refreshed.state;
        profile.mls.keyPackage = refreshed.keyPackage;
        await saveMlsState(profile);
        await publishSignalPreKeys(profile, session);
        await acknowledgeEnvelope(envelope.envelopeId, session);
        continue;
      }
      const processed = JSON.parse(wasm_mls_process(
        JSON.stringify(profile.mls.state),
        wrapper.groupId,
        wrapper.ciphertext,
      )) as MlsProcessedResult;
      profile.mls.state = processed.state;
      updateMetadata(profile, processed);
      await saveMlsState(profile);
      await acknowledgeEnvelope(envelope.envelopeId, session);
      if (processed.kind !== "application" || !processed.plaintext) continue;
      const payload = JSON.parse(
        decoder.decode(fromBase64Url(processed.plaintext)),
      ) as { version: number; type: string; body: string; createdAt: number };
      if (payload.version !== 1 || payload.type !== "text") {
        throw new Error("invalid MLS application payload");
      }
      messages.push({
        envelopeId: envelope.envelopeId,
        groupId: wrapper.groupId,
        senderDeviceId: envelope.senderDeviceId,
        body: payload.body,
        createdAt: payload.createdAt,
      });
    } catch {
      // Fail closed and leave unknown or out-of-order MLS messages queued.
    }
  }
  return messages;
}

export function listEncryptedGroups(profile: SecureProfile): readonly MlsGroupMetadata[] {
  return groups(profile);
}
