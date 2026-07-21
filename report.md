# Security Review: covechat

## Scope

Repository-wide standard scan of 64 deterministic source-like files at an immutable Git revision. All 64 received full-file review receipts. Validation used bounded source/control/sink analysis; destructive resource-exhaustion PoCs were not run.

- Scan mode: repository
- Target kind: git_revision
- Target ID: target_sha256_aa4f7e75a69863ed59a82aee7cfbe5a05d1713a681f3b4afc3cf140278387f6c
- Revision: d3c4df69cdf754613e658e62535f2e25e5feb685
- Inventory strategy: repository
- Included paths: .
- Excluded paths: none
- Runtime or test status: not recorded

### Scan Summary

| Field | Value |
| --- | --- |
| Reportable findings | 8 |
| Severity mix | high: 3, medium: 3, low: 2 |
| Confidence mix | high: 8 |
| Coverage | complete |
| Validation mode | not recorded |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

CoveChat is experimental E2EE software. Assets include account/device identity keys, future message confidentiality, conversation attribution, encrypted backup freshness, and shared service availability. In-scope attackers include malicious users and a compromised service/database; fully compromised endpoints, extensions, screenshots, and keyloggers are excluded.

### Assets

- account and device identity
- message and attachment confidentiality
- conversation integrity
- backup freshness
- shared service availability

### Trust Boundaries

- browser to API/directory
- authenticated device to shared service
- cryptographic core to UI routing
- service to PostgreSQL/S3/Redis

### Attacker Capabilities

- registered malicious account/device
- malicious group member
- compromised API/database/object metadata

### Security Objectives

- server compromise must not add decryption devices silently
- authenticated identities must bind to UI routing
- storage admission must be bounded
- backup rollback must be detectable

### Assumptions

