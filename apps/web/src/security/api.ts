import type {
  AccountIdentity,
  AttachmentReference,
  AuthSession,
  DirectoryResponse,
  EncryptedBackup,
  EncryptedEnvelope,
  EncryptedAttachment,
  DeviceRecord,
} from "@covechat/protocol";
import {
  signWithAccount,
  signWithDevice,
  signRecoveryChallenge,
  type PublishedPreKeyBundle,
  type SecureProfile,
} from "./vault";

const encoder = new TextEncoder();

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export type AuthenticatedProfile = {
  profile: SecureProfile;
  session: AuthSession;
};

export type RecoverySession = {
  accessToken: string;
  expiresAt: number;
};

export type RecoveryBackup = {
  account: AccountIdentity;
  backup: EncryptedBackup;
};

function devicePayload(profile: SecureProfile, prekeyBundle: string): Uint8Array {
  return encoder.encode(JSON.stringify([
    1,
    profile.deviceId,
    profile.username,
    profile.deviceKeys.publicKey,
    profile.signalPreKeyVersion,
    prekeyBundle,
    profile.createdAt,
  ]));
}

function publishedPreKeyBundle(profile: SecureProfile): string {
  return JSON.stringify({
    version: 1,
    signal: profile.signal.preKeyBundle,
    mlsKeyPackage: profile.mls.keyPackage,
  } satisfies PublishedPreKeyBundle);
}

export async function provisionProfile(profile: SecureProfile): Promise<AuthSession> {
  const prekeyBundle = publishedPreKeyBundle(profile);
  const authorizationSignature = await signWithAccount(profile, devicePayload(profile, prekeyBundle));
  const response = await fetch("/api/v1/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account: {
        protocolVersion: 1,
        username: profile.username,
        signingPublicKey: profile.accountKeys.publicKey,
        recoveryPublicKey: profile.recoveryKeys.publicKey,
        recoveryVersion: 1,
      },
      device: {
        protocolVersion: 1,
        deviceId: profile.deviceId,
        username: profile.username,
        signingPublicKey: profile.deviceKeys.publicKey,
        prekeyVersion: profile.signalPreKeyVersion,
        prekeyBundle,
        authorizationSignature,
        createdAt: profile.createdAt,
      },
    }),
  });
  if (!response.ok) throw new Error(`onboarding failed: ${response.status}`);
  return authenticateProfile(profile);
}

export async function authenticateProfile(profile: SecureProfile): Promise<AuthSession> {
  const challengeResponse = await fetch(`/api/v1/auth/challenges/${profile.deviceId}`, { method: "POST" });
  if (!challengeResponse.ok) throw new Error(`challenge failed: ${challengeResponse.status}`);
  const challenge = await challengeResponse.json() as {
    challengeId: string;
    challenge: string;
    expiresAt: number;
  };
  const signature = await signWithDevice(profile, fromBase64Url(challenge.challenge));
  const verifyResponse = await fetch("/api/v1/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
  });
  if (!verifyResponse.ok) throw new Error(`authentication failed: ${verifyResponse.status}`);
  return verifyResponse.json() as Promise<AuthSession>;
}

export async function publishSignalPreKeys(
  profile: SecureProfile,
  session: AuthSession,
): Promise<void> {
  const prekeyVersion = profile.signalPreKeyVersion + 1;
  const prekeyBundle = publishedPreKeyBundle(profile);
  const updatedAt = Math.floor(Date.now() / 1000);
  const signature = await signWithDevice(
    profile,
    encoder.encode(JSON.stringify([
      1,
      profile.deviceId,
      prekeyVersion,
      prekeyBundle,
      updatedAt,
    ])),
  );
  const response = await fetch(`/api/v1/devices/${profile.deviceId}/prekeys`, {
    method: "PUT",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion: 1,
      prekeyVersion,
      prekeyBundle,
      updatedAt,
      signature,
    }),
  });
  if (!response.ok) throw new Error(`pre-key publish failed: ${response.status}`);
  profile.signalPreKeyVersion = prekeyVersion;
  profile.signalPublished = true;
}

function authenticatedHeaders(session: AuthSession): HeadersInit {
  return { authorization: `Bearer ${session.accessToken}` };
}

