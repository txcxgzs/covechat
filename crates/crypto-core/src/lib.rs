#![forbid(unsafe_code)]

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

#[cfg(feature = "mls-protocol")]
mod mls_protocol;
#[cfg(feature = "signal-protocol")]
mod signal_protocol;
#[cfg(feature = "signal-protocol")]
mod signal_store;
#[cfg(feature = "mls-protocol")]
pub use mls_protocol::{
    MlsCommitResult, MlsDevice, MlsGroupResult, MlsMessageResult, MlsProcessedResult, MlsState,
    add_member as mls_add_member, create_device as mls_create_device,
    create_group as mls_create_group, encrypt_message as mls_encrypt_message,
    join_group as mls_join_group, process_message as mls_process_message,
    refresh_key_package as mls_refresh_key_package, remove_member as mls_remove_member,
};
#[cfg(feature = "signal-protocol")]
pub use signal_protocol::{
    SignalDecryptResult, SignalDeviceBootstrap, SignalEncryptResult, SignalPreKeyBundle,
    create_device as signal_create_device, decrypt_message as signal_decrypt_message,
    encrypt_message as signal_encrypt_message, initiate_session as signal_initiate_session,
    refresh_pre_keys as signal_refresh_pre_keys,
};
#[cfg(feature = "signal-protocol")]
pub use signal_store::SignalStoreState;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

const BACKUP_INFO: &[u8] = b"covechat/v1/backup-key";
const ATTACHMENT_INFO: &[u8] = b"covechat/v1/attachment-key";
const RECOVERY_AUTH_INFO: &[u8] = b"covechat/v1/recovery-auth-key";
const SIGNAL_STATE_INFO: &[u8] = b"covechat/v1/signal-state-key";
const SIGNAL_STATE_AAD: &[u8] = b"covechat/v1/signal-state";
const MLS_STATE_INFO: &[u8] = b"covechat/v1/mls-state-key";
const MLS_STATE_AAD: &[u8] = b"covechat/v1/mls-state";
const VAULT_AAD: &[u8] = b"covechat/v1/local-vault";

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("invalid input")]
    InvalidInput,
    #[error("key derivation failed")]
    KeyDerivation,
    #[error("authentication failed")]
    Authentication,
    #[error("unsupported protocol adapter: {0}")]
    UnsupportedProtocol(&'static str),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedBlob {
    pub version: u8,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalVault {
    pub version: u8,
    pub salt: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub blob: EncryptedBlob,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SigningKeyPair {
    pub private_key: String,
    pub public_key: String,
}

pub fn generate_recovery_secret() -> Result<String, CryptoError> {
    let mut secret = Zeroizing::new([0_u8; 32]);
    getrandom::fill(secret.as_mut()).map_err(|_| CryptoError::KeyDerivation)?;
    let checksum = Sha256::digest(secret.as_ref());
    let mut encoded = Zeroizing::new(Vec::with_capacity(36));
    encoded.extend_from_slice(secret.as_ref());
    encoded.extend_from_slice(&checksum[..4]);
    Ok(URL_SAFE_NO_PAD.encode(&encoded[..]))
}

pub fn generate_signing_keypair() -> Result<SigningKeyPair, CryptoError> {
    let mut private = Zeroizing::new([0_u8; 32]);
    getrandom::fill(private.as_mut()).map_err(|_| CryptoError::KeyDerivation)?;
    let signing = SigningKey::from_bytes(&private);
    Ok(SigningKeyPair {
        private_key: URL_SAFE_NO_PAD.encode(private.as_ref()),
        public_key: URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes()),
    })
}

pub fn derive_recovery_signing_keypair(
    recovery_secret: &str,
    account_context: &[u8],
) -> Result<SigningKeyPair, CryptoError> {
    if account_context.is_empty() {
        return Err(CryptoError::InvalidInput);
    }
    let mut secret = decode_recovery_secret(recovery_secret)?;
    let hkdf = Hkdf::<Sha256>::new(Some(account_context), &secret[..32]);
    let mut private = Zeroizing::new([0_u8; 32]);
    hkdf.expand(RECOVERY_AUTH_INFO, private.as_mut())
        .map_err(|_| CryptoError::KeyDerivation)?;
    secret.zeroize();
    let signing = SigningKey::from_bytes(&private);
    Ok(SigningKeyPair {
        private_key: URL_SAFE_NO_PAD.encode(private.as_ref()),
        public_key: URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes()),
    })
}

