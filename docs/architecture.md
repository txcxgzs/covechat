# Architecture

The repository is intentionally split by trust boundary:

- `crypto-core` owns secret material and cryptographic transformations.
- `web` owns presentation, local encrypted persistence and user consent.
- `api` owns public identity records and opaque routing only.
- `protocol` owns serialized public wire shapes and versioning.

## Durable storage

PostgreSQL is the durable source for identity/routing records, encrypted mailbox
state, backup version chains, attachment state, idempotency keys and monotonic
anti-replay counters. On startup the API runs embedded migrations and hydrates
the bounded delivery cache. Without `DATABASE_URL` it deliberately starts in an
ephemeral development mode and logs that state.

## Redis

Redis serves two production roles:

1. **Distributed rate limiting** — IP-scoped counters (`INCR` + `EXPIRE`) guard
   `onboarding`, `auth/challenges`, `recovery/challenges` and `directory` reads
   against batch registration, login bombing, recovery-code brute force and
   username enumeration. When `REDIS_URL` is unset the API degrades to
   pass-through (development mode) and logs a warning.
2. **Cross-instance mailbox events** — `EventBus` publishes `mailbox.changed`
   over a Redis Pub/Sub channel so any API instance can fan a delivery out to
   its locally connected WebSocket subscribers. Without Redis, events are
   process-local only.

## Object storage

S3-compatible object storage (deployment default: MinIO) holds attachment
ciphertext chunks. When `S3_ENDPOINT` is unset the API falls back to a
PostgreSQL ciphertext-chunk backend for development.

## Background cleanup

A tokio task runs `cleanup_loop` which periodically invokes the pure function
`cleanup_once` to evict expired envelopes, attachments, idempotency keys,
challenges, recovery challenges, auth sessions and recovery sessions. S3 object
deletion happens outside the store lock to avoid holding it during slow I/O.

## Request defences

- **Origin enforcement** — the `require_origin` middleware rejects `POST`,
  `PUT`, `DELETE` requests whose `Origin` header is not in the `ALLOWED_ORIGINS`
  allow-list (CSRF defence in depth; the app uses Bearer tokens, not cookies,
  so CSRF risk is already low, but Origin checks still block cross-site
  writes). An empty allow-list means development mode (all origins pass) and
  logs a warning. WebSocket upgrade requests are `GET` and bypass the
  middleware, so the `events` handler validates `Origin` manually.
- **Anonymous rate limiting** — `anonymous_rate_limit` derives a subject from
  the first IP in `X-Forwarded-For` (falling back to `anonymous`) and checks a
  Redis counter before letting the handler run.
- **Authenticated rate limiting** — `authenticated_rate_limit` applies the same
  mechanism with a distinct scope (e.g. directory reads) for authenticated
  callers.
- **Body size limits** — `RequestBodyLimitLayer` caps envelope and backup
  request bodies.

## Limitations

The project remains `0.1-experimental` until broader interoperability testing,
community review and an independent security audit are complete. See
`SECURITY.md` and `docs/security/threat-model.md`.