export async function lookupDirectory(
  username: string,
  session: AuthSession,
): Promise<DirectoryResponse> {
  const response = await fetch(`/api/v1/directory/${encodeURIComponent(username)}`, {
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`directory lookup failed: ${response.status}`);
  return response.json() as Promise<DirectoryResponse>;
}

export async function listOwnDevices(session: AuthSession): Promise<DeviceRecord[]> {
  const response = await fetch("/api/v1/devices", {
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`device list failed: ${response.status}`);
  return response.json() as Promise<DeviceRecord[]>;
}

export async function revokeOwnDevice(
  deviceId: string,
  session: AuthSession,
): Promise<void> {
  const response = await fetch(`/api/v1/devices/${deviceId}/revoke`, {
    method: "POST",
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`device revocation failed: ${response.status}`);
}

export async function listBlockedUsers(session: AuthSession): Promise<string[]> {
  const response = await fetch("/api/v1/blocks", {
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`block list failed: ${response.status}`);
  return response.json() as Promise<string[]>;
}

export async function setUserBlocked(
  username: string,
  blocked: boolean,
  session: AuthSession,
): Promise<void> {
  const response = await fetch(`/api/v1/blocks/${encodeURIComponent(username)}`, {
    method: blocked ? "POST" : "DELETE",
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`block update failed: ${response.status}`);
}

export async function submitAbuseReport(
  profile: SecureProfile,
  session: AuthSession,
  reportedUsername: string,
  disclosedMessageBundle: string,
  context: string,
): Promise<void> {
  const protocolVersion = 1;
  const reportId = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  const reporterSignature = await signWithDevice(
    profile,
    encoder.encode(JSON.stringify([
      protocolVersion,
      reportId,
      reportedUsername,
      disclosedMessageBundle,
      context,
      createdAt,
    ])),
  );
  const response = await fetch("/api/v1/reports", {
    method: "POST",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion,
      reportId,
      reportedUsername,
      disclosedMessageBundle,
      context,
      createdAt,
      reporterSignature,
    }),
  });
  if (!response.ok) throw new Error(`report submission failed: ${response.status}`);
}

export async function readMailbox(
  session: AuthSession,
): Promise<EncryptedEnvelope[]> {
  const response = await fetch(`/api/v1/mailboxes/${session.deviceId}`, {
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`mailbox read failed: ${response.status}`);
  return response.json() as Promise<EncryptedEnvelope[]>;
}

export async function sendEnvelope(
  envelope: Omit<EncryptedEnvelope, "signature">,
  profile: SecureProfile,
  session: AuthSession,
): Promise<void> {
  const signature = await signWithDevice(
    profile,
    encoder.encode(JSON.stringify([
      envelope.protocolVersion,
      envelope.envelopeId,
      envelope.senderDeviceId,
      envelope.recipientDeviceId,
      envelope.conversationId,
      envelope.sequence,
      envelope.expiresAt,
      envelope.ciphertext,
      envelope.idempotencyKey,
    ])),
  );
  const response = await fetch("/api/v1/envelopes", {
    method: "POST",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
      "x-idempotency-key": envelope.idempotencyKey,
    },
    body: JSON.stringify({ ...envelope, signature }),
  });
  if (!response.ok) throw new Error(`envelope send failed: ${response.status}`);
}

export async function acknowledgeEnvelope(
  envelopeId: string,
  session: AuthSession,
): Promise<void> {
  const response = await fetch(
    `/api/v1/mailboxes/${session.deviceId}/envelopes/${envelopeId}`,
    { method: "DELETE", headers: authenticatedHeaders(session) },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`envelope acknowledgement failed: ${response.status}`);
  }
}

export function subscribeMailbox(
  session: AuthSession,
  onChanged: () => void,
): () => void {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    `${scheme}//${window.location.host}/api/v1/events/${session.deviceId}`,
    ["covechat", session.accessToken],
  );
  socket.addEventListener("message", (event) => {
    if (event.data === "mailbox.changed") onChanged();
  });
  return () => socket.close(1000, "client closing");
}

export async function loadLatestBackup(
  session: AuthSession,
): Promise<EncryptedBackup | undefined> {
  const response = await fetch("/api/v1/backups/latest", {
    headers: authenticatedHeaders(session),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`backup read failed: ${response.status}`);
  return response.json() as Promise<EncryptedBackup>;
}

export async function uploadBackup(
  backup: EncryptedBackup,
  session: AuthSession,
): Promise<void> {
  const response = await fetch("/api/v1/backups", {
    method: "PUT",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify(backup),
  });
  if (!response.ok) throw new Error(`backup upload failed: ${response.status}`);
}

export async function authenticateRecovery(
  username: string,
  recoverySecret: string,
): Promise<RecoverySession> {
  const normalized = username.trim().toLowerCase();
  const challengeResponse = await fetch(
    `/api/v1/recovery/challenges/${encodeURIComponent(normalized)}`,
    { method: "POST" },
  );
  if (!challengeResponse.ok) {
    throw new Error(`recovery challenge failed: ${challengeResponse.status}`);
  }
  const challenge = await challengeResponse.json() as {
    challengeId: string;
    challenge: string;
    expiresAt: number;
  };
  const signature = await signRecoveryChallenge(
    recoverySecret,
    normalized,
    fromBase64Url(challenge.challenge),
  );
  const verifyResponse = await fetch("/api/v1/recovery/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
  });
  if (!verifyResponse.ok) {
    throw new Error(`recovery authentication failed: ${verifyResponse.status}`);
  }
  return verifyResponse.json() as Promise<RecoverySession>;
}

export async function loadBackupForRecovery(
  session: RecoverySession,
): Promise<RecoveryBackup> {
  const response = await fetch("/api/v1/recovery/backups/latest", {
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) throw new Error(`recovery backup failed: ${response.status}`);
  return response.json() as Promise<RecoveryBackup>;
}

export async function registerRecoveredDevice(
  profile: SecureProfile,
  recoverySession: RecoverySession,
): Promise<AuthSession> {
  const prekeyBundle = JSON.stringify(profile.signal.preKeyBundle);
  const authorizationSignature = await signWithAccount(
    profile,
    devicePayload(profile, prekeyBundle),
  );
  const response = await fetch("/api/v1/recovery/devices", {
    method: "POST",
    headers: {
      authorization: `Bearer ${recoverySession.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion: 1,
      deviceId: profile.deviceId,
      username: profile.username,
      signingPublicKey: profile.deviceKeys.publicKey,
      prekeyVersion: profile.signalPreKeyVersion,
      prekeyBundle,
      authorizationSignature,
      createdAt: profile.createdAt,
    }),
  });
  if (!response.ok) {
    throw new Error(`recovered device registration failed: ${response.status}`);
  }
  return authenticateProfile(profile);
}

export async function createAttachmentObject(
  input: Pick<EncryptedAttachment, "objectId" | "chunkCount" | "ciphertextSize" | "expiresAt">,
  session: AuthSession,
): Promise<void> {
  const response = await fetch("/api/v1/attachments", {
    method: "POST",
    headers: {
      ...authenticatedHeaders(session),
      "content-type": "application/json",
    },
    body: JSON.stringify({ protocolVersion: 1, ...input }),
  });
  if (!response.ok) throw new Error(`attachment create failed: ${response.status}`);
}

export async function uploadAttachmentChunk(
  objectId: string,
  chunkIndex: number,
  ciphertext: string,
  ciphertextDigest: string,
  session: AuthSession,
): Promise<void> {
  const response = await fetch(
    `/api/v1/attachments/${objectId}/chunks/${chunkIndex}`,
    {
      method: "PUT",
      headers: {
        ...authenticatedHeaders(session),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ciphertext, ciphertextDigest }),
    },
  );
  if (!response.ok) throw new Error(`attachment chunk upload failed: ${response.status}`);
}

export async function finalizeAttachment(
  objectId: string,
  session: AuthSession,
): Promise<void> {
  const response = await fetch(`/api/v1/attachments/${objectId}/finalize`, {
    method: "POST",
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`attachment finalize failed: ${response.status}`);
}

export async function loadAttachmentManifest(
  objectId: string,
  session: AuthSession,
): Promise<EncryptedAttachment> {
  const response = await fetch(`/api/v1/attachments/${objectId}`, {
    headers: authenticatedHeaders(session),
  });
  if (!response.ok) throw new Error(`attachment manifest failed: ${response.status}`);
  return response.json() as Promise<EncryptedAttachment>;
}

export async function loadAttachmentChunk(
  objectId: string,
  chunkIndex: number,
  session: AuthSession,
): Promise<{ ciphertext: string; ciphertextDigest: string }> {
  const response = await fetch(
    `/api/v1/attachments/${objectId}/chunks/${chunkIndex}`,
    { headers: authenticatedHeaders(session) },
  );
  if (!response.ok) throw new Error(`attachment chunk read failed: ${response.status}`);
  return response.json() as Promise<{ ciphertext: string; ciphertextDigest: string }>;
}

export async function deleteAttachmentObject(
  reference: AttachmentReference,
  session: AuthSession,
): Promise<void> {
  const response = await fetch(`/api/v1/attachments/${reference.objectId}`, {
    method: "DELETE",
    headers: authenticatedHeaders(session),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`attachment delete failed: ${response.status}`);
  }
}
