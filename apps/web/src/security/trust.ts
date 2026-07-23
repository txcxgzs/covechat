import type { DirectoryResponse } from "@covechat/protocol";
import {
  loadTrustState,
  saveTrustState,
  verifySignature,
  type PublishedPreKeyBundle,
  type SecureProfile,
  type SignalPreKeyBundle,
} from "./vault";

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function signalBundle(value: string): SignalPreKeyBundle {
  const parsed = JSON.parse(value) as SignalPreKeyBundle | PublishedPreKeyBundle;
  return "signal" in parsed ? parsed.signal : parsed;
}

async function fingerprint(values: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(values.join("\0")),
  );
  return toBase64Url(new Uint8Array(digest));
}

async function directoryFingerprints(
  directory: DirectoryResponse,
): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(
    directory.devices
      .filter((device) => !device.revokedAt && device.prekeyBundle)
      .map(async (device) => [
        device.deviceId,
        await fingerprint([
          directory.account.username,
          directory.account.signingPublicKey,
          device.deviceId,
          device.signingPublicKey,
          signalBundle(device.prekeyBundle).identityKey,
        ]),
      ]),
  ));
}

export async function safetyNumber(
  profile: SecureProfile,
  directory: DirectoryResponse,
): Promise<string> {
  const remote = await directoryFingerprints(directory);
  const material = [
    profile.username,
    profile.accountKeys.publicKey,
    profile.deviceId,
    directory.account.username,
    directory.account.signingPublicKey,
    ...Object.entries(remote).sort(([a], [b]) => a.localeCompare(b)).flat(),
  ];
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(material.join("\0"))));
  const digits = Array.from(digest.slice(0, 15), (byte) => byte.toString().padStart(3, "0")).join("");
  return digits.match(/.{1,5}/gu)?.join(" ") ?? digits;
}

export async function observeAndCheckIdentity(
  profile: SecureProfile,
  directory: DirectoryResponse,
): Promise<void> {
  const state = await loadTrustState(profile);
  for (const device of directory.devices) {
    if (device.revokedAt) continue;
    const payload = encoder.encode(JSON.stringify([
      device.protocolVersion,
      device.deviceId,
      device.username,
      device.signingPublicKey,
      device.prekeyVersion,
      device.prekeyBundle,
      device.createdAt,
    ]));
    const valid = await verifySignature(directory.account.signingPublicKey, payload, device.authorizationSignature);
    if (!valid) {
      // 明确指出是哪个用户的设备签名损坏，帮助定位是自设备还是对端设备。
      // 自设备损坏：本机解锁时 selfHealDeviceSignature 会自动修复；
      // 对端设备损坏：需要对方升级前端 + 服务端后解锁一次触发自愈。
      throw new Error(
        `SECURITY: invalid authorization signature for device ${device.deviceId}`
          + ` (user ${directory.account.username});`
          + " if this is your device, unlock to self-heal;"
          + " if this is a peer's device, they must upgrade and unlock to repair",
      );
    }
  }
  const currentDevices = await directoryFingerprints(directory);
  const previous = state.identities[directory.account.username];
  if (previous) {
    if (previous.accountSigningKey !== directory.account.signingPublicKey) {
      throw new Error("SECURITY: account identity key changed; sending is blocked");
    }
    for (const [deviceId, previousFingerprint] of Object.entries(previous.deviceFingerprints)) {
      const currentFingerprint = currentDevices[deviceId];
      if (currentFingerprint && currentFingerprint !== previousFingerprint) {
        throw new Error("SECURITY: device identity key changed; sending is blocked");
      }
    }
  }
  state.identities[directory.account.username] = {
    accountSigningKey: directory.account.signingPublicKey,
    deviceFingerprints: { ...previous?.deviceFingerprints, ...currentDevices },
    verifiedFingerprint: previous?.verifiedFingerprint,
    verifiedAt: previous?.verifiedAt,
  };
  await saveTrustState(profile, state);
}

export async function markIdentityVerified(
  profile: SecureProfile,
  directory: DirectoryResponse,
): Promise<void> {
  await observeAndCheckIdentity(profile, directory);
  const state = await loadTrustState(profile);
  const record = state.identities[directory.account.username];
  record.verifiedFingerprint = await safetyNumber(profile, directory);
  record.verifiedAt = Date.now();
  await saveTrustState(profile, state);
}

export async function identityVerification(
  profile: SecureProfile,
  directory: DirectoryResponse,
): Promise<{ safetyNumber: string; verified: boolean }> {
  await observeAndCheckIdentity(profile, directory);
  const number = await safetyNumber(profile, directory);
  const record = (await loadTrustState(profile)).identities[directory.account.username];
  return { safetyNumber: number, verified: record.verifiedFingerprint === number };
}
