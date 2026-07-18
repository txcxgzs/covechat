use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use libsignal_protocol::{
    CiphertextMessageType, Direction, GenericSignedPreKey, IdentityChange, IdentityKey,
    IdentityKeyPair, IdentityKeyStore, KyberPreKeyId, KyberPreKeyRecord, KyberPreKeyStore,
    PreKeyId, PreKeyRecord, PreKeyStore, ProtocolAddress, PublicKey, SessionRecord, SessionStore,
    SignalProtocolError, SignedPreKeyId, SignedPreKeyRecord, SignedPreKeyStore,
};
use serde::{Deserialize, Serialize};

type SignalResult<T> = Result<T, SignalProtocolError>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalStoreState {
    pub version: u8,
    pub local_name: String,
    pub device_id: u32,
    pub identity_key_pair: String,
    pub registration_id: u32,
    #[serde(default)]
    pub trusted_identities: HashMap<String, String>,
    #[serde(default)]
    pub pre_keys: HashMap<u32, String>,
    #[serde(default)]
    pub signed_pre_keys: HashMap<u32, String>,
    #[serde(default)]
    pub kyber_pre_keys: HashMap<u32, String>,
    #[serde(default)]
    pub used_kyber_base_keys: HashSet<String>,
    #[serde(default)]
    pub sessions: HashMap<String, String>,
}

impl SignalStoreState {
    pub fn new(
        local_name: String,
        device_id: u32,
        identity_key_pair: IdentityKeyPair,
        registration_id: u32,
    ) -> Self {
        Self {
            version: 1,
            local_name,
            device_id,
            identity_key_pair: encode(&identity_key_pair.serialize()),
            registration_id,
            trusted_identities: HashMap::new(),
            pre_keys: HashMap::new(),
            signed_pre_keys: HashMap::new(),
            kyber_pre_keys: HashMap::new(),
            used_kyber_base_keys: HashSet::new(),
            sessions: HashMap::new(),
        }
    }

    fn identity_pair(&self) -> SignalResult<IdentityKeyPair> {
        IdentityKeyPair::try_from(decode(&self.identity_key_pair)?.as_slice())
    }
}

fn address_key(address: &ProtocolAddress) -> String {
    address.to_string()
}

fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode(value: &str) -> SignalResult<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| SignalProtocolError::InvalidArgument("invalid base64 state".into()))
}

#[async_trait(?Send)]
impl IdentityKeyStore for SignalStoreState {
    async fn get_identity_key_pair(&self) -> SignalResult<IdentityKeyPair> {
        self.identity_pair()
    }

    async fn get_local_registration_id(&self) -> SignalResult<u32> {
        Ok(self.registration_id)
    }

    async fn save_identity(
        &mut self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
    ) -> SignalResult<IdentityChange> {
        let key = address_key(address);
        let encoded = encode(&identity.serialize());
        let changed = self
            .trusted_identities
            .insert(key, encoded.clone())
            .is_some_and(|previous| previous != encoded);
        Ok(IdentityChange::from_changed(changed))
    }

    async fn is_trusted_identity(
        &self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
        _direction: Direction,
    ) -> SignalResult<bool> {
        Ok(self
            .trusted_identities
            .get(&address_key(address))
            .is_none_or(|known| known == &encode(&identity.serialize())))
    }

    async fn get_identity(&self, address: &ProtocolAddress) -> SignalResult<Option<IdentityKey>> {
        self.trusted_identities
            .get(&address_key(address))
            .map(|value| IdentityKey::decode(&decode(value)?))
            .transpose()
    }
}

#[async_trait(?Send)]
impl PreKeyStore for SignalStoreState {
    async fn get_pre_key(&self, prekey_id: PreKeyId) -> SignalResult<PreKeyRecord> {
        let id: u32 = prekey_id.into();
        let value = self
            .pre_keys
            .get(&id)
            .ok_or(SignalProtocolError::InvalidPreKeyId)?;
        PreKeyRecord::deserialize(&decode(value)?)
    }

    async fn save_pre_key(
        &mut self,
        prekey_id: PreKeyId,
        record: &PreKeyRecord,
    ) -> SignalResult<()> {
        self.pre_keys
            .insert(prekey_id.into(), encode(&record.serialize()?));
        Ok(())
    }

    async fn remove_pre_key(&mut self, prekey_id: PreKeyId) -> SignalResult<()> {
        self.pre_keys.remove(&prekey_id.into());
        Ok(())
    }
}

#[async_trait(?Send)]
impl SignedPreKeyStore for SignalStoreState {
    async fn get_signed_pre_key(
        &self,
        signed_prekey_id: SignedPreKeyId,
    ) -> SignalResult<SignedPreKeyRecord> {
        let id: u32 = signed_prekey_id.into();
        let value = self
            .signed_pre_keys
            .get(&id)
            .ok_or(SignalProtocolError::InvalidSignedPreKeyId)?;
        SignedPreKeyRecord::deserialize(&decode(value)?)
    }

    async fn save_signed_pre_key(
        &mut self,
        signed_prekey_id: SignedPreKeyId,
        record: &SignedPreKeyRecord,
    ) -> SignalResult<()> {
        self.signed_pre_keys
            .insert(signed_prekey_id.into(), encode(&record.serialize()?));
        Ok(())
    }
}

#[async_trait(?Send)]
impl KyberPreKeyStore for SignalStoreState {
    async fn get_kyber_pre_key(
        &self,
        kyber_prekey_id: KyberPreKeyId,
    ) -> SignalResult<KyberPreKeyRecord> {
        let id: u32 = kyber_prekey_id.into();
        let value = self
            .kyber_pre_keys
            .get(&id)
            .ok_or(SignalProtocolError::InvalidKyberPreKeyId)?;
        KyberPreKeyRecord::deserialize(&decode(value)?)
    }

    async fn save_kyber_pre_key(
        &mut self,
        kyber_prekey_id: KyberPreKeyId,
        record: &KyberPreKeyRecord,
    ) -> SignalResult<()> {
        self.kyber_pre_keys
            .insert(kyber_prekey_id.into(), encode(&record.serialize()?));
        Ok(())
    }

    async fn mark_kyber_pre_key_used(
        &mut self,
        kyber_prekey_id: KyberPreKeyId,
        ec_prekey_id: SignedPreKeyId,
        base_key: &PublicKey,
    ) -> SignalResult<()> {
        let kyber_id: u32 = kyber_prekey_id.into();
        let ec_id: u32 = ec_prekey_id.into();
        let replay_key = format!("{kyber_id}:{ec_id}:{}", encode(&base_key.serialize()));
        if !self.used_kyber_base_keys.insert(replay_key) {
            return Err(SignalProtocolError::InvalidMessage(
                CiphertextMessageType::PreKey,
                "reused PQXDH base key".into(),
            ));
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl SessionStore for SignalStoreState {
    async fn load_session(&self, address: &ProtocolAddress) -> SignalResult<Option<SessionRecord>> {
        self.sessions
            .get(&address_key(address))
            .map(|value| SessionRecord::deserialize(&decode(value)?))
            .transpose()
    }

    async fn store_session(
        &mut self,
        address: &ProtocolAddress,
        record: &SessionRecord,
    ) -> SignalResult<()> {
        self.sessions
            .insert(address_key(address), encode(&record.serialize()?));
        Ok(())
    }
}
