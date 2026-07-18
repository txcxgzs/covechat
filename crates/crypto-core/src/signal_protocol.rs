use std::time::{Duration, SystemTime};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_executor::block_on;
use libsignal_protocol::{
    CiphertextMessage, DeviceId, GenericSignedPreKey, IdentityKeyPair, KeyPair, KyberPreKeyId,
    KyberPreKeyRecord, KyberPreKeyStore, PreKeyBundle, PreKeyId, PreKeyRecord, PreKeySignalMessage,
    PreKeyStore, ProtocolAddress, PublicKey, SignalMessage, SignedPreKeyId, SignedPreKeyRecord,
    SignedPreKeyStore, Timestamp, kem, message_decrypt, message_encrypt, process_prekey_bundle,
};
#[cfg(test)]
use libsignal_protocol::{IdentityKeyStore, InMemSignalProtocolStore};
use rand::{RngCore, TryRngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};

use crate::signal_store::SignalStoreState;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalPreKeyBundle {
    pub version: u8,
    pub owner_name: String,
    pub device_id: u32,
    pub registration_id: u32,
    pub identity_key: String,
    pub pre_key_id: u32,
    pub pre_key_public: String,
    pub signed_pre_key_id: u32,
    pub signed_pre_key_public: String,
    pub signed_pre_key_signature: String,
    pub kyber_pre_key_id: u32,
    pub kyber_pre_key_public: String,
    pub kyber_pre_key_signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalDeviceBootstrap {
    pub state: SignalStoreState,
    pub pre_key_bundle: SignalPreKeyBundle,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalEncryptResult {
    pub state: SignalStoreState,
    pub message_type: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalDecryptResult {
    pub state: SignalStoreState,
    pub plaintext: String,
}

fn signal_address(name: &str, device_id: u32) -> Result<ProtocolAddress, String> {
    if name.is_empty() || name.len() > 128 {
        return Err("invalid Signal address name".into());
    }
    let device_id = u8::try_from(device_id)
        .map_err(|_| "invalid Signal device id".to_string())
        .and_then(|value| DeviceId::new(value).map_err(|_| "invalid Signal device id".into()))?;
    Ok(ProtocolAddress::new(name.to_owned(), device_id))
}

pub fn create_device(local_name: &str, device_id: u32) -> Result<SignalDeviceBootstrap, String> {
    let local_address = signal_address(local_name, device_id)?;
    block_on(async {
        let mut rng = OsRng.unwrap_err();
        let registration_id = (rng.next_u32() & 0x3fff).max(1);
        let identity = IdentityKeyPair::generate(&mut rng);
        let mut state = SignalStoreState::new(
            local_address.name().to_owned(),
            device_id,
            identity,
            registration_id,
        );

        let pre_key_id = PreKeyId::from(1_u32);
        let pre_key = KeyPair::generate(&mut rng);
        state
            .save_pre_key(pre_key_id, &PreKeyRecord::new(pre_key_id, &pre_key))
            .await
            .map_err(|error| error.to_string())?;

        let signed_pre_key_id = SignedPreKeyId::from(1_u32);
        let signed_pre_key = KeyPair::generate(&mut rng);
        let signed_signature = identity
            .private_key()
            .calculate_signature(&signed_pre_key.public_key.serialize(), &mut rng)
            .map_err(|error| error.to_string())?;
        state
            .save_signed_pre_key(
                signed_pre_key_id,
                &SignedPreKeyRecord::new(
                    signed_pre_key_id,
                    Timestamp::from_epoch_millis(1),
                    &signed_pre_key,
                    &signed_signature,
                ),
            )
            .await
            .map_err(|error| error.to_string())?;

        let kyber_pre_key_id = KyberPreKeyId::from(1_u32);
        let kyber_pre_key = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng);
        let kyber_signature = identity
            .private_key()
            .calculate_signature(&kyber_pre_key.public_key.serialize(), &mut rng)
            .map_err(|error| error.to_string())?;
        state
            .save_kyber_pre_key(
                kyber_pre_key_id,
                &KyberPreKeyRecord::new(
                    kyber_pre_key_id,
                    Timestamp::from_epoch_millis(1),
                    &kyber_pre_key,
                    &kyber_signature,
                ),
            )
            .await
            .map_err(|error| error.to_string())?;

        Ok(SignalDeviceBootstrap {
            state,
            pre_key_bundle: SignalPreKeyBundle {
                version: 1,
                owner_name: local_address.name().to_owned(),
                device_id,
                registration_id,
                identity_key: URL_SAFE_NO_PAD.encode(identity.identity_key().serialize()),
                pre_key_id: pre_key_id.into(),
                pre_key_public: URL_SAFE_NO_PAD.encode(pre_key.public_key.serialize()),
                signed_pre_key_id: signed_pre_key_id.into(),
                signed_pre_key_public: URL_SAFE_NO_PAD
                    .encode(signed_pre_key.public_key.serialize()),
                signed_pre_key_signature: URL_SAFE_NO_PAD.encode(signed_signature),
                kyber_pre_key_id: kyber_pre_key_id.into(),
                kyber_pre_key_public: URL_SAFE_NO_PAD.encode(kyber_pre_key.public_key.serialize()),
                kyber_pre_key_signature: URL_SAFE_NO_PAD.encode(kyber_signature),
            },
        })
    })
}

pub fn refresh_pre_keys(
    mut state: SignalStoreState,
    now_millis: u64,
) -> Result<SignalDeviceBootstrap, String> {
    block_on(async {
        let mut rng = OsRng.unwrap_err();
        let identity = state.identity_pair().map_err(|error| error.to_string())?;
        let pre_key_id = PreKeyId::from(
            state
                .pre_keys
                .keys()
                .copied()
                .max()
                .unwrap_or(0)
                .saturating_add(1),
        );
        let pre_key = KeyPair::generate(&mut rng);
        state
            .save_pre_key(pre_key_id, &PreKeyRecord::new(pre_key_id, &pre_key))
            .await
            .map_err(|error| error.to_string())?;

        let signed_pre_key_id = SignedPreKeyId::from(
            state
                .signed_pre_keys
                .keys()
                .copied()
                .max()
                .unwrap_or(0)
                .saturating_add(1),
        );
        let signed_pre_key = KeyPair::generate(&mut rng);
        let signed_signature = identity
            .private_key()
            .calculate_signature(&signed_pre_key.public_key.serialize(), &mut rng)
            .map_err(|error| error.to_string())?;
        state
            .save_signed_pre_key(
                signed_pre_key_id,
                &SignedPreKeyRecord::new(
                    signed_pre_key_id,
                    Timestamp::from_epoch_millis(now_millis),
                    &signed_pre_key,
                    &signed_signature,
                ),
            )
            .await
            .map_err(|error| error.to_string())?;

        let kyber_pre_key_id = KyberPreKeyId::from(
            state
                .kyber_pre_keys
                .keys()
                .copied()
                .max()
                .unwrap_or(0)
                .saturating_add(1),
        );
        let kyber_pre_key = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng);
        let kyber_signature = identity
            .private_key()
            .calculate_signature(&kyber_pre_key.public_key.serialize(), &mut rng)
            .map_err(|error| error.to_string())?;
        state
            .save_kyber_pre_key(
                kyber_pre_key_id,
                &KyberPreKeyRecord::new(
                    kyber_pre_key_id,
                    Timestamp::from_epoch_millis(now_millis),
                    &kyber_pre_key,
                    &kyber_signature,
                ),
            )
            .await
            .map_err(|error| error.to_string())?;

        Ok(SignalDeviceBootstrap {
            pre_key_bundle: SignalPreKeyBundle {
                version: 1,
                owner_name: state.local_name.clone(),
                device_id: state.device_id,
                registration_id: state.registration_id,
                identity_key: URL_SAFE_NO_PAD.encode(identity.identity_key().serialize()),
                pre_key_id: pre_key_id.into(),
                pre_key_public: URL_SAFE_NO_PAD.encode(pre_key.public_key.serialize()),
                signed_pre_key_id: signed_pre_key_id.into(),
                signed_pre_key_public: URL_SAFE_NO_PAD
                    .encode(signed_pre_key.public_key.serialize()),
                signed_pre_key_signature: URL_SAFE_NO_PAD.encode(signed_signature),
                kyber_pre_key_id: kyber_pre_key_id.into(),
                kyber_pre_key_public: URL_SAFE_NO_PAD.encode(kyber_pre_key.public_key.serialize()),
                kyber_pre_key_signature: URL_SAFE_NO_PAD.encode(kyber_signature),
            },
            state,
        })
    })
}

fn decode_bundle(bundle: &SignalPreKeyBundle) -> Result<PreKeyBundle, String> {
    if bundle.version != 1 {
        return Err("unsupported Signal bundle version".into());
    }
    let pre_key = PublicKey::deserialize(
        &URL_SAFE_NO_PAD
            .decode(&bundle.pre_key_public)
            .map_err(|_| "invalid Signal pre-key")?,
    )
    .map_err(|error| error.to_string())?;
    let signed_pre_key = PublicKey::deserialize(
        &URL_SAFE_NO_PAD
            .decode(&bundle.signed_pre_key_public)
            .map_err(|_| "invalid Signal signed pre-key")?,
    )
    .map_err(|error| error.to_string())?;
    let kyber_pre_key = kem::PublicKey::deserialize(
        &URL_SAFE_NO_PAD
            .decode(&bundle.kyber_pre_key_public)
            .map_err(|_| "invalid Signal Kyber pre-key")?,
    )
    .map_err(|error| error.to_string())?;
    let identity = libsignal_protocol::IdentityKey::decode(
        &URL_SAFE_NO_PAD
            .decode(&bundle.identity_key)
            .map_err(|_| "invalid Signal identity key")?,
    )
    .map_err(|error| error.to_string())?;
    PreKeyBundle::new(
        bundle.registration_id,
        u8::try_from(bundle.device_id)
            .map_err(|_| "invalid Signal device id".to_string())
            .and_then(|value| {
                DeviceId::new(value).map_err(|_| "invalid Signal device id".to_string())
            })?,
        Some((bundle.pre_key_id.into(), pre_key)),
        bundle.signed_pre_key_id.into(),
        signed_pre_key,
        URL_SAFE_NO_PAD
            .decode(&bundle.signed_pre_key_signature)
            .map_err(|_| "invalid Signal signed pre-key signature")?,
        bundle.kyber_pre_key_id.into(),
        kyber_pre_key,
        URL_SAFE_NO_PAD
            .decode(&bundle.kyber_pre_key_signature)
            .map_err(|_| "invalid Signal Kyber pre-key signature")?,
        identity,
    )
    .map_err(|error| error.to_string())
}

pub fn initiate_session(
    mut state: SignalStoreState,
    remote: &SignalPreKeyBundle,
    now_millis: u64,
) -> Result<SignalStoreState, String> {
    let local_address = signal_address(&state.local_name, state.device_id)?;
    let remote_address = signal_address(&remote.owner_name, remote.device_id)?;
    if state.sessions.contains_key(&remote_address.to_string()) {
        return match state.trusted_identities.get(&remote_address.to_string()) {
            Some(identity) if identity == &remote.identity_key => Ok(state),
            Some(_) => Err("Signal identity key changed; explicit verification required".into()),
            None => Err("Signal session is missing its trusted identity".into()),
        };
    }
    let bundle = decode_bundle(remote)?;
    block_on(async {
        let mut rng = OsRng.unwrap_err();
        let mut identity_state = state.clone();
        process_prekey_bundle(
            &remote_address,
            &local_address,
            &mut state,
            &mut identity_state,
            &bundle,
            SystemTime::UNIX_EPOCH + Duration::from_millis(now_millis),
            &mut rng,
        )
        .await
        .map_err(|error| error.to_string())?;
        state.trusted_identities = identity_state.trusted_identities;
        Ok(state)
    })
}

pub fn encrypt_message(
    mut state: SignalStoreState,
    remote_name: &str,
    remote_device_id: u32,
    plaintext: &[u8],
    now_millis: u64,
) -> Result<SignalEncryptResult, String> {
    if plaintext.is_empty() {
        return Err("Signal plaintext must not be empty".into());
    }
    let local_address = signal_address(&state.local_name, state.device_id)?;
    let remote_address = signal_address(remote_name, remote_device_id)?;
    block_on(async {
        let mut rng = OsRng.unwrap_err();
        let mut identity_state = state.clone();
        let ciphertext = message_encrypt(
            plaintext,
            &remote_address,
            &local_address,
            &mut state,
            &mut identity_state,
            SystemTime::UNIX_EPOCH + Duration::from_millis(now_millis),
            &mut rng,
        )
        .await
        .map_err(|error| error.to_string())?;
        state.trusted_identities = identity_state.trusted_identities;
        let message_type = match ciphertext {
            CiphertextMessage::PreKeySignalMessage(_) => "prekey",
            CiphertextMessage::SignalMessage(_) => "signal",
            _ => return Err("unexpected libsignal ciphertext type".into()),
        };
        Ok(SignalEncryptResult {
            state,
            message_type: message_type.into(),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext.serialize()),
        })
    })
}

