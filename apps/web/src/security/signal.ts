import type {
  AttachmentReference,
  AuthSession,
  DirectoryResponse,
  EncryptedEnvelope,
} from "@covechat/protocol";
import initCrypto, {
  wasm_signal_decrypt,
  wasm_signal_encrypt,
  wasm_signal_initiate_session,
  wasm_signal_refresh_pre_keys,
} from "../crypto-wasm/covechat_crypto";
import {
  acknowledgeEnvelope,
  lookupDirectory,
  publishSignalPreKeys,
  readMailbox,
  sendEnvelope,
} from "./api";
import {
  saveSignalState,
  type PublishedPreKeyBundle,
  type SecureProfile,
  type SignalPreKeyBundle,
} from "./vault";
import { observeAndCheckIdentity } from "./trust";
import { syncEncryptedBackup } from "./backup";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let cryptoReady: Promise<unknown> | undefined;

type SignalEncryptResult = {
  state: Record<string, unknown>;
  messageType: "prekey" | "signal";
  ciphertext: string;
};

type SignalDecryptResult = {
  state: Record<string, unknown>;
  plaintext: string;
};

export type DecryptedTextMessage = {
  envelopeId: string;
  senderDeviceId: string;
  senderUsername: string;
  body?: string;
  attachment?: AttachmentReference;
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
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function conversationId(first: string, second: string): Promise<string> {
  const members = [first, second].sort();
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(members.join("\0"))),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseBundle(directory: DirectoryResponse["devices"][number]): SignalPreKeyBundle {
  const parsed = JSON.parse(directory.prekeyBundle) as SignalPreKeyBundle | PublishedPreKeyBundle;
  const bundle = "signal" in parsed ? parsed.signal : parsed;
  if (
    bundle.version !== 1
    || bundle.ownerName !== directory.deviceId
    || !Number.isInteger(bundle.deviceId)
  ) {
    throw new Error("invalid remote Signal pre-key bundle");
  }
  return bundle;
}

type SignalPayload =
  | { version: 1; type: "text"; senderUsername: string; body: string; createdAt: number }
  | { version: 1; type: "attachment"; senderUsername: string; attachment: AttachmentReference; createdAt: number };

async function sendEncryptedPayload(
  profile: SecureProfile,
  session: AuthSession,
  recipientUsername: string,
  payload: SignalPayload,
): Promise<void> {
  await ensureCrypto();
  const normalized = recipientUsername.trim().toLowerCase();
  const directory = await lookupDirectory(normalized, session);
  await observeAndCheckIdentity(profile, directory);
  const activeDevices = directory.devices.filter(
    (device) => !device.revokedAt && device.prekeyBundle,
  );
  if (activeDevices.length === 0) throw new Error("recipient has no active Signal devices");
  const threadId = await conversationId(profile.username, normalized);
  const createdAt = payload.createdAt;

  for (const [index, device] of activeDevices.entries()) {
    const bundle = parseBundle(device);
    try {
      profile.signal.state = JSON.parse(
        wasm_signal_initiate_session(
          JSON.stringify(profile.signal.state),
          JSON.stringify(bundle),
          BigInt(Date.now()),
        ),
      ) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Signal session initialization failed: ${String(error)}`);
    }
    const plaintext = encoder.encode(JSON.stringify(payload));
    let encrypted: SignalEncryptResult;
    try {
      encrypted = JSON.parse(
        wasm_signal_encrypt(
          JSON.stringify(profile.signal.state),
          bundle.ownerName,
          bundle.deviceId,
          toBase64Url(plaintext),
          BigInt(Date.now()),
        ),
      ) as SignalEncryptResult;
    } catch (error) {
      throw new Error(`Signal encryption failed: ${String(error)}`);
    }
    profile.signal.state = encrypted.state;

    // Ratchet state must be durable before the ciphertext can leave the device;
    // otherwise a crash could reuse a message key.
    await saveSignalState(profile);
    const idempotencyKey = crypto.randomUUID();
    await sendEnvelope({
      protocolVersion: 1,
      envelopeId: crypto.randomUUID(),
      senderDeviceId: profile.deviceId,
      recipientDeviceId: device.deviceId,
      conversationId: threadId,
      sequence: createdAt * 1000 + index,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      ciphertext: JSON.stringify({
        protocol: "signal-pqxdh-triple-ratchet",
        messageType: encrypted.messageType,
        ciphertext: encrypted.ciphertext,
      }),
      idempotencyKey,
    }, profile, session);
  }
  void syncEncryptedBackup(profile, session).catch(() => undefined);
}

export async function sendEncryptedText(
  profile: SecureProfile,
  session: AuthSession,
  recipientUsername: string,
  body: string,
): Promise<void> {
  const normalizedBody = body.trim();
  if (!normalizedBody) throw new Error("message must not be empty");
  return sendEncryptedPayload(profile, session, recipientUsername, {
    version: 1,
    type: "text",
    senderUsername: profile.username,
    body: normalizedBody,
    createdAt: Date.now(),
  });
}

export async function sendEncryptedAttachment(
  profile: SecureProfile,
  session: AuthSession,
  recipientUsername: string,
  attachment: AttachmentReference,
): Promise<void> {
  if (
    attachment.protocolVersion !== 1
    || !attachment.objectId
    || !attachment.fileKey
    || attachment.chunkCount < 1
    || attachment.plaintextSize < 1
  ) {
    throw new Error("invalid attachment reference");
  }
  return sendEncryptedPayload(profile, session, recipientUsername, {
    version: 1,
    type: "attachment",
    senderUsername: profile.username,
    attachment,
    createdAt: Date.now(),
  });
}

export async function receiveEncryptedTexts(
  profile: SecureProfile,
  session: AuthSession,
): Promise<DecryptedTextMessage[]> {
  await ensureCrypto();
  const envelopes = await readMailbox(session);
  const messages: DecryptedTextMessage[] = [];
  for (const envelope of envelopes) {
    let wrapper: {
      protocol: string;
      messageType: string;
      ciphertext: string;
    };
    try {
      wrapper = JSON.parse(envelope.ciphertext) as typeof wrapper;
      if (wrapper.protocol !== "signal-pqxdh-triple-ratchet") continue;
      const decrypted = JSON.parse(
        wasm_signal_decrypt(
          JSON.stringify(profile.signal.state),
          envelope.senderDeviceId,
          1,
          wrapper.messageType,
          wrapper.ciphertext,
        ),
      ) as SignalDecryptResult;
      const payload = JSON.parse(
        decoder.decode(fromBase64Url(decrypted.plaintext)),
      ) as SignalPayload;
      if (
        payload.version !== 1
        || !Number.isFinite(payload.createdAt)
        || !/^[a-z0-9_]{3,32}$/u.test(payload.senderUsername)
        || (
          payload.type === "text"
            ? typeof payload.body !== "string"
            : payload.type === "attachment"
              ? payload.attachment?.protocolVersion !== 1
                || !payload.attachment.objectId
                || !payload.attachment.fileKey
              : true
        )
      ) {
        throw new Error("invalid encrypted message payload");
      }
      profile.signal.state = decrypted.state;
      if (wrapper.messageType === "prekey") {
        profile.signal = JSON.parse(wasm_signal_refresh_pre_keys(
          JSON.stringify(profile.signal.state),
          BigInt(Date.now()),
        )) as typeof profile.signal;
      }
      await saveSignalState(profile);
      if (wrapper.messageType === "prekey") {
        await publishSignalPreKeys(profile, session);
      }
      void syncEncryptedBackup(profile, session).catch(() => undefined);
      await acknowledgeEnvelope(envelope.envelopeId, session);
      messages.push({
        envelopeId: envelope.envelopeId,
        senderDeviceId: envelope.senderDeviceId,
        senderUsername: payload.senderUsername,
        body: payload.type === "text" ? payload.body : undefined,
        attachment: payload.type === "attachment" ? payload.attachment : undefined,
        createdAt: payload.createdAt,
      });
    } catch {
      // Fail closed: keep the envelope queued for a future compatible client.
    }
  }
  return messages;
}

export function subscribeEncryptedMailbox(
  session: AuthSession,
  refresh: () => void,
): () => void {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    `${scheme}//${window.location.host}/api/v1/events/${session.deviceId}`,
    ["covechat", session.accessToken],
  );
  socket.addEventListener("message", (event) => {
    if (event.data === "mailbox.changed") refresh();
  });
  return () => socket.close(1000, "client closing");
}
