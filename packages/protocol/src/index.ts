export const PROTOCOL_VERSION = 1 as const;

export type AccountIdentity = {
  protocolVersion: typeof PROTOCOL_VERSION;
  username: string;
  signingPublicKey: string;
  recoveryPublicKey: string;
  recoveryVersion: number;
};

export type DeviceRecord = {
  protocolVersion: typeof PROTOCOL_VERSION;
  deviceId: string;
  username: string;
  signingPublicKey: string;
  prekeyVersion: number;
  prekeyBundle: string;
  authorizationSignature: string;
  createdAt: number;
  revokedAt?: number | null;
};

export type DirectoryResponse = {
  account: AccountIdentity;
  devices: DeviceRecord[];
};

export type AuthSession = {
  accessToken: string;
  deviceId: string;
  expiresAt: number;
};

export type EncryptedEnvelope = {
  protocolVersion: typeof PROTOCOL_VERSION;
  envelopeId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  conversationId: string;
  sequence: number;
  expiresAt: number;
  ciphertext: string;
  signature: string;
  idempotencyKey: string;
};

export type GroupEpoch = {
  protocolVersion: typeof PROTOCOL_VERSION;
  groupId: string;
  epoch: number;
  encryptedCommit: string;
  memberDeviceIds: string[];
};

export type EncryptedAttachment = {
  protocolVersion: typeof PROTOCOL_VERSION;
  objectId: string;
  chunkCount: number;
  chunkDigests: string[];
  ciphertextSize: number;
  expiresAt: number;
};

export type AttachmentReference = EncryptedAttachment & {
  fileKey: string;
  fileName: string;
  mimeType: string;
  plaintextSize: number;
};

export type EncryptedBackup = {
  protocolVersion: typeof PROTOCOL_VERSION;
  version: number;
  previousDigest?: string;
  ciphertext: string;
  ciphertextDigest: string;
  createdAt: number;
};

export type AbuseReport = {
  protocolVersion: typeof PROTOCOL_VERSION;
  reportId: string;
  reporterSignature: string;
  disclosedMessageBundle: string;
  context: string;
  status: "received" | "reviewing" | "closed";
};