pub fn decrypt_message(
    mut state: SignalStoreState,
    remote_name: &str,
    remote_device_id: u32,
    message_type: &str,
    ciphertext: &str,
) -> Result<SignalDecryptResult, String> {
    let local_address = signal_address(&state.local_name, state.device_id)?;
    let remote_address = signal_address(remote_name, remote_device_id)?;
    let serialized = URL_SAFE_NO_PAD
        .decode(ciphertext)
        .map_err(|_| "invalid Signal ciphertext encoding")?;
    let ciphertext = match message_type {
        "prekey" => CiphertextMessage::PreKeySignalMessage(
            PreKeySignalMessage::try_from(serialized.as_slice())
                .map_err(|error| error.to_string())?,
        ),
        "signal" => CiphertextMessage::SignalMessage(
            SignalMessage::try_from(serialized.as_slice()).map_err(|error| error.to_string())?,
        ),
        _ => return Err("unsupported Signal ciphertext type".into()),
    };
    block_on(async {
        let mut rng = OsRng.unwrap_err();
        let mut session_state = state.clone();
        let mut identity_state = state.clone();
        let mut pre_key_state = state.clone();
        let signed_pre_key_state = state.clone();
        let mut kyber_pre_key_state = state.clone();
        let plaintext = message_decrypt(
            &ciphertext,
            &remote_address,
            &local_address,
            &mut session_state,
            &mut identity_state,
            &mut pre_key_state,
            &signed_pre_key_state,
            &mut kyber_pre_key_state,
            &mut rng,
        )
        .await
        .map_err(|error| error.to_string())?;
        state.sessions = session_state.sessions;
        state.trusted_identities = identity_state.trusted_identities;
        state.pre_keys = pre_key_state.pre_keys;
        state.kyber_pre_keys = kyber_pre_key_state.kyber_pre_keys;
        state.used_kyber_base_keys = kyber_pre_key_state.used_kyber_base_keys;
        Ok(SignalDecryptResult {
            state,
            plaintext: URL_SAFE_NO_PAD.encode(plaintext),
        })
    })
}

