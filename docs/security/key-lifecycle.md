# Key lifecycle

| Material | Generated | Stored | Rotation | Destroyed |
| --- | --- | --- | --- | --- |
| Recovery secret | Client OS RNG | User-controlled recovery code | After suspected disclosure | Explicit account recovery/reset |
| Recovery authentication key | HKDF from recovery secret and account context | Private part derived only when needed; public part server-side | Recovery-secret rotation | Immediately after challenge signing |
| Account identity | Client crypto core | Local encrypted vault and encrypted backup | Recovery or compromise | After all devices migrate |
| Device identity | Each device | Local encrypted vault | Device relink | Device revoke |
| Signed/one-time prekeys | Device | Private portion in vault, public bundle server-side | Protocol schedule/consumption | After safe skipped-message window |
| Ratchet message key | Ratchet step | Memory/skipped-key bounded cache | Every message | Immediately after use |
| MLS epoch secret | MLS commit | Local encrypted state | Every membership commit | After transition window |
| Attachment key | Client per object | Only inside encrypted message | Every object | Per conversation retention |
| Backup key | HKDF recovery secret | Derived only when needed | Recovery-secret rotation | Immediately after operation |

All Rust secret buffers use zeroization wrappers where the dependency boundary
permits it. Browser memory cannot guarantee physical erasure and this limitation
must remain documented.

Recovery authentication tokens expire after ten minutes and are accepted only
by recovery backup and recovered-device endpoints. They cannot read mailboxes or
send envelopes. Registering a recovered device revokes every previous device
session for the account before the new device is activated.