pub fn sign_payload(private_key: &str, payload: &[u8]) -> Result<String, CryptoError> {
    let mut private = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(private_key)
            .map_err(|_| CryptoError::InvalidInput)?,
    );
    let bytes: [u8; 32] = private
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::InvalidInput)?;
    let signing = SigningKey::from_bytes(&bytes);
    let signature = signing.sign(payload);
    private.zeroize();
    Ok(URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

pub fn derive_backup_key(
    recovery_secret: &str,
    account_id: &[u8],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let mut secret = decode_recovery_secret(recovery_secret)?;
    let hkdf = Hkdf::<Sha256>::new(Some(account_id), &secret[..32]);
    let mut output = Zeroizing::new([0_u8; 32]);
    hkdf.expand(BACKUP_INFO, output.as_mut())
        .map_err(|_| CryptoError::KeyDerivation)?;
    secret.zeroize();
    Ok(output)
}

fn decode_recovery_secret(recovery_secret: &str) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let secret = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(recovery_secret)
            .map_err(|_| CryptoError::InvalidInput)?,
    );
    if secret.len() != 36 {
        return Err(CryptoError::InvalidInput);
    }
    let expected = Sha256::digest(&secret[..32]);
    if expected[..4] != secret[32..] {
        return Err(CryptoError::InvalidInput);
    }
    Ok(secret)
}

pub fn derive_attachment_key(
    conversation_secret: &[u8],
    object_id: &[u8],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if conversation_secret.len() < 32 || object_id.is_empty() {
        return Err(CryptoError::InvalidInput);
    }
    let hkdf = Hkdf::<Sha256>::new(Some(object_id), conversation_secret);
    let mut output = Zeroizing::new([0_u8; 32]);
    hkdf.expand(ATTACHMENT_INFO, output.as_mut())
        .map_err(|_| CryptoError::KeyDerivation)?;
    Ok(output)
}

pub fn generate_attachment_key() -> Result<String, CryptoError> {
    let mut key = Zeroizing::new([0_u8; 32]);
    getrandom::fill(key.as_mut()).map_err(|_| CryptoError::KeyDerivation)?;
    Ok(URL_SAFE_NO_PAD.encode(key.as_ref()))
}

pub fn encrypt_attachment_chunk(
    attachment_key: &str,
    object_id: &[u8],
    chunk_index: u32,
    plaintext: &[u8],
) -> Result<EncryptedBlob, CryptoError> {
    let key = decode_attachment_key(attachment_key)?;
    let aad = attachment_chunk_aad(object_id, chunk_index)?;
    encrypt_blob(&key, plaintext, &aad)
}

pub fn decrypt_attachment_chunk(
    attachment_key: &str,
    object_id: &[u8],
    chunk_index: u32,
    blob: &EncryptedBlob,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let key = decode_attachment_key(attachment_key)?;
    let aad = attachment_chunk_aad(object_id, chunk_index)?;
    decrypt_blob(&key, blob, &aad)
}

fn decode_attachment_key(value: &str) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| CryptoError::InvalidInput)?,
    );
    let bytes: [u8; 32] = decoded
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::InvalidInput)?;
    Ok(Zeroizing::new(bytes))
}

fn attachment_chunk_aad(object_id: &[u8], chunk_index: u32) -> Result<Vec<u8>, CryptoError> {
    if object_id.is_empty() || object_id.len() > 128 {
        return Err(CryptoError::InvalidInput);
    }
    let mut aad = Vec::with_capacity(32 + object_id.len());
    aad.extend_from_slice(b"covechat/v1/attachment-chunk/");
    aad.extend_from_slice(&(object_id.len() as u32).to_be_bytes());
    aad.extend_from_slice(object_id);
    aad.extend_from_slice(&chunk_index.to_be_bytes());
    Ok(aad)
}