/// Runs a complete exchange through the pinned official libsignal core.
///
/// Product persistence is implemented against the same libsignal store traits;
/// no CoveChat code reimplements PQXDH or ratchet primitives.
#[cfg(test)]
pub(crate) fn integration_self_test() -> Result<(), String> {
    block_on(async {
        let mut rng = OsRng.unwrap_err();
        let alice_address = ProtocolAddress::new(
            "covechat-signal-self-test-alice".into(),
            DeviceId::new(1).expect("valid device id"),
        );
        let bob_address = ProtocolAddress::new(
            "covechat-signal-self-test-bob".into(),
            DeviceId::new(1).expect("valid device id"),
        );
        let mut alice = InMemSignalProtocolStore::new(IdentityKeyPair::generate(&mut rng), 1001)
            .map_err(|error| error.to_string())?;
        let mut bob = InMemSignalProtocolStore::new(IdentityKeyPair::generate(&mut rng), 1002)
            .map_err(|error| error.to_string())?;

        let signed_pre_key_id = SignedPreKeyId::from(1_u32);
        let signed_pre_key = KeyPair::generate(&mut rng);
        let signed_pre_key_bytes = signed_pre_key.public_key.serialize();
        let signed_pre_key_signature = bob
            .get_identity_key_pair()
            .await
            .map_err(|error| error.to_string())?
            .private_key()
            .calculate_signature(&signed_pre_key_bytes, &mut rng)
            .map_err(|error| error.to_string())?;

        let kyber_pre_key_id = KyberPreKeyId::from(1_u32);
        let kyber_pre_key = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng);
        let kyber_pre_key_bytes = kyber_pre_key.public_key.serialize();
        let kyber_pre_key_signature = bob
            .get_identity_key_pair()
            .await
            .map_err(|error| error.to_string())?
            .private_key()
            .calculate_signature(&kyber_pre_key_bytes, &mut rng)
            .map_err(|error| error.to_string())?;

        bob.save_signed_pre_key(
            signed_pre_key_id,
            &SignedPreKeyRecord::new(
                signed_pre_key_id,
                Timestamp::from_epoch_millis(1),
                &signed_pre_key,
                &signed_pre_key_signature,
            ),
        )
        .await
        .map_err(|error| error.to_string())?;
        bob.save_kyber_pre_key(
            kyber_pre_key_id,
            &KyberPreKeyRecord::new(
                kyber_pre_key_id,
                Timestamp::from_epoch_millis(1),
                &kyber_pre_key,
                &kyber_pre_key_signature,
            ),
        )
        .await
        .map_err(|error| error.to_string())?;

        let bundle = PreKeyBundle::new(
            bob.get_local_registration_id()
                .await
                .map_err(|error| error.to_string())?,
            DeviceId::new(1).expect("valid device id"),
            None,
            signed_pre_key_id,
            signed_pre_key.public_key,
            signed_pre_key_signature.to_vec(),
            kyber_pre_key_id,
            kyber_pre_key.public_key,
            kyber_pre_key_signature.to_vec(),
            *bob.get_identity_key_pair()
                .await
                .map_err(|error| error.to_string())?
                .identity_key(),
        )
        .map_err(|error| error.to_string())?;

        process_prekey_bundle(
            &bob_address,
            &alice_address,
            &mut alice.session_store,
            &mut alice.identity_store,
            &bundle,
            SystemTime::now(),
            &mut rng,
        )
        .await
        .map_err(|error| error.to_string())?;

        let plaintext = b"covechat official libsignal interop";
        let ciphertext = message_encrypt(
            plaintext,
            &bob_address,
            &alice_address,
            &mut alice.session_store,
            &mut alice.identity_store,
            SystemTime::now(),
            &mut rng,
        )
        .await
        .map_err(|error| error.to_string())?;
        let decoded = CiphertextMessage::PreKeySignalMessage(
            PreKeySignalMessage::try_from(ciphertext.serialize())
                .map_err(|error| error.to_string())?,
        );
        let decrypted = message_decrypt(
            &decoded,
            &alice_address,
            &bob_address,
            &mut bob.session_store,
            &mut bob.identity_store,
            &mut bob.pre_key_store,
            &bob.signed_pre_key_store,
            &mut bob.kyber_pre_key_store,
            &mut rng,
        )
        .await
        .map_err(|error| error.to_string())?;
        if decrypted != plaintext {
            return Err("official libsignal round trip plaintext mismatch".into());
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

    #[test]
    fn official_pqxdh_and_triple_ratchet_round_trip() {
        super::integration_self_test().expect("official libsignal exchange succeeds");
    }

    #[test]
    fn durable_state_survives_serialization_and_blocks_identity_replacement() {
        const TEST_NOW_MILLIS: u64 = 1_700_000_000_000;
        let mut alice = super::create_device("alice", 1).expect("alice device");
        let mut bob = super::create_device("bob", 1).expect("bob device");
        alice.state = super::initiate_session(alice.state, &bob.pre_key_bundle, TEST_NOW_MILLIS)
            .expect("PQXDH session");

        let encrypted =
            super::encrypt_message(alice.state, "bob", 1, b"hello ratchet", TEST_NOW_MILLIS)
                .expect("encrypt");
        alice.state = serde_json::from_str(
            &serde_json::to_string(&encrypted.state).expect("serialize state"),
        )
        .expect("deserialize state");
        let decrypted = super::decrypt_message(
            bob.state,
            "alice",
            1,
            &encrypted.message_type,
            &encrypted.ciphertext,
        )
        .expect("decrypt");
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(&decrypted.plaintext)
                .expect("plaintext encoding"),
            b"hello ratchet"
        );
        bob.state = decrypted.state;

        let response = super::encrypt_message(
            bob.state,
            "alice",
            1,
            b"ratchet response",
            TEST_NOW_MILLIS + 1,
        )
        .expect("response");
        let response_plaintext = super::decrypt_message(
            alice.state.clone(),
            "bob",
            1,
            &response.message_type,
            &response.ciphertext,
        )
        .expect("decrypt response");
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(&response_plaintext.plaintext)
                .expect("plaintext encoding"),
            b"ratchet response"
        );

        let replacement = super::create_device("bob", 1).expect("replacement device");
        assert!(
            super::initiate_session(
                response_plaintext.state,
                &replacement.pre_key_bundle,
                TEST_NOW_MILLIS + 2,
            )
            .is_err(),
            "a changed identity must not silently replace the trusted identity"
        );
    }

    #[test]
    fn one_time_pre_keys_rotate_without_identity_change() {
        let initial = super::create_device("alice", 1).expect("device");
        let rotated =
            super::refresh_pre_keys(initial.state.clone(), 1_700_000_000_000).expect("rotate");
        assert_ne!(
            initial.pre_key_bundle.pre_key_public,
            rotated.pre_key_bundle.pre_key_public
        );
        assert_ne!(
            initial.pre_key_bundle.kyber_pre_key_public,
            rotated.pre_key_bundle.kyber_pre_key_public
        );
        assert_eq!(
            initial.pre_key_bundle.identity_key,
            rotated.pre_key_bundle.identity_key
        );
    }
}
