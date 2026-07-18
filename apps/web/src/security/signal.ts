import type {
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

export async function sendEncryptedText(
  profile: SecureProfile,
  session: AuthSession,
  recipientUsername: string,
  body: string,
): Promise<void> {
  await ensureCrypto();
  const normalized = recipientUsername.trim().toLowerCase();
  if (!body.trim()) throw new Error("message must not be empty");
  const directory = await lookupDirectory(normalized, session);
  const activeDevices = directory.devices.filter(
    (device) => !device.revokedAt && device.prekeyBundle,
  );
  if (activeDevices.length === 0) throw new Error("recipient has no active Signal devices");
  const threadId = await conversationId(profile.username, normalized);
  const createdAt = Date.now();

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
    const plaintext = encoder.encode(JSON.stringify({
      version: 1,
      type: "text",
      body: body.trim(),
      createdAt,
    }));
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
      ) as { version: number; type: string; body: string; createdAt: number };
      if (payload.version !== 1 || payload.type !== "text" || typeof payload.body !== "string") {
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
      await acknowledgeEnvelope(envelope.envelopeId, session);
      messages.push({
        envelopeId: envelope.envelopeId,
        senderDeviceId: envelope.senderDeviceId,
        body: payload.body,
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
