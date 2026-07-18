# Architecture

The repository is intentionally split by trust boundary:

- `crypto-core` owns secret material and cryptographic transformations.
- `web` owns presentation, local encrypted persistence and user consent.
- `api` owns public identity records and opaque routing only.
- `protocol` owns serialized public wire shapes and versioning.

PostgreSQL is the durable source for identity/routing records, encrypted mailbox
state, backup version chains, attachment state, idempotency keys and monotonic
anti-replay counters. On startup the API runs embedded migrations and hydrates
the bounded delivery cache. Without `DATABASE_URL` it deliberately starts in an
ephemeral development mode and logs that state. Redis remains reserved for
short-lived notifications; S3-compatible object storage will replace the
current PostgreSQL ciphertext-chunk backend.
