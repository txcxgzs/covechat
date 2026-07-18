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
