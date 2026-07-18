# Protocol state machines

## One-to-one session

`uninitialized -> prekey-fetched -> identity-pending -> verified -> active`

- A changed identity moves any state to `identity-pending`.
- Invalid signatures, unsupported versions and corrupt ratchet state move to
  `blocked`; they never move to a plaintext state.
- An acknowledged identity change starts a fresh PQXDH session and retains a
  local security event.

## MLS group

`invited -> joining -> epoch-active -> commit-pending -> epoch-active`

- Only application messages for the locally committed epoch are delivered.
- Add/remove/device-revoke operations are ordered commits.
- A fork enters `recovery-required`; application sending is paused.
- Maximum unique member accounts is 50; every device is a distinct MLS leaf.

## Backup

`local-dirty -> encrypting -> uploaded-uncommitted -> committed`

- A manifest contains version, previous digest and ciphertext digest.
- Restore rejects a version older than the newest locally witnessed version
  unless the user enters an explicit disaster-recovery flow.
