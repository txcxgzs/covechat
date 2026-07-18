# Threat model

## Protected assets

Message bodies, attachments, group metadata, identity private keys, ratchet/MLS
state, recovery secrets, local history and cloud backups.

## Adversaries in scope

- Passive and active network attackers.
- A compromised API, database, queue, cache or object store.
- A malicious service operator attempting to substitute identity/prekeys.
- Account takeover and replay of previously valid writes.
- Temporary compromise of session state, followed by an uncompromised ratchet.
- Malicious group members before removal and attempts to read later epochs.
- Web supply-chain attacks, XSS and stale/malicious service workers.

## Explicitly out of scope

- A device under persistent attacker control.
- Screenshots, cameras, keyloggers and malicious browser extensions.
- Global traffic-correlation or nation-state endpoint exploitation.
- Availability when the delivery service is blocked or destroyed.

## Security invariants

1. The server never receives content keys, private identity keys or recovery secrets.
2. Every content object has a versioned authenticated-encryption envelope.
3. An unknown version, invalid signature or key change fails closed.
4. Safety-number changes block sends pending explicit acknowledgement.
5. Removing a group member advances the MLS epoch before further application messages.
6. Backup versions form a client-verified hash chain to detect rollback.
7. Logs contain random request IDs and coarse outcomes only.

## Current 0.1 limitation

The local vault, recovery-key derivation, official libsignal adapter and
OpenMLS adapter are implemented behind the Rust/WASM boundary. They fail
closed and persist encrypted protocol state. The project remains experimental
until broader interoperability testing, community review and an independent
security audit are complete.