- client endpoint and browser runtime are not fully compromised

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [Pre-finalization attachment uploads can consume gigabytes per object](#finding-1) | high | high | [Open report](findings/attachment-prefinalize-quota-bypass/attachment-prefinalize-quota-bypass.md) |
| [One account can register unbounded large device records](#finding-2) | high | high | [Open report](findings/unbounded-device-registration/unbounded-device-registration.md) |
| [Mailbox messages have no cumulative quota or maximum retention](#finding-3) | high | high | [Open report](findings/mailbox-unbounded-retention/mailbox-unbounded-retention.md) |
| [A malicious directory can silently add a message-decryption device](#finding-4) | medium | high | [Open report](findings/directory-device-injection/directory-device-injection.md) |
| [Group messages are rendered without filtering by group ID](#finding-5) | medium | high | [Open report](findings/group-message-context-mixup/group-message-context-mixup.md) |
| [Authenticated messages can be filed under a forged username](#finding-6) | medium | high | [Open report](findings/sender-username-misbinding/sender-username-misbinding.md) |
| [Recovery accepts an old authentic backup without a freshness anchor](#finding-7) | low | high | [Open report](findings/encrypted-backup-rollback/encrypted-backup-rollback.md) |
| [Abuse reports can combine one conversation’s plaintext with another user](#finding-8) | low | high | [Open report](findings/abuse-report-context-misbinding/abuse-report-context-misbinding.md) |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] Pre-finalization attachment uploads can consume gigabytes per object

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Static source trace proves an authenticated device can upload 1,024 chunks of 8 MiB before the declared 100 MiB total is enforced. |
| Category | resource-exhaustion |
| CWE | CWE-400 |
| Affected lines | services/api/src/main.rs:1244-1330 |

#### Summary

See the [detailed technical write-up](findings/attachment-prefinalize-quota-bypass/attachment-prefinalize-quota-bypass.md).

#### Validation

See the [detailed technical write-up](findings/attachment-prefinalize-quota-bypass/attachment-prefinalize-quota-bypass.md).

#### Dataflow

See the [detailed technical write-up](findings/attachment-prefinalize-quota-bypass/attachment-prefinalize-quota-bypass.md).

#### Reachability

See the [detailed technical write-up](findings/attachment-prefinalize-quota-bypass/attachment-prefinalize-quota-bypass.md).

#### Severity

See the [detailed technical write-up](findings/attachment-prefinalize-quota-bypass/attachment-prefinalize-quota-bypass.md).

#### Remediation

See the [detailed technical write-up](findings/attachment-prefinalize-quota-bypass/attachment-prefinalize-quota-bypass.md).

<a id="finding-2"></a>

### [2] One account can register unbounded large device records

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Direct source review confirms no account device cardinality, aggregate-byte, or registration-rate guard before memory and PostgreSQL insertion. |
| Category | resource-exhaustion |
| CWE | CWE-400 |
| Affected lines | services/api/src/main.rs:722-753, services/api/src/persistence.rs:182-193, services/api/src/main.rs:1157-1166 |

#### Summary

See the [detailed technical write-up](findings/unbounded-device-registration/unbounded-device-registration.md).

#### Validation

See the [detailed technical write-up](findings/unbounded-device-registration/unbounded-device-registration.md).

#### Dataflow

See the [detailed technical write-up](findings/unbounded-device-registration/unbounded-device-registration.md).

#### Reachability

See the [detailed technical write-up](findings/unbounded-device-registration/unbounded-device-registration.md).

#### Severity

See the [detailed technical write-up](findings/unbounded-device-registration/unbounded-device-registration.md).

#### Remediation

See the [detailed technical write-up](findings/unbounded-device-registration/unbounded-device-registration.md).

<a id="finding-3"></a>

### [3] Mailbox messages have no cumulative quota or maximum retention

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Static route and persistence traces establish 1 MiB envelopes, 120 sends per minute per device, attacker-selected far-future expiry, and full memory plus PostgreSQL retention. |
| Category | resource-exhaustion |
| CWE | CWE-400 |
| Affected lines | services/api/src/main.rs:1043-1110, services/api/src/persistence.rs:234-273 |

#### Summary

See the [detailed technical write-up](findings/mailbox-unbounded-retention/mailbox-unbounded-retention.md).

#### Validation

See the [detailed technical write-up](findings/mailbox-unbounded-retention/mailbox-unbounded-retention.md).

#### Dataflow

See the [detailed technical write-up](findings/mailbox-unbounded-retention/mailbox-unbounded-retention.md).

#### Reachability

See the [detailed technical write-up](findings/mailbox-unbounded-retention/mailbox-unbounded-retention.md).

#### Severity

See the [detailed technical write-up](findings/mailbox-unbounded-retention/mailbox-unbounded-retention.md).

#### Remediation

See the [detailed technical write-up](findings/mailbox-unbounded-retention/mailbox-unbounded-retention.md).

<a id="finding-4"></a>

### [4] A malicious directory can silently add a message-decryption device

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | A complete static trust and send trace shows new device IDs bypass known-device comparison and receive Signal ciphertext; a live fake-device decrypt PoC was not run. |
| Category | identity-misbinding |
| CWE | CWE-345 |
| Affected lines | apps/web/src/security/trust.ts:75-92, apps/web/src/security/signal.ts:109-169, packages/protocol/src/index.ts:11-25 |

#### Summary

See the [detailed technical write-up](findings/directory-device-injection/directory-device-injection.md).

#### Validation

See the [detailed technical write-up](findings/directory-device-injection/directory-device-injection.md).

#### Dataflow

See the [detailed technical write-up](findings/directory-device-injection/directory-device-injection.md).

#### Reachability

See the [detailed technical write-up](findings/directory-device-injection/directory-device-injection.md).

#### Severity

See the [detailed technical write-up](findings/directory-device-injection/directory-device-injection.md).

#### Remediation

See the [detailed technical write-up](findings/directory-device-injection/directory-device-injection.md).

<a id="finding-5"></a>

### [5] Group messages are rendered without filtering by group ID

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The MLS layer returns the correct group ID, while the React state and render path visibly discard it and use one shared message list. |
| Category | conversation-context-integrity |
| CWE | CWE-345 |
| Affected lines | apps/web/src/App.tsx:732-790, apps/web/src/App.tsx:976-984 |

#### Summary

See the [detailed technical write-up](findings/group-message-context-mixup/group-message-context-mixup.md).

#### Validation

See the [detailed technical write-up](findings/group-message-context-mixup/group-message-context-mixup.md).

#### Dataflow

See the [detailed technical write-up](findings/group-message-context-mixup/group-message-context-mixup.md).

#### Reachability

See the [detailed technical write-up](findings/group-message-context-mixup/group-message-context-mixup.md).

#### Severity

See the [detailed technical write-up](findings/group-message-context-mixup/group-message-context-mixup.md).

#### Remediation

See the [detailed technical write-up](findings/group-message-context-mixup/group-message-context-mixup.md).

<a id="finding-6"></a>

### [6] Authenticated messages can be filed under a forged username

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Static tracing proves the outer device identity is authenticated while the decrypted username is only syntax-checked before it becomes the history and display key. |
| Category | identity-misbinding |
| CWE | CWE-345 |
| Affected lines | apps/web/src/security/signal.ts:246-289, apps/web/src/App.tsx:475-490 |

#### Summary

See the [detailed technical write-up](findings/sender-username-misbinding/sender-username-misbinding.md).

#### Validation

See the [detailed technical write-up](findings/sender-username-misbinding/sender-username-misbinding.md).

#### Dataflow

See the [detailed technical write-up](findings/sender-username-misbinding/sender-username-misbinding.md).

#### Reachability

See the [detailed technical write-up](findings/sender-username-misbinding/sender-username-misbinding.md).

#### Severity

See the [detailed technical write-up](findings/sender-username-misbinding/sender-username-misbinding.md).

#### Remediation

See the [detailed technical write-up](findings/sender-username-misbinding/sender-username-misbinding.md).

<a id="finding-7"></a>

### [7] Recovery accepts an old authentic backup without a freshness anchor

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Static cryptographic and recovery traces show authenticity verification but no client-held highest-version or parent-chain freshness check. |
| Category | rollback |
| CWE | CWE-294 |
| Affected lines | apps/web/src/security/backup.ts:41-97, apps/web/src/security/SecurityGate.tsx:88-110 |

#### Summary

See the [detailed technical write-up](findings/encrypted-backup-rollback/encrypted-backup-rollback.md).

#### Validation

See the [detailed technical write-up](findings/encrypted-backup-rollback/encrypted-backup-rollback.md).

#### Dataflow

See the [detailed technical write-up](findings/encrypted-backup-rollback/encrypted-backup-rollback.md).

#### Reachability

See the [detailed technical write-up](findings/encrypted-backup-rollback/encrypted-backup-rollback.md).

#### Severity

See the [detailed technical write-up](findings/encrypted-backup-rollback/encrypted-backup-rollback.md).

#### Remediation

See the [detailed technical write-up](findings/encrypted-backup-rollback/encrypted-backup-rollback.md).

<a id="finding-8"></a>

### [8] Abuse reports can combine one conversation’s plaintext with another user

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Static state tracing proves the plaintext remains stale across recipient changes and is signed with the newly selected username; exploitation requires several user actions. |
| Category | evidence-misbinding |
| CWE | CWE-345 |
| Affected lines | apps/web/src/App.tsx:472-515, apps/web/src/App.tsx:1109-1113, apps/web/src/security/api.ts:200-237 |

#### Summary

See the [detailed technical write-up](findings/abuse-report-context-misbinding/abuse-report-context-misbinding.md).

#### Validation

See the [detailed technical write-up](findings/abuse-report-context-misbinding/abuse-report-context-misbinding.md).

#### Dataflow

See the [detailed technical write-up](findings/abuse-report-context-misbinding/abuse-report-context-misbinding.md).

#### Reachability

See the [detailed technical write-up](findings/abuse-report-context-misbinding/abuse-report-context-misbinding.md).

#### Severity

See the [detailed technical write-up](findings/abuse-report-context-misbinding/abuse-report-context-misbinding.md).

#### Remediation

See the [detailed technical write-up](findings/abuse-report-context-misbinding/abuse-report-context-misbinding.md).

## Structural Hardening

The scan also produced derived, unsealed design guidance based on the complete finding collection. These proposals describe options and tradeoffs; they do not indicate that any finding has been remediated.

[Open the structural hardening portfolio](hardening/hardening.md)

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Pre-finalization attachment uploads can consume gigabytes per object | resource-exhaustion | Reported | Attachment creation limits the declared object to 100 MiB, but chunk ingestion accepts up to 1,024 8 MiB chunks and stores them before finalization checks the declared total. An authenticated device can therefore retain about 8 GiB per unfinished object, with unlimited objects and no account quota. Evidence: artifacts/05_findings/COVE-DISC-B05B-003/candidate_ledger.jsonl |
| Mailbox messages have no cumulative quota or maximum retention | resource-exhaustion | Reported | A registered device can enqueue about 120 MiB per minute with far-future expiry because mailbox count, aggregate bytes, and maximum retention are unbounded. Queued ciphertext is kept in shared process memory and PostgreSQL and hydrated back into memory on restart. Evidence: artifacts/05_findings/COVE-DISC-B05B-002/candidate_ledger.jsonl |
| One account can register unbounded large device records | resource-exhaustion | Reported | A legitimate account signing key can authorize unlimited device records with pre-key bundles approaching 256 KiB. Every record is retained in process memory and PostgreSQL; directory responses and per-device message work further amplify the cost. Evidence: artifacts/05_findings/COVE-DISC-B05B-001/candidate_ledger.jsonl |
| A malicious directory can silently add a message-decryption device | identity-misbinding | Reported | After a contact has been observed or safety-code verified, a malicious API/database can append a new device while preserving known keys. The client silently trusts the new device, does not verify its account authorization signature, and encrypts future messages to it. Evidence: artifacts/05_findings/COVE-DIRECTORY-NEW-DEVICE-001/candidate_ledger.jsonl |
| Authenticated messages can be filed under a forged username | identity-misbinding | Reported | A legitimate malicious sender can create a valid Signal message whose encrypted `senderUsername` names another account. The receiver authenticates the real sending device but never binds it to that username, then stores and displays the message in the forged contact conversation. Evidence: artifacts/05_findings/COVE-SENDER-USERNAME-BINDING-001/candidate_ledger.jsonl |
| Group messages are rendered without filtering by group ID | conversation-context-integrity | Reported | Valid messages from group A remain in one global UI array and are displayed while group B is selected because the returned `groupId` is discarded. This can cause false attribution, social engineering, and replies sent to the wrong group. Evidence: artifacts/05_findings/COVE-DISC-B01B-001/candidate_ledger.jsonl |
| Recovery accepts an old authentic backup without a freshness anchor | rollback | Reported | A malicious service or database can return an older valid encrypted backup during recovery. The client verifies ciphertext integrity and keys but has no independent freshness anchor, so old history and trust state are silently restored. Evidence: artifacts/05_findings/COVE-DISC-B02B-002/candidate_ledger.jsonl |
| Abuse reports can combine one conversation’s plaintext with another user | evidence-misbinding | Reported | After receiving a message from A and switching to B, the security panel can sign and submit A’s stale plaintext as evidence against B. The confirmation dialog does not display the actual text or source conversation. Evidence: artifacts/05_findings/COVE-DISC-B01B-002/candidate_ledger.jsonl |
| Cryptographic signing domains and local vault hardening | cryptographic hardening | Rejected | Cross-protocol signature equivalence or an independent trust consumer was not established; local KDF abuse required already-compromised same-origin storage. Evidence: artifacts/05_findings/COVE-DISC-B02B-001/candidate_ledger.jsonl, artifacts/05_findings/COVE-DISC-B04B-001/candidate_ledger.jsonl |
| Installer, updater, and deployment inputs | operator/supply chain | Rejected | Paths are real hardening opportunities but require already trusted operator input or compromise of explicitly trusted upstream publishers. Evidence: artifacts/05_findings/COVE-SUPPLYCHAIN-001/candidate_ledger.jsonl, artifacts/05_findings/COVE-SUPPLYCHAIN-002/candidate_ledger.jsonl, artifacts/05_findings/COVE-DEPLOY-INPUT-001/candidate_ledger.jsonl |
| Recovery UX, Redis TTL atomicity, and backup durability | robustness and UX | Rejected | Confirmed hardening or correctness defects did not cross an independent lower-trust security boundary under the threat model. Evidence: artifacts/05_findings/COVE-DISC-B02B-003/candidate_ledger.jsonl, artifacts/05_findings/COVE-RATELIMIT-001/candidate_ledger.jsonl, artifacts/05_findings/COVE-BACKUP-001/candidate_ledger.jsonl |
| Signal/PQXDH and MLS cryptographic core | protocol state and downgrade | No issue found | Version, authentication, identity-change, epoch, and replay controls were reviewed and failed closed; issues reported above are surrounding binding/UI/storage controls. Evidence: artifacts/02_discovery/work_ledger.jsonl |

## Open Questions And Follow Up

- Can a focused multi-account browser test reproduce the sender-name and device-directory findings end to end?
  - Follow-up prompt: Add focused E2E tests for forged senderUsername and malicious appended DeviceRecord without modifying protocol semantics.
