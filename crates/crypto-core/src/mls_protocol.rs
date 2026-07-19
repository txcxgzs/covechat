use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use openmls::prelude::{
    BasicCredential, Ciphersuite, CredentialWithKey, GroupId, KeyPackage, KeyPackageIn, MlsGroup,
    MlsGroupCreateConfig, MlsGroupJoinConfig, MlsMessageBodyIn, MlsMessageIn,
    ProcessedMessageContent, ProtocolMessage, ProtocolVersion, StagedWelcome,
    tls_codec::{
        Deserialize as TlsDeserialize, DeserializeBytes as TlsDeserializeBytes,
        Serialize as TlsSerialize,
    },
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{OpenMlsProvider, types::SignatureScheme};
use serde::{Deserialize, Serialize};

const STATE_VERSION: u16 = 1;
const MAX_GROUP_MEMBERS: usize = 50;
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MlsState {
    pub version: u16,
    pub identity: String,
    pub signature_public_key: String,
    pub groups: Vec<String>,
    pub storage: Vec<MlsStorageEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MlsStorageEntry {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MlsDevice {
    pub state: MlsState,
    pub key_package: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MlsGroupResult {
    pub state: MlsState,
    pub group_id: String,
    pub epoch: u64,
    pub members: Vec<MlsMember>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MlsMember {
    pub leaf_index: u32,
    pub identity: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MlsCommitResult {
    pub state: MlsState,
    pub group_id: String,
    pub epoch: u64,
    pub commit: String,
    pub welcome: Option<String>,
    pub members: Vec<MlsMember>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MlsMessageResult {
    pub state: MlsState,
    pub group_id: String,
    pub epoch: u64,
    pub ciphertext: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MlsProcessedResult {
    pub state: MlsState,
    pub group_id: String,
    pub epoch: u64,
    pub kind: String,
    pub sender_identity: String,
    pub plaintext: Option<String>,
    pub members: Vec<MlsMember>,
}

fn encode(bytes: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode(value: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "invalid base64url encoding".to_string())
}

fn provider_from_state(state: &MlsState) -> Result<OpenMlsRustCrypto, String> {
    if state.version != STATE_VERSION {
        return Err("unsupported MLS state version".into());
    }
    let provider = OpenMlsRustCrypto::default();
    let mut values = provider
        .storage()
        .values
        .write()
        .map_err(|_| "MLS storage lock poisoned".to_string())?;
    for entry in &state.storage {
        values.insert(decode(&entry.key)?, decode(&entry.value)?);
    }
    drop(values);
    Ok(provider)
}

fn export_state(
    provider: &OpenMlsRustCrypto,
    identity: String,
    signature_public_key: String,
    groups: Vec<String>,
) -> Result<MlsState, String> {
    let values = provider
        .storage()
        .values
        .read()
        .map_err(|_| "MLS storage lock poisoned".to_string())?;
    let mut storage = values
        .iter()
        .map(|(key, value)| MlsStorageEntry {
            key: encode(key),
            value: encode(value),
        })
        .collect::<Vec<_>>();
    storage.sort_by(|left, right| left.key.cmp(&right.key));
    Ok(MlsState {
        version: STATE_VERSION,
        identity,
        signature_public_key,
        groups,
        storage,
    })
}

fn signer(state: &MlsState, provider: &OpenMlsRustCrypto) -> Result<SignatureKeyPair, String> {
    let public = decode(&state.signature_public_key)?;
    SignatureKeyPair::read(provider.storage(), &public, SignatureScheme::ED25519)
        .ok_or_else(|| "MLS signature key unavailable".into())
}

fn load_group(provider: &OpenMlsRustCrypto, group_id: &str) -> Result<MlsGroup, String> {
    let id = GroupId::from_slice(&decode(group_id)?);
    MlsGroup::load(provider.storage(), &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "MLS group not found".into())
}

fn group_members(group: &MlsGroup) -> Vec<MlsMember> {
    group
        .members()
        .map(|member| MlsMember {
            leaf_index: member.index.u32(),
            identity: String::from_utf8_lossy(member.credential.serialized_content()).into_owned(),
        })
        .collect()
}

fn group_epoch(group: &MlsGroup) -> u64 {
    group.epoch().as_u64()
}

fn save_group_state(state: MlsState, provider: &OpenMlsRustCrypto) -> Result<MlsState, String> {
    export_state(
        provider,
        state.identity,
        state.signature_public_key,
        state.groups,
    )
}

pub fn create_device(identity: &str) -> Result<MlsDevice, String> {
    if identity.is_empty() || identity.len() > 128 {
        return Err("invalid MLS identity".into());
    }
    let provider = OpenMlsRustCrypto::default();
    let signature =
        SignatureKeyPair::new(SignatureScheme::ED25519).map_err(|error| error.to_string())?;
    signature
        .store(provider.storage())
        .map_err(|error| error.to_string())?;
    let credential = CredentialWithKey {
        credential: BasicCredential::new(identity.as_bytes().to_vec()).into(),
        signature_key: signature.public().into(),
    };
    let key_package = KeyPackage::builder()
        .build(CIPHERSUITE, &provider, &signature, credential)
        .map_err(|error| error.to_string())?;
    let key_package_bytes = key_package
        .key_package()
        .tls_serialize_detached()
        .map_err(|error| error.to_string())?;
    let state = export_state(
        &provider,
        identity.to_owned(),
        encode(signature.public()),
        Vec::new(),
    )?;
    Ok(MlsDevice {
        state,
        key_package: encode(key_package_bytes),
    })
}

pub fn refresh_key_package(state: MlsState) -> Result<MlsDevice, String> {
    let provider = provider_from_state(&state)?;
    let signature = signer(&state, &provider)?;
    let credential = CredentialWithKey {
        credential: BasicCredential::new(state.identity.as_bytes().to_vec()).into(),
        signature_key: signature.public().into(),
    };
    let key_package = KeyPackage::builder()
        .build(CIPHERSUITE, &provider, &signature, credential)
        .map_err(|error| error.to_string())?;
    let key_package = encode(
        key_package
            .key_package()
            .tls_serialize_detached()
            .map_err(|error| error.to_string())?,
    );
    Ok(MlsDevice {
        state: save_group_state(state, &provider)?,
        key_package,
    })
}

pub fn create_group(state: MlsState, group_id: &[u8]) -> Result<MlsGroupResult, String> {
    if group_id.len() < 16 || group_id.len() > 64 {
        return Err("MLS group id must contain 16-64 bytes".into());
    }
    let provider = provider_from_state(&state)?;
    let signature = signer(&state, &provider)?;
    let credential = CredentialWithKey {
        credential: BasicCredential::new(state.identity.as_bytes().to_vec()).into(),
        signature_key: signature.public().into(),
    };
    let config = MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
        .use_ratchet_tree_extension(true)
        .build();
    let group = MlsGroup::new_with_group_id(
        &provider,
        &signature,
        &config,
        GroupId::from_slice(group_id),
        credential,
    )
    .map_err(|error| error.to_string())?;
    let encoded_group_id = encode(group_id);
    let mut groups = state.groups.clone();
    if !groups.contains(&encoded_group_id) {
        groups.push(encoded_group_id.clone());
    }
    let members = group_members(&group);
    let epoch = group_epoch(&group);
    let state = export_state(
        &provider,
        state.identity,
        state.signature_public_key,
        groups,
    )?;
    Ok(MlsGroupResult {
        state,
        group_id: encoded_group_id,
        epoch,
        members,
    })
}

pub fn add_member(
    state: MlsState,
    group_id: &str,
    key_package: &str,
) -> Result<MlsCommitResult, String> {
    let provider = provider_from_state(&state)?;
    let signature = signer(&state, &provider)?;
    let mut group = load_group(&provider, group_id)?;
    if group.members().count() >= MAX_GROUP_MEMBERS {
        return Err("MLS group member limit reached".into());
    }
    let key_package = KeyPackageIn::tls_deserialize_exact_bytes(&decode(key_package)?)
        .map_err(|error| error.to_string())?
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .map_err(|error| error.to_string())?;
    let (commit, welcome, _) = group
        .add_members(&provider, &signature, &[key_package])
        .map_err(|error| error.to_string())?;
    let commit = encode(
        commit
            .tls_serialize_detached()
            .map_err(|error| error.to_string())?,
    );
    let welcome = encode(
        welcome
            .tls_serialize_detached()
            .map_err(|error| error.to_string())?,
    );
    group
        .merge_pending_commit(&provider)
        .map_err(|error| error.to_string())?;
    let epoch = group_epoch(&group);
    let members = group_members(&group);
    Ok(MlsCommitResult {
        state: save_group_state(state, &provider)?,
        group_id: group_id.to_owned(),
        epoch,
        commit,
        welcome: Some(welcome),
        members,
    })
}

pub fn join_group(state: MlsState, welcome: &str) -> Result<MlsGroupResult, String> {
    let provider = provider_from_state(&state)?;
    let message =
        MlsMessageIn::tls_deserialize_exact(decode(welcome)?).map_err(|error| error.to_string())?;
    let welcome = match message.extract() {
        MlsMessageBodyIn::Welcome(welcome) => welcome,
        _ => return Err("expected MLS Welcome".into()),
    };
    let config = MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .build();
    let staged = StagedWelcome::new_from_welcome(&provider, &config, welcome, None)
        .map_err(|error| error.to_string())?;
    let group = staged
        .into_group(&provider)
        .map_err(|error| error.to_string())?;
    let group_id = encode(group.group_id().as_slice());
    let mut groups = state.groups.clone();
    if !groups.contains(&group_id) {
        groups.push(group_id.clone());
    }
    let epoch = group_epoch(&group);
    let members = group_members(&group);
    let state = export_state(
        &provider,
        state.identity,
        state.signature_public_key,
        groups,
    )?;
    Ok(MlsGroupResult {
        state,
        group_id,
        epoch,
        members,
    })
}

pub fn encrypt_message(
    state: MlsState,
    group_id: &str,
    plaintext: &[u8],
) -> Result<MlsMessageResult, String> {
    let provider = provider_from_state(&state)?;
    let signature = signer(&state, &provider)?;
    let mut group = load_group(&provider, group_id)?;
    let message = group
        .create_message(&provider, &signature, plaintext)
        .map_err(|error| error.to_string())?;
    let ciphertext = encode(
        message
            .tls_serialize_detached()
            .map_err(|error| error.to_string())?,
    );
    let epoch = group_epoch(&group);
    Ok(MlsMessageResult {
        state: save_group_state(state, &provider)?,
        group_id: group_id.to_owned(),
        epoch,
        ciphertext,
    })
}

pub fn process_message(
    state: MlsState,
    group_id: &str,
    ciphertext: &str,
) -> Result<MlsProcessedResult, String> {
    let provider = provider_from_state(&state)?;
    let mut group = load_group(&provider, group_id)?;
    let message = MlsMessageIn::tls_deserialize_exact(decode(ciphertext)?)
        .map_err(|error| error.to_string())?;
    let protocol: ProtocolMessage = message
        .try_into_protocol_message()
        .map_err(|error| error.to_string())?;
    let processed = group
        .process_message(&provider, protocol)
        .map_err(|error| error.to_string())?;
    let sender_identity = String::from_utf8(processed.credential().serialized_content().to_vec())
        .map_err(|_| "MLS sender identity is not valid UTF-8".to_string())?;
    let (kind, plaintext) = match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(message) => {
            ("application".to_owned(), Some(encode(message.into_bytes())))
        }
        ProcessedMessageContent::StagedCommitMessage(commit) => {
            group
                .merge_staged_commit(&provider, *commit)
                .map_err(|error| error.to_string())?;
            ("commit".to_owned(), None)
        }
        ProcessedMessageContent::ProposalMessage(_) => ("proposal".to_owned(), None),
        _ => return Err("unsupported MLS message content".into()),
    };
    let epoch = group_epoch(&group);
    let members = group_members(&group);
    Ok(MlsProcessedResult {
        state: save_group_state(state, &provider)?,
        group_id: group_id.to_owned(),
        epoch,
        kind,
        sender_identity,
        plaintext,
        members,
    })
}

pub fn delete_group(state: MlsState, group_id: &str) -> Result<MlsState, String> {
    let provider = provider_from_state(&state)?;
    let mut group = load_group(&provider, group_id)?;
    group
        .delete(provider.storage())
        .map_err(|error| error.to_string())?;
    let groups = state
        .groups
        .iter()
        .filter(|candidate| candidate.as_str() != group_id)
        .cloned()
        .collect();
    export_state(
        &provider,
        state.identity,
        state.signature_public_key,
        groups,
    )
}

pub fn remove_member(
    state: MlsState,
    group_id: &str,
    leaf_index: u32,
) -> Result<MlsCommitResult, String> {
    let provider = provider_from_state(&state)?;
    let signature = signer(&state, &provider)?;
    let mut group = load_group(&provider, group_id)?;
    let target = group
        .members()
        .find(|member| member.index.u32() == leaf_index)
        .map(|member| member.index)
        .ok_or_else(|| "MLS member not found".to_string())?;
    if target == group.own_leaf_index() {
        return Err("a member cannot commit its own removal".into());
    }
    let (commit, _, _) = group
        .remove_members(&provider, &signature, &[target])
        .map_err(|error| error.to_string())?;
    let commit = encode(
        commit
            .tls_serialize_detached()
            .map_err(|error| error.to_string())?,
    );
    group
        .merge_pending_commit(&provider)
        .map_err(|error| error.to_string())?;
    let epoch = group_epoch(&group);
    let members = group_members(&group);
    Ok(MlsCommitResult {
        state: save_group_state(state, &provider)?,
        group_id: group_id.to_owned(),
        epoch,
        commit,
        welcome: None,
        members,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_membership_epochs_and_application_messages() {
        let mut alice = create_device("alice/device-1").expect("alice");
        let mut bob = create_device("bob/device-1").expect("bob");
        let created = create_group(alice.state, &[7; 16]).expect("create group");
        alice.state = created.state;
        assert_eq!(created.epoch, 0);

        let added = add_member(alice.state, &created.group_id, &bob.key_package).expect("add bob");
        alice.state = added.state;
        assert_eq!(added.epoch, 1);
        assert_eq!(added.members.len(), 2);

        let joined =
            join_group(bob.state, added.welcome.as_deref().expect("welcome")).expect("join");
        bob.state = joined.state;
        assert_eq!(joined.epoch, 1);

        let encrypted =
            encrypt_message(alice.state, &created.group_id, b"hello MLS").expect("encrypt");
        alice.state = encrypted.state;
        let decrypted =
            process_message(bob.state, &created.group_id, &encrypted.ciphertext).expect("decrypt");
        bob.state = decrypted.state;
        assert_eq!(decrypted.kind, "application");
        assert_eq!(decrypted.sender_identity, "alice/device-1");
        assert_eq!(
            decode(decrypted.plaintext.as_deref().expect("plaintext")).unwrap(),
            b"hello MLS"
        );

        let bob_leaf = added
            .members
            .iter()
            .find(|member| member.identity == "bob/device-1")
            .expect("bob member")
            .leaf_index;
        let removed = remove_member(alice.state, &created.group_id, bob_leaf).expect("remove");
        alice.state = removed.state;
        assert_eq!(removed.epoch, 2);
        let bob_commit =
            process_message(bob.state, &created.group_id, &removed.commit).expect("commit");
        bob.state = bob_commit.state;
        assert_eq!(bob_commit.epoch, 2);
        assert_eq!(bob_commit.sender_identity, "alice/device-1");
        bob.state = delete_group(bob.state, &created.group_id).expect("delete removed group");
        assert!(!bob.state.groups.contains(&created.group_id));
        assert!(process_message(bob.state.clone(), &created.group_id, &removed.commit).is_err());

        let after_removal =
            encrypt_message(alice.state, &created.group_id, b"secret after removal")
                .expect("encrypt new epoch");
        assert!(
            process_message(bob.state, &created.group_id, &after_removal.ciphertext).is_err(),
            "removed member must not decrypt messages from the new epoch"
        );
    }

    #[test]
    fn state_round_trip_and_tamper_fail_closed() {
        let alice = create_device("alice/device-1").expect("alice");
        let created = create_group(alice.state, &[9; 16]).expect("group");
        let serialized = serde_json::to_string(&created.state).expect("serialize");
        let restored: MlsState = serde_json::from_str(&serialized).expect("deserialize");
        let encrypted =
            encrypt_message(restored, &created.group_id, b"persisted").expect("load group");
        let mut tampered = encrypted.ciphertext.into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        assert!(
            process_message(
                encrypted.state,
                &created.group_id,
                std::str::from_utf8(&tampered).unwrap(),
            )
            .is_err()
        );
    }

    #[test]
    fn key_packages_rotate_without_changing_identity() {
        let initial = create_device("alice/device-1").expect("device");
        let rotated = refresh_key_package(initial.state.clone()).expect("rotate key package");
        assert_ne!(initial.key_package, rotated.key_package);
        assert_eq!(rotated.state.identity, "alice/device-1");
        assert_eq!(
            initial.state.signature_public_key,
            rotated.state.signature_public_key
        );
    }
}
