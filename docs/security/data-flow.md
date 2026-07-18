# Data flow

1. The sender resolves an authenticated device list and public prekey bundles.
2. The crypto core validates identities and produces one opaque envelope per
   recipient device.
3. The API validates version, routing fields, expiry, idempotency and signatures
   without decrypting the ciphertext.
4. The delivery service stores the opaque envelope in the device mailbox and
   emits only `mailbox.changed` over WebSocket.
5. The recipient downloads, validates and decrypts locally, advances protocol
   state, then acknowledges deletion.
6. Attachments are chunk-encrypted locally. S3 receives random object IDs,
   ciphertext chunks, digests, size and expiry only.
7. Backups are encrypted locally using a recovery-derived key and uploaded using
   atomic version manifests.

No analytics or crash-reporting SDK is included in the PWA.
