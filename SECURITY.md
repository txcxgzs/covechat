# Security policy

## Experimental status

No CoveChat release is currently suitable for high-risk communications. The
project has not completed an independent cryptographic or application security
audit.

## Reporting a vulnerability

Do not open a public issue containing exploit details or user data. Until a
private reporting mailbox is published, prepare a minimal reproduction and
contact a project maintainer privately.

## Non-negotiable rules

- Never invent cryptographic protocols or silently downgrade a protocol.
- Never log plaintext, keys, recovery secrets, safety numbers or envelope bodies.
- Unknown protocol versions and invalid signatures are rejected.
- Server-side loss of availability must not become loss of confidentiality.
- A key change pauses sending until the user acknowledges it.

## Production deployment requirements

- A public origin must be configured either with **`ALLOWED_ORIGINS`** or the
  token-protected first-run browser wizard. Until then, application endpoints
  remain locked while setup and health checks stay available.
  An empty value means development mode: the `require_origin` middleware and
  the WebSocket `Origin` check pass through all requests and the API logs a
  warning. Running production with an empty allow-list disables the CSRF
  defence in depth.
- **`REDIS_URL` must be set** for distributed rate limiting and cross-instance
  mailbox events. Without Redis the rate limiter degrades to pass-through
  (abuse endpoints are unguarded) and mailbox events are process-local only
  (multi-instance WebSocket fan-out does not work).
- **`DATABASE_URL` must be set** for durable persistence. Without it the API
  starts in ephemeral development mode and loses all state on restart.
- **`S3_ENDPOINT` should be set** (deployment default: MinIO) so attachment
  ciphertext is stored in object storage rather than the PostgreSQL fallback.
- **Do not expose** PostgreSQL, Redis, MinIO or the API port directly to the
  public internet. Only the web container (port 8088) should be exposed, and
  only through a reverse proxy providing TLS.
- **Reverse proxy must forward WebSocket** (`Upgrade` / `Connection` headers)
  and preserve `X-Forwarded-For` so IP-based rate limiting works.

The `deploy/verify.sh` script checks these requirements post-deployment; run it
with `--public-url https://your.domain` before accepting production traffic.