pub fn encrypt_blob(
    key: &[u8; 32],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<EncryptedBlob, CryptoError> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce = [0_u8; 24];
    getrandom::fill(&mut nonce).map_err(|_| CryptoError::KeyDerivation)?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Authentication)?;
    Ok(EncryptedBlob {
        version: 1,
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
}

pub fn decrypt_blob(
    key: &[u8; 32],
    blob: &EncryptedBlob,
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if blob.version != 1 {
        return Err(CryptoError::InvalidInput);
    }
    let nonce = URL_SAFE_NO_PAD
        .decode(&blob.nonce)
        .map_err(|_| CryptoError::InvalidInput)?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&blob.ciphertext)
        .map_err(|_| CryptoError::InvalidInput)?;
    if nonce.len() != 24 {
        return Err(CryptoError::InvalidInput);
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Authentication)?;
    Ok(Zeroizing::new(plaintext))
}

fn derive_device_state_key(
    device_private_key: &str,
    info: &[u8],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let key_material = URL_SAFE_NO_PAD
        .decode(device_private_key)
        .map_err(|_| CryptoError::InvalidInput)?;
    if key_material.len() != 32 {
        return Err(CryptoError::InvalidInput);
    }
    let mut key = Zeroizing::new([0_u8; 32]);
    Hkdf::<Sha256>::new(None, &key_material)
        .expand(info, key.as_mut())
        .map_err(|_| CryptoError::KeyDerivation)?;
    Ok(key)
}

pub fn encrypt_signal_state(
    device_private_key: &str,
    plaintext: &[u8],
) -> Result<EncryptedBlob, CryptoError> {
    let key = derive_device_state_key(device_private_key, SIGNAL_STATE_INFO)?;
    encrypt_blob(&key, plaintext, SIGNAL_STATE_AAD)
}

pub fn decrypt_signal_state(
    device_private_key: &str,
    blob: &EncryptedBlob,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let key = derive_device_state_key(device_private_key, SIGNAL_STATE_INFO)?;
    decrypt_blob(&key, blob, SIGNAL_STATE_AAD)
}

pub fn encrypt_mls_state(
    device_private_key: &str,
    plaintext: &[u8],
) -> Result<EncryptedBlob, CryptoError> {
    let key = derive_device_state_key(device_private_key, MLS_STATE_INFO)?;
    encrypt_blob(&key, plaintext, MLS_STATE_AAD)
}

pub fn decrypt_mls_state(
    device_private_key: &str,
    blob: &EncryptedBlob,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let key = derive_device_state_key(device_private_key, MLS_STATE_INFO)?;
    decrypt_blob(&key, blob, MLS_STATE_AAD)
}

pub fn create_local_vault(passphrase: &str, plaintext: &[u8]) -> Result<LocalVault, CryptoError> {
    if passphrase.chars().count() < 10 {
        return Err(CryptoError::InvalidInput);
    }
    let memory_kib = 64 * 1024;
    let iterations = 3;
    let parallelism = 1;
    let mut salt = [0_u8; 16];
    getrandom::fill(&mut salt).map_err(|_| CryptoError::KeyDerivation)?;
    let key = derive_vault_key(passphrase, &salt, memory_kib, iterations, parallelism)?;
    let blob = encrypt_blob(&key, plaintext, VAULT_AAD)?;
    Ok(LocalVault {
        version: 1,
        salt: URL_SAFE_NO_PAD.encode(salt),
        memory_kib,
        iterations,
        parallelism,
        blob,
    })
}

pub fn open_local_vault(
    passphrase: &str,
    vault: &LocalVault,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if vault.version != 1 {
        return Err(CryptoError::InvalidInput);
    }
    let salt = URL_SAFE_NO_PAD
        .decode(&vault.salt)
        .map_err(|_| CryptoError::InvalidInput)?;
    let key = derive_vault_key(
        passphrase,
        &salt,
        vault.memory_kib,
        vault.iterations,
        vault.parallelism,
    )?;
    decrypt_blob(&key, &vault.blob, VAULT_AAD)
}

fn derive_vault_key(
    passphrase: &str,
    salt: &[u8],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if memory_kib < 32 * 1024 || iterations < 2 || parallelism == 0 {
        return Err(CryptoError::InvalidInput);
    }
    let params = Params::new(memory_kib, iterations, parallelism, Some(32))
        .map_err(|_| CryptoError::KeyDerivation)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0_u8; 32]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|_| CryptoError::KeyDerivation)?;
    Ok(key)
}

