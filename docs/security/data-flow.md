# Data flow

## Message delivery

1. The sender resolves an authenticated device list and public prekey bundles.
   Directory reads are authenticated and rate-limited per IP (60/min) to slow
   username enumeration.
2. The crypto core validates identities and produces one opaque envelope per
   recipient device.
3. The API first runs the `require_origin` middleware: `POST`/`PUT`/`DELETE`
   requests whose `Origin` header is not in `ALLOWED_ORIGINS` are rejected
   with `403`. (Development mode with an empty allow-list passes through and
   logs a warning.)
4. The API validates version, routing fields, expiry, idempotency and
   signatures without decrypting the ciphertext.
5. The delivery service stores the opaque envelope in the device mailbox and
   emits `mailbox.changed` over WebSocket. If Redis Pub/Sub is configured the
   event is also published so other API instances can fan out to their own
   WebSocket subscribers.
6. The recipient downloads, validates and decrypts locally, advances protocol
   state, then acknowledges deletion.

## Attachments

Attachments are chunk-encrypted locally. S3 (deployment default: MinIO)
receives random object IDs, ciphertext chunks, digests, size and expiry only.
When `S3_ENDPOINT` is unset the API falls back to a PostgreSQL ciphertext-chunk
backend for development.

## Backups

Backups are encrypted locally using a recovery-derived key and uploaded using
atomic version manifests. The server enforces monotonic version numbers and a
`previousDigest` hash chain to reject rollback or stale-parent writes.

## Rate-limited endpoints

| Endpoint | Scope | Limit | Purpose |
| --- | --- | --- | --- |
| `POST /v1/onboarding` | anonymous IP | 5/hour | Block batch registration |
| `POST /v1/auth/challenges/{device_id}` | anonymous IP | 10/minute | Block login bombing |
| `POST /v1/recovery/challenges/{username}` | anonymous IP | 5/hour | Block recovery-code brute force |
| `GET /v1/directory/{username}` | authenticated | 60/minute | Slow username enumeration |

Rate limits use Redis `INCR` + `EXPIRE` keyed on the first IP in
`X-Forwarded-For`. Without `REDIS_URL` the limiter degrades to pass-through
and logs a warning.

## Background cleanup

A tokio task runs `cleanup_loop` which periodically invokes the pure function
`cleanup_once` to evict expired:

- envelopes (and their S3 attachment ciphertext, deleted outside the store lock)
- challenges and recovery challenges
- auth sessions and recovery sessions
- idempotency keys

## Telemetry

No analytics or crash-reporting SDK is included in the PWA. Logs contain random
request IDs and coarse outcomes only; message bodies, keys and recovery codes
are never logged.