/// Reports whether a verified protocol adapter was compiled into this build.
pub fn initialize_messaging_protocol(name: &str) -> Result<(), CryptoError> {
    match name {
        #[cfg(feature = "signal-protocol")]
        "signal-pqxdh-triple-ratchet" => Ok(()),
        #[cfg(not(feature = "signal-protocol"))]
        "signal-pqxdh-triple-ratchet" => Err(CryptoError::UnsupportedProtocol("signal")),
        "mls-rfc9420" => Err(CryptoError::UnsupportedProtocol("mls")),
        _ => Err(CryptoError::InvalidInput),
    }
}

#[cfg(target_arch = "wasm32")]
fn js_error(error: CryptoError) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[cfg(all(target_arch = "wasm32", feature = "signal-protocol"))]
fn signal_js_error(error: String) -> JsValue {
    JsValue::from_str(&error)
}

#[cfg(all(target_arch = "wasm32", feature = "signal-protocol"))]
#[wasm_bindgen]
pub fn wasm_signal_create_device(local_name: &str, device_id: u32) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    let value = signal_create_device(local_name, device_id).map_err(signal_js_error)?;
    serde_json::to_string(&value).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(all(target_arch = "wasm32", feature = "signal-protocol"))]
#[wasm_bindgen]
pub fn wasm_signal_refresh_pre_keys(state_json: &str, now_millis: u64) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    let state: SignalStoreState =
        serde_json::from_str(state_json).map_err(|_| js_error(CryptoError::InvalidInput))?;
    let value = signal_refresh_pre_keys(state, now_millis).map_err(signal_js_error)?;
    serde_json::to_string(&value).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(all(target_arch = "wasm32", feature = "signal-protocol"))]
#[wasm_bindgen]
pub fn wasm_signal_initiate_session(
    state_json: &str,
    remote_bundle_json: &str,
    now_millis: u64,
) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    let state: SignalStoreState =
        serde_json::from_str(state_json).map_err(|_| js_error(CryptoError::InvalidInput))?;
    let bundle: SignalPreKeyBundle = serde_json::from_str(remote_bundle_json)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    let value = signal_initiate_session(state, &bundle, now_millis).map_err(signal_js_error)?;
    serde_json::to_string(&value).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(all(target_arch = "wasm32", feature = "signal-protocol"))]
#[wasm_bindgen]
pub fn wasm_signal_encrypt(
    state_json: &str,
    remote_name: &str,
    remote_device_id: u32,
    plaintext_base64: &str,
    now_millis: u64,
) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    let state: SignalStoreState =
        serde_json::from_str(state_json).map_err(|_| js_error(CryptoError::InvalidInput))?;
    let plaintext = URL_SAFE_NO_PAD
        .decode(plaintext_base64)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    let value =
        signal_encrypt_message(state, remote_name, remote_device_id, &plaintext, now_millis)
            .map_err(signal_js_error)?;
    serde_json::to_string(&value).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(all(target_arch = "wasm32", feature = "signal-protocol"))]
#[wasm_bindgen]
pub fn wasm_signal_decrypt(
    state_json: &str,
    remote_name: &str,
    remote_device_id: u32,
    message_type: &str,
    ciphertext: &str,
) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    let state: SignalStoreState =
        serde_json::from_str(state_json).map_err(|_| js_error(CryptoError::InvalidInput))?;
    let value = signal_decrypt_message(
        state,
        remote_name,
        remote_device_id,
        message_type,
        ciphertext,
    )
    .map_err(signal_js_error)?;
    serde_json::to_string(&value).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(all(target_arch = "wasm32", feature = "mls-protocol"))]
fn mls_js_error(error: String) -> JsValue {
    JsValue::from_str(&error)
}

#[cfg(all(target_arch = "wasm32", feature = "mls-protocol"))]
fn parse_mls_state(state_json: &str) -> Result<MlsState, JsValue> {
    serde_json::from_str(state_json).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(all(target_arch = "wasm32", feature = "mls-protocol"))]
fn serialize_mls<T: Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(all(target_arch = "wasm32", feature = "mls-protocol"))]
#[wasm_bindgen]
pub fn wasm_mls_create_device(identity: &str) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    serialize_mls(&mls_create_device(identity).map_err(mls_js_error)?)
}

#[cfg(all(target_arch = "wasm32", feature = "mls-protocol"))]
#[wasm_bindgen]
pub fn wasm_mls_refresh_key_package(state_json: &str) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    serialize_mls(&mls_refresh_key_package(parse_mls_state(state_json)?).map_err(mls_js_error)?)
}

#[cfg(all(target_arch = "wasm32", feature = "mls-protocol"))]
#[wasm_bindgen]
pub fn wasm_mls_create_group(state_json: &str, group_id_base64: &str) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    let group_id = URL_SAFE_NO_PAD
        .decode(group_id_base64)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    serialize_mls(&mls_create_group(parse_mls_state(state_json)?, &group_id).map_err(mls_js_error)?)
}

#[cfg(all(target_arch = "wasm32", feature = "mls-protocol"))]
#[wasm_bindgen]
pub fn wasm_mls_add_member(
    state_json: &str,
    group_id: &str,
    key_package: &str,
) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    serialize_mls(
        &mls_add_member(parse_mls_state(state_json)?, group_id, key_package)
            .map_err(mls_js_error)?,
    )
}

#[cfg(all(target_arch = "wasm32", feature = "mls-protocol"))]
#[wasm_bindgen]
pub fn wasm_mls_join_group(state_json: &str, welcome: &str) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    serialize_mls(&mls_join_group(parse_mls_state(state_json)?, welcome).map_err(mls_js_error)?)
}

#[cfg(all(target_arch = "wasm32", feature = "mls-protocol"))]
#[wasm_bindgen]
pub fn wasm_mls_encrypt(
    state_json: &str,
    group_id: &str,
    plaintext_base64: &str,
) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    let plaintext = URL_SAFE_NO_PAD
        .decode(plaintext_base64)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    serialize_mls(
        &mls_encrypt_message(parse_mls_state(state_json)?, group_id, &plaintext)
            .map_err(mls_js_error)?,
    )
}

#[cfg(all(target_arch = "wasm32", feature = "mls-protocol"))]
#[wasm_bindgen]
pub fn wasm_mls_process(
    state_json: &str,
    group_id: &str,
    ciphertext: &str,
) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    serialize_mls(
        &mls_process_message(parse_mls_state(state_json)?, group_id, ciphertext)
            .map_err(mls_js_error)?,
    )
}

#[cfg(all(target_arch = "wasm32", feature = "mls-protocol"))]
#[wasm_bindgen]
pub fn wasm_mls_remove_member(
    state_json: &str,
    group_id: &str,
    leaf_index: u32,
) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    serialize_mls(
        &mls_remove_member(parse_mls_state(state_json)?, group_id, leaf_index)
            .map_err(mls_js_error)?,
    )
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_encrypt_signal_state(
    device_private_key: &str,
    plaintext_base64: &str,
) -> Result<String, JsValue> {
    let plaintext = URL_SAFE_NO_PAD
        .decode(plaintext_base64)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    let blob = encrypt_signal_state(device_private_key, &plaintext).map_err(js_error)?;
    serde_json::to_string(&blob).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_decrypt_signal_state(
    device_private_key: &str,
    blob_json: &str,
) -> Result<String, JsValue> {
    let blob: EncryptedBlob =
        serde_json::from_str(blob_json).map_err(|_| js_error(CryptoError::InvalidInput))?;
    let plaintext = decrypt_signal_state(device_private_key, &blob).map_err(js_error)?;
    Ok(URL_SAFE_NO_PAD.encode(&*plaintext))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_encrypt_mls_state(
    device_private_key: &str,
    plaintext_base64: &str,
) -> Result<String, JsValue> {
    let plaintext = URL_SAFE_NO_PAD
        .decode(plaintext_base64)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    let blob = encrypt_mls_state(device_private_key, &plaintext).map_err(js_error)?;
    serde_json::to_string(&blob).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_decrypt_mls_state(
    device_private_key: &str,
    blob_json: &str,
) -> Result<String, JsValue> {
    let blob: EncryptedBlob =
        serde_json::from_str(blob_json).map_err(|_| js_error(CryptoError::InvalidInput))?;
    let plaintext = decrypt_mls_state(device_private_key, &blob).map_err(js_error)?;
    Ok(URL_SAFE_NO_PAD.encode(&*plaintext))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_generate_recovery_secret() -> Result<String, JsValue> {
    generate_recovery_secret().map_err(js_error)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_generate_signing_keypair() -> Result<String, JsValue> {
    let keypair = generate_signing_keypair().map_err(js_error)?;
    serde_json::to_string(&keypair).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_derive_recovery_signing_keypair(
    recovery_secret: &str,
    account_context_base64: &str,
) -> Result<String, JsValue> {
    let context = URL_SAFE_NO_PAD
        .decode(account_context_base64)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    let keypair = derive_recovery_signing_keypair(recovery_secret, &context).map_err(js_error)?;
    serde_json::to_string(&keypair).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_sign_payload(private_key: &str, payload_base64: &str) -> Result<String, JsValue> {
    let payload = URL_SAFE_NO_PAD
        .decode(payload_base64)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    sign_payload(private_key, &payload).map_err(js_error)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_create_local_vault(
    passphrase: &str,
    plaintext_base64: &str,
) -> Result<String, JsValue> {
    let plaintext = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(plaintext_base64)
            .map_err(|_| js_error(CryptoError::InvalidInput))?,
    );
    let vault = create_local_vault(passphrase, plaintext.as_ref()).map_err(js_error)?;
    serde_json::to_string(&vault).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_open_local_vault(passphrase: &str, vault_json: &str) -> Result<String, JsValue> {
    let vault: LocalVault =
        serde_json::from_str(vault_json).map_err(|_| js_error(CryptoError::InvalidInput))?;
    let plaintext = open_local_vault(passphrase, &vault).map_err(js_error)?;
    Ok(URL_SAFE_NO_PAD.encode(&plaintext[..]))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_encrypt_backup(
    recovery_secret: &str,
    account_id_base64: &str,
    plaintext_base64: &str,
) -> Result<String, JsValue> {
    let account_id = URL_SAFE_NO_PAD
        .decode(account_id_base64)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    let plaintext = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(plaintext_base64)
            .map_err(|_| js_error(CryptoError::InvalidInput))?,
    );
    let key = derive_backup_key(recovery_secret, &account_id).map_err(js_error)?;
    let blob = encrypt_blob(&key, plaintext.as_ref(), b"covechat/v1/encrypted-backup")
        .map_err(js_error)?;
    serde_json::to_string(&blob).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_decrypt_backup(
    recovery_secret: &str,
    account_id_base64: &str,
    blob_json: &str,
) -> Result<String, JsValue> {
    let account_id = URL_SAFE_NO_PAD
        .decode(account_id_base64)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    let blob: EncryptedBlob =
        serde_json::from_str(blob_json).map_err(|_| js_error(CryptoError::InvalidInput))?;
    let key = derive_backup_key(recovery_secret, &account_id).map_err(js_error)?;
    let plaintext = decrypt_blob(&key, &blob, b"covechat/v1/encrypted-backup").map_err(js_error)?;
    Ok(URL_SAFE_NO_PAD.encode(&plaintext[..]))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_generate_attachment_key() -> Result<String, JsValue> {
    generate_attachment_key().map_err(js_error)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_encrypt_attachment_chunk(
    attachment_key: &str,
    object_id_base64: &str,
    chunk_index: u32,
    plaintext_base64: &str,
) -> Result<String, JsValue> {
    let object_id = URL_SAFE_NO_PAD
        .decode(object_id_base64)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    let plaintext = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(plaintext_base64)
            .map_err(|_| js_error(CryptoError::InvalidInput))?,
    );
    let blob =
        encrypt_attachment_chunk(attachment_key, &object_id, chunk_index, plaintext.as_ref())
            .map_err(js_error)?;
    serde_json::to_string(&blob).map_err(|_| js_error(CryptoError::InvalidInput))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_decrypt_attachment_chunk(
    attachment_key: &str,
    object_id_base64: &str,
    chunk_index: u32,
    blob_json: &str,
) -> Result<String, JsValue> {
    let object_id = URL_SAFE_NO_PAD
        .decode(object_id_base64)
        .map_err(|_| js_error(CryptoError::InvalidInput))?;
    let blob: EncryptedBlob =
        serde_json::from_str(blob_json).map_err(|_| js_error(CryptoError::InvalidInput))?;
    let plaintext = decrypt_attachment_chunk(attachment_key, &object_id, chunk_index, &blob)
        .map_err(js_error)?;
    Ok(URL_SAFE_NO_PAD.encode(&plaintext[..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_secret_has_checksum_and_domain_separation() {
        let secret = generate_recovery_secret().unwrap();
        let a = derive_backup_key(&secret, b"account-a").unwrap();
        let b = derive_backup_key(&secret, b"account-b").unwrap();
        assert_ne!(*a, *b);
        assert!(derive_backup_key("invalid", b"account-a").is_err());
    }

    #[test]
    fn blob_round_trip_and_tamper_rejection() {
        let key = [7_u8; 32];
        let mut blob = encrypt_blob(&key, b"private", b"metadata").unwrap();
        assert_eq!(
            &*decrypt_blob(&key, &blob, b"metadata").unwrap(),
            b"private"
        );
        blob.ciphertext.push('A');
        assert!(decrypt_blob(&key, &blob, b"metadata").is_err());
    }

    #[test]
    fn local_vault_rejects_wrong_password() {
        let vault = create_local_vault("a long local passphrase", b"identity keys").unwrap();
        assert_eq!(
            &*open_local_vault("a long local passphrase", &vault).unwrap(),
            b"identity keys"
        );
        assert!(open_local_vault("another long passphrase", &vault).is_err());
    }

    #[test]
    fn signal_state_is_bound_to_the_device_private_key() {
        let first = generate_signing_keypair().unwrap();
        let second = generate_signing_keypair().unwrap();
        let blob = encrypt_signal_state(&first.private_key, b"ratchet state").unwrap();
        assert_eq!(
            &*decrypt_signal_state(&first.private_key, &blob).unwrap(),
            b"ratchet state"
        );
        assert!(decrypt_signal_state(&second.private_key, &blob).is_err());
        assert!(
            decrypt_mls_state(&first.private_key, &blob).is_err(),
            "Signal and MLS state domains must not be interchangeable"
        );

        let mls_blob = encrypt_mls_state(&first.private_key, b"MLS state").unwrap();
        assert_eq!(
            &*decrypt_mls_state(&first.private_key, &mls_blob).unwrap(),
            b"MLS state"
        );
        assert!(decrypt_signal_state(&first.private_key, &mls_blob).is_err());
    }

    #[test]
    fn protocols_fail_closed() {
        assert!(matches!(
            initialize_messaging_protocol("mls-rfc9420"),
            Err(CryptoError::UnsupportedProtocol("mls"))
        ));
    }

    #[test]
    fn signing_keypair_signs_verifiable_payload() {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        let pair = generate_signing_keypair().unwrap();
        let signature_bytes = URL_SAFE_NO_PAD
            .decode(sign_payload(&pair.private_key, b"payload").unwrap())
            .unwrap();
        let signature = Signature::from_slice(&signature_bytes).unwrap();
        let public: [u8; 32] = URL_SAFE_NO_PAD
            .decode(pair.public_key)
            .unwrap()
            .try_into()
            .unwrap();
        assert!(
            VerifyingKey::from_bytes(&public)
                .unwrap()
                .verify(b"payload", &signature)
                .is_ok()
        );
    }

    #[test]
    fn recovery_auth_key_is_deterministic_and_domain_separated() {
        let secret = generate_recovery_secret().unwrap();
        let first = derive_recovery_signing_keypair(&secret, b"alice").unwrap();
        let repeated = derive_recovery_signing_keypair(&secret, b"alice").unwrap();
        let other = derive_recovery_signing_keypair(&secret, b"bob").unwrap();
        assert_eq!(first, repeated);
        assert_ne!(first.public_key, other.public_key);
        assert!(derive_recovery_signing_keypair("invalid", b"alice").is_err());
    }

    #[test]
    fn attachment_chunks_reject_reordering_and_wrong_object() {
        let key = generate_attachment_key().unwrap();
        let blob = encrypt_attachment_chunk(&key, b"object-a", 3, b"chunk").unwrap();
        assert_eq!(
            &*decrypt_attachment_chunk(&key, b"object-a", 3, &blob).unwrap(),
            b"chunk",
        );
        assert!(decrypt_attachment_chunk(&key, b"object-a", 4, &blob).is_err());
        assert!(decrypt_attachment_chunk(&key, b"object-b", 3, &blob).is_err());
    }
}
