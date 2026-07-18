#![forbid(unsafe_code)]

mod event_bus;
mod object_store;
mod persistence;
mod rate_limit;

use std::{
    collections::{HashMap, HashSet},
    env,
    net::IpAddr,
    sync::Arc,
    time::{Duration, SystemTime},
};

use axum::{
    Json, Router,
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post, put},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use event_bus::EventBus;
use object_store::ObjectStore;
use persistence::Persistence;
use rate_limit::RateLimiter;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, broadcast};
use tower_http::limit::RequestBodyLimitLayer;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

const PROTOCOL_VERSION: u8 = 1;
const MAX_ENVELOPE_BYTES: usize = 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_BACKUP_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
struct AppState {
    inner: Arc<Mutex<Store>>,
    events: EventBus,
    persistence: Option<Persistence>,
    object_store: Option<ObjectStore>,
    rate_limiter: Option<RateLimiter>,
}

#[derive(Default)]
struct Store {
    accounts: HashMap<String, AccountIdentity>,
    devices: HashMap<Uuid, DeviceRecord>,
    challenges: HashMap<Uuid, Challenge>,
    recovery_challenges: HashMap<Uuid, RecoveryChallenge>,
    sessions: HashMap<[u8; 32], Session>,
    recovery_sessions: HashMap<[u8; 32], RecoverySession>,
    envelopes: HashMap<Uuid, Vec<EncryptedEnvelope>>,
    idempotency: HashMap<String, u64>,
    last_sequence: HashMap<(Uuid, Uuid), u64>,
    backups: HashMap<String, EncryptedBackup>,
    attachments: HashMap<Uuid, AttachmentObject>,
    abuse_reports: HashMap<Uuid, AbuseReport>,
    blocks: HashSet<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountIdentity {
    protocol_version: u8,
    username: String,
    signing_public_key: String,
    recovery_public_key: String,
    recovery_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRecord {
    protocol_version: u8,
    device_id: Uuid,
    username: String,
    signing_public_key: String,
    #[serde(default = "initial_prekey_version")]
    prekey_version: u64,
    prekey_bundle: String,
    authorization_signature: String,
    created_at: u64,
    revoked_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedEnvelope {
    protocol_version: u8,
    envelope_id: Uuid,
    sender_device_id: Uuid,
    recipient_device_id: Uuid,
    conversation_id: Uuid,
    sequence: u64,
    expires_at: u64,
    ciphertext: String,
    signature: String,
    idempotency_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChallengeResponse {
    challenge_id: Uuid,
    challenge: String,
    expires_at: u64,
}

#[derive(Debug)]
struct Challenge {
    device_id: Uuid,
    bytes: [u8; 32],
    expires_at: u64,
    consumed: bool,
}

#[derive(Debug)]
struct RecoveryChallenge {
    username: String,
    bytes: [u8; 32],
    expires_at: u64,
    consumed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyChallenge {
    challenge_id: Uuid,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyRecoveryChallenge {
    challenge_id: Uuid,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreKeyUpdate {
    protocol_version: u8,
    prekey_version: u64,
    prekey_bundle: String,
    updated_at: u64,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnboardingRequest {
    account: AccountIdentity,
    device: DeviceRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthSessionResponse {
    access_token: String,
    device_id: Uuid,
    expires_at: u64,
}

#[derive(Debug)]
struct Session {
    device_id: Uuid,
    expires_at: u64,
}

#[derive(Debug)]
struct RecoverySession {
    username: String,
    expires_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryResponse {
    account: AccountIdentity,
    devices: Vec<DeviceRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedBackup {
    protocol_version: u8,
    version: u64,
    previous_digest: Option<String>,
    ciphertext: String,
    ciphertext_digest: String,
    created_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryBackupResponse {
    account: AccountIdentity,
    backup: EncryptedBackup,
}

#[derive(Debug, Clone)]
struct AttachmentObject {
    owner_device_id: Uuid,
    chunk_count: u32,
    ciphertext_size: u64,
    expires_at: u64,
    chunks: HashMap<u32, AttachmentChunk>,
    finalized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentChunk {
    ciphertext: String,
    ciphertext_digest: String,
    #[serde(default, skip_serializing)]
    ciphertext_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AbuseReport {
    protocol_version: u8,
    report_id: Uuid,
    reporter_device_id: Uuid,
    reported_username: String,
    disclosed_message_bundle: String,
    context: String,
    created_at: u64,
    reporter_signature: String,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAbuseReport {
    protocol_version: u8,
    report_id: Uuid,
    reported_username: String,
    disclosed_message_bundle: String,
    context: String,
    created_at: u64,
    reporter_signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAttachment {
    protocol_version: u8,
    object_id: Uuid,
    chunk_count: u32,
    ciphertext_size: u64,
    expires_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentManifest {
    protocol_version: u8,
    object_id: Uuid,
    chunk_count: u32,
    ciphertext_size: u64,
    chunk_digests: Vec<String>,
    expires_at: u64,
}

#[tokio::main]
async fn main() {
    if env::args().any(|argument| argument == "--healthcheck") {
        let host = match env::var("COVECHAT_API_HOST").as_deref() {
            Ok("0.0.0.0" | "::") | Err(_) => "127.0.0.1".to_string(),
            Ok(value) => value.to_string(),
        };
        let port = env::var("COVECHAT_API_PORT").unwrap_or_else(|_| "8080".into());
        std::process::exit(
            if tokio::net::TcpStream::connect(format!("{host}:{port}"))
                .await
                .is_ok()
            {
                0
            } else {
                1
            },
        );
    }
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "covechat_api=info".into()),
        )
        .init();
    let persistence = Persistence::connect_from_env()
        .await
        .expect("initialize PostgreSQL persistence");
    let store = match &persistence {
        Some(database) => {
            tracing::info!("PostgreSQL persistence enabled");
            database.hydrate().await.expect("hydrate durable state")
        }
        None => {
            tracing::warn!("DATABASE_URL is unset; using ephemeral development storage");
            Store::default()
        }
    };
    let object_store = ObjectStore::connect_from_env()
        .await
        .expect("initialize S3-compatible object storage");
    if object_store.is_some() {
        tracing::info!("S3-compatible attachment storage enabled");
    } else {
        tracing::warn!(
            "S3_ENDPOINT is unset; attachment ciphertext uses PostgreSQL development fallback"
        );
    }
    let rate_limiter = RateLimiter::connect_from_env()
        .await
        .expect("initialize Redis rate limiter");
    if rate_limiter.is_some() {
        tracing::info!("Redis distributed rate limiting enabled");
    } else {
        tracing::warn!("REDIS_URL is unset; distributed rate limiting is disabled");
    }
    let events = EventBus::connect_from_env()
        .await
        .expect("initialize mailbox event bus");
    if events.distributed() {
        tracing::info!("Redis cross-instance mailbox events enabled");
    } else {
        tracing::warn!("REDIS_URL is unset; mailbox events are process-local");
    }
    let state = AppState {
        inner: Arc::new(Mutex::new(store)),
        events,
        persistence,
        object_store,
        rate_limiter,
    };
    tokio::spawn(cleanup_loop(state.clone()));
    let app = router(state);
    let host: IpAddr = env::var("COVECHAT_API_HOST")
        .unwrap_or_else(|_| "127.0.0.1".into())
        .parse()
        .expect("COVECHAT_API_HOST must be an IP address");
    let port: u16 = env::var("COVECHAT_API_PORT")
        .unwrap_or_else(|_| "8080".into())
        .parse()
        .expect("COVECHAT_API_PORT must be a valid port");
    let listener = tokio::net::TcpListener::bind((host, port))
        .await
        .expect("bind API");
    tracing::info!(%host, port, "API listening");
    axum::serve(listener, app).await.expect("serve API");
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/onboarding", post(onboard_account))
        .route("/v1/devices", get(list_devices).post(register_device))
        .route("/v1/devices/{device_id}/prekeys", put(update_prekeys))
        .route("/v1/devices/{device_id}/revoke", post(revoke_device))
        .route("/v1/auth/challenges/{device_id}", post(create_challenge))
        .route("/v1/auth/verify", post(verify_challenge))
        .route(
            "/v1/recovery/challenges/{username}",
            post(create_recovery_challenge),
        )
        .route("/v1/recovery/verify", post(verify_recovery_challenge))
        .route(
            "/v1/recovery/backups/latest",
            get(read_latest_backup_with_recovery),
        )
        .route("/v1/recovery/devices", post(register_recovered_device))
        .route("/v1/directory/{username}", get(read_directory))
        .route("/v1/backups/latest", get(read_latest_backup))
        .route("/v1/backups", put(store_backup))
        .route("/v1/reports", post(create_abuse_report))
        .route("/v1/blocks", get(list_blocks))
        .route(
            "/v1/blocks/{username}",
            post(block_user).delete(unblock_user),
        )
        .route("/v1/attachments", post(create_attachment))
        .route(
            "/v1/attachments/{object_id}",
            get(read_attachment_manifest).delete(delete_attachment),
        )
        .route(
            "/v1/attachments/{object_id}/chunks/{chunk_index}",
            put(store_attachment_chunk).get(read_attachment_chunk),
        )
        .route(
            "/v1/attachments/{object_id}/finalize",
            post(finalize_attachment),
        )
        .route("/v1/envelopes", post(store_envelope))
        .route("/v1/mailboxes/{device_id}", get(read_mailbox))
        .route(
            "/v1/mailboxes/{device_id}/envelopes/{envelope_id}",
            delete(acknowledge_envelope),
        )
        .route("/v1/events/{device_id}", get(events))
        .layer(RequestBodyLimitLayer::new(MAX_REQUEST_BYTES))
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "securityStatus": "experimental-unaudited",
        "plaintextAccepted": false
    }))
}

async fn create_abuse_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateAbuseReport>,
) -> StatusCode {
    if input.protocol_version != PROTOCOL_VERSION
        || !valid_username(&input.reported_username)
        || input.disclosed_message_bundle.is_empty()
        || input.disclosed_message_bundle.len() > 64 * 1024
        || input.context.len() > 4 * 1024
        || input.created_at > unix_now() + 300
        || unix_now().saturating_sub(input.created_at) > 24 * 60 * 60
    {
        return StatusCode::BAD_REQUEST;
    }
    let reporter_device_id =
        match authenticated_rate_limit(&state, &headers, "reports", 5, 60 * 60).await {
            Ok(device_id) => device_id,
            Err(status) => return status,
        };
    let mut store = state.inner.lock().await;
    let Some(device) = store.devices.get(&reporter_device_id) else {
        return StatusCode::UNAUTHORIZED;
    };
    let Ok(payload) = serde_json::to_vec(&(
        input.protocol_version,
        input.report_id,
        &input.reported_username,
        &input.disclosed_message_bundle,
        &input.context,
        input.created_at,
    )) else {
        return StatusCode::BAD_REQUEST;
    };
    if !verify_signature(
        &device.signing_public_key,
        &payload,
        &input.reporter_signature,
    ) {
        return StatusCode::UNAUTHORIZED;
    }
    if store.abuse_reports.contains_key(&input.report_id) {
        return StatusCode::CONFLICT;
    }
    let report = AbuseReport {
        protocol_version: input.protocol_version,
        report_id: input.report_id,
        reporter_device_id,
        reported_username: input.reported_username,
        disclosed_message_bundle: input.disclosed_message_bundle,
        context: input.context,
        created_at: input.created_at,
        reporter_signature: input.reporter_signature,
        status: "received".into(),
    };
    store.abuse_reports.insert(input.report_id, report.clone());
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.insert_abuse_report(&report).await
    {
        state
            .inner
            .lock()
            .await
            .abuse_reports
            .remove(&report.report_id);
        tracing::error!(error = %error, "persist abuse report");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::CREATED
}

async fn list_blocks(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, Json<Vec<String>>) {
    let mut store = state.inner.lock().await;
    let Some(device_id) = authenticated_device(&headers, &mut store) else {
        return (StatusCode::UNAUTHORIZED, Json(Vec::new()));
    };
    let Some(username) = store
        .devices
        .get(&device_id)
        .map(|device| device.username.clone())
    else {
        return (StatusCode::UNAUTHORIZED, Json(Vec::new()));
    };
    let mut blocked = store
        .blocks
        .iter()
        .filter(|(blocker, _)| blocker == &username)
        .map(|(_, blocked)| blocked.clone())
        .collect::<Vec<_>>();
    blocked.sort();
    (StatusCode::OK, Json(blocked))
}

async fn block_user(
    State(state): State<AppState>,
    Path(blocked_username): Path<String>,
    headers: HeaderMap,
) -> StatusCode {
    set_block(state, headers, blocked_username, true).await
}

async fn unblock_user(
    State(state): State<AppState>,
    Path(blocked_username): Path<String>,
    headers: HeaderMap,
) -> StatusCode {
    set_block(state, headers, blocked_username, false).await
}

async fn set_block(
    state: AppState,
    headers: HeaderMap,
    blocked_username: String,
    blocked: bool,
) -> StatusCode {
    if !valid_username(&blocked_username) {
        return StatusCode::BAD_REQUEST;
    }
    let mut store = state.inner.lock().await;
    let Some(device_id) = authenticated_device(&headers, &mut store) else {
        return StatusCode::UNAUTHORIZED;
    };
    let Some(username) = store
        .devices
        .get(&device_id)
        .map(|device| device.username.clone())
    else {
        return StatusCode::UNAUTHORIZED;
    };
    if username == blocked_username {
        return StatusCode::BAD_REQUEST;
    }
    let pair = (username.clone(), blocked_username.clone());
    let previously_blocked = store.blocks.contains(&pair);
    if blocked {
        store.blocks.insert(pair.clone());
    } else {
        store.blocks.remove(&pair);
    }
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database
            .set_user_block(&username, &blocked_username, blocked)
            .await
    {
        let mut store = state.inner.lock().await;
        if previously_blocked {
            store.blocks.insert(pair);
        } else {
            store.blocks.remove(&pair);
        }
        tracing::error!(error = %error, "persist user block");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

async fn onboard_account(
    State(state): State<AppState>,
    Json(input): Json<OnboardingRequest>,
) -> StatusCode {
    let account = input.account;
    let device = input.device;
    if account.protocol_version != PROTOCOL_VERSION
        || device.protocol_version != PROTOCOL_VERSION
        || account.username != device.username
        || !valid_username(&account.username)
        || decode_key(&account.signing_public_key).is_none()
        || decode_key(&account.recovery_public_key).is_none()
        || decode_key(&device.signing_public_key).is_none()
        || device.prekey_version != 1
        || device.prekey_bundle.is_empty()
        || device.prekey_bundle.len() > 256_000
        || !verify_device_authorization(&account, &device)
    {
        return StatusCode::BAD_REQUEST;
    }
    let mut store = state.inner.lock().await;
    if store.accounts.contains_key(&account.username)
        || store.devices.contains_key(&device.device_id)
    {
        return StatusCode::CONFLICT;
    }
    store
        .accounts
        .insert(account.username.clone(), account.clone());
    store.devices.insert(device.device_id, device.clone());
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.onboard(&account, &device).await
    {
        let mut store = state.inner.lock().await;
        store.accounts.remove(&account.username);
        store.devices.remove(&device.device_id);
        tracing::error!(error = %error, "persist onboarding");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::CREATED
}

async fn register_device(
    State(state): State<AppState>,
    Json(device): Json<DeviceRecord>,
) -> StatusCode {
    if device.protocol_version != PROTOCOL_VERSION
        || decode_key(&device.signing_public_key).is_none()
        || device.prekey_version != 1
        || device.prekey_bundle.is_empty()
        || device.prekey_bundle.len() > 256_000
    {
        return StatusCode::BAD_REQUEST;
    }
    let mut store = state.inner.lock().await;
    let Some(account) = store.accounts.get(&device.username) else {
        return StatusCode::NOT_FOUND;
    };
    if !verify_device_authorization(account, &device) {
        return StatusCode::UNAUTHORIZED;
    }
    if store.devices.contains_key(&device.device_id) {
        return StatusCode::CONFLICT;
    }
    store.devices.insert(device.device_id, device.clone());
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.insert_device(&device).await
    {
        state.inner.lock().await.devices.remove(&device.device_id);
        tracing::error!(error = %error, "persist device");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::CREATED
}

async fn update_prekeys(
    State(state): State<AppState>,
    Path(device_id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<PreKeyUpdate>,
) -> StatusCode {
    let now = unix_now();
    if input.protocol_version != PROTOCOL_VERSION
        || input.prekey_bundle.is_empty()
        || input.prekey_bundle.len() > 256_000
        || input.updated_at.abs_diff(now) > 300
    {
        return StatusCode::BAD_REQUEST;
    }
    let mut store = state.inner.lock().await;
    if authenticated_device(&headers, &mut store) != Some(device_id) {
        return StatusCode::UNAUTHORIZED;
    }
    let Some(device) = store.devices.get_mut(&device_id) else {
        return StatusCode::NOT_FOUND;
    };
    if device.revoked_at.is_some() || input.prekey_version != device.prekey_version + 1 {
        return StatusCode::CONFLICT;
    }
    let Ok(payload) = serde_json::to_vec(&(
        input.protocol_version,
        device_id,
        input.prekey_version,
        &input.prekey_bundle,
        input.updated_at,
    )) else {
        return StatusCode::BAD_REQUEST;
    };
    if !verify_signature(&device.signing_public_key, &payload, &input.signature) {
        return StatusCode::UNAUTHORIZED;
    }
    let previous = device.clone();
    device.prekey_version = input.prekey_version;
    device.prekey_bundle = input.prekey_bundle;
    let updated = device.clone();
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.update_device(&updated).await
    {
        state.inner.lock().await.devices.insert(device_id, previous);
        tracing::error!(error = %error, "persist pre-key update");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

async fn revoke_device(
    State(state): State<AppState>,
    Path(device_id): Path<Uuid>,
    headers: HeaderMap,
) -> StatusCode {
    let mut store = state.inner.lock().await;
    let Some(caller_id) = authenticated_device(&headers, &mut store) else {
        return StatusCode::UNAUTHORIZED;
    };
    let Some(caller_username) = store
        .devices
        .get(&caller_id)
        .map(|device| device.username.clone())
    else {
        return StatusCode::UNAUTHORIZED;
    };
    let Some(target) = store.devices.get_mut(&device_id) else {
        return StatusCode::NOT_FOUND;
    };
    if target.username != caller_username {
        return StatusCode::FORBIDDEN;
    }
    let previous = target.clone();
    target.revoked_at = Some(unix_now());
    let updated = target.clone();
    store
        .sessions
        .retain(|_, session| session.device_id != device_id);
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.update_device(&updated).await
    {
        state.inner.lock().await.devices.insert(device_id, previous);
        tracing::error!(error = %error, "persist device revocation");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

async fn list_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, Json<Vec<DeviceRecord>>) {
    let mut store = state.inner.lock().await;
    let Some(caller_id) = authenticated_device(&headers, &mut store) else {
        return (StatusCode::UNAUTHORIZED, Json(Vec::new()));
    };
    let Some(username) = store
        .devices
        .get(&caller_id)
        .map(|device| device.username.clone())
    else {
        return (StatusCode::UNAUTHORIZED, Json(Vec::new()));
    };
    let mut devices = store
        .devices
        .values()
        .filter(|device| device.username == username)
        .cloned()
        .collect::<Vec<_>>();
    devices.sort_by_key(|device| device.created_at);
    (StatusCode::OK, Json(devices))
}

async fn create_challenge(
    State(state): State<AppState>,
    Path(device_id): Path<Uuid>,
) -> (StatusCode, Json<Option<ChallengeResponse>>) {
    let mut store = state.inner.lock().await;
    let Some(device) = store.devices.get(&device_id) else {
        return (StatusCode::NOT_FOUND, Json(None));
    };
    if device.revoked_at.is_some() {
        return (StatusCode::FORBIDDEN, Json(None));
    }
    let mut bytes = [0_u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(None));
    }
    let challenge_id = Uuid::new_v4();
    let expires_at = unix_now() + 120;
    store.challenges.insert(
        challenge_id,
        Challenge {
            device_id,
            bytes,
            expires_at,
            consumed: false,
        },
    );
    (
        StatusCode::CREATED,
        Json(Some(ChallengeResponse {
            challenge_id,
            challenge: URL_SAFE_NO_PAD.encode(bytes),
            expires_at,
        })),
    )
}

async fn verify_challenge(
    State(state): State<AppState>,
    Json(input): Json<VerifyChallenge>,
) -> (StatusCode, Json<Option<AuthSessionResponse>>) {
    let mut store = state.inner.lock().await;
    let Some(challenge) = store.challenges.get(&input.challenge_id) else {
        return (StatusCode::UNAUTHORIZED, Json(None));
    };
    if challenge.consumed || challenge.expires_at < unix_now() {
        return (StatusCode::UNAUTHORIZED, Json(None));
    }
    let (device_id, bytes) = (challenge.device_id, challenge.bytes);
    let Some(device) = store.devices.get(&device_id) else {
        return (StatusCode::UNAUTHORIZED, Json(None));
    };
    if !verify_signature(&device.signing_public_key, &bytes, &input.signature) {
        return (StatusCode::UNAUTHORIZED, Json(None));
    }
    store
        .challenges
        .get_mut(&input.challenge_id)
        .unwrap()
        .consumed = true;
    let mut token = [0_u8; 32];
    if getrandom::fill(&mut token).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(None));
    }
    let expires_at = unix_now() + 3600;
    store.sessions.insert(
        Sha256::digest(token).into(),
        Session {
            device_id,
            expires_at,
        },
    );
    (
        StatusCode::CREATED,
        Json(Some(AuthSessionResponse {
            access_token: URL_SAFE_NO_PAD.encode(token),
            device_id,
            expires_at,
        })),
    )
}

async fn create_recovery_challenge(
    State(state): State<AppState>,
    Path(username): Path<String>,
) -> (StatusCode, Json<Option<ChallengeResponse>>) {
    let mut store = state.inner.lock().await;
    if !store.accounts.contains_key(&username) {
        return (StatusCode::NOT_FOUND, Json(None));
    }
    let mut bytes = [0_u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(None));
    }
    let challenge_id = Uuid::new_v4();
    let expires_at = unix_now() + 120;
    store.recovery_challenges.insert(
        challenge_id,
        RecoveryChallenge {
            username,
            bytes,
            expires_at,
            consumed: false,
        },
    );
    (
        StatusCode::CREATED,
        Json(Some(ChallengeResponse {
            challenge_id,
            challenge: URL_SAFE_NO_PAD.encode(bytes),
            expires_at,
        })),
    )
}

async fn verify_recovery_challenge(
    State(state): State<AppState>,
    Json(input): Json<VerifyRecoveryChallenge>,
) -> impl IntoResponse {
    let mut store = state.inner.lock().await;
    let Some(challenge) = store.recovery_challenges.get(&input.challenge_id) else {
        return (StatusCode::UNAUTHORIZED, Json(None));
    };
    if challenge.consumed || challenge.expires_at < unix_now() {
        return (StatusCode::UNAUTHORIZED, Json(None));
    }
    let (username, bytes) = (challenge.username.clone(), challenge.bytes);
    let Some(account) = store.accounts.get(&username) else {
        return (StatusCode::UNAUTHORIZED, Json(None));
    };
    if !verify_signature(&account.recovery_public_key, &bytes, &input.signature) {
        return (StatusCode::UNAUTHORIZED, Json(None));
    }
    store
        .recovery_challenges
        .get_mut(&input.challenge_id)
        .unwrap()
        .consumed = true;
    let mut token = [0_u8; 32];
    if getrandom::fill(&mut token).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(None));
    }
    let expires_at = unix_now() + 600;
    store.recovery_sessions.insert(
        Sha256::digest(token).into(),
        RecoverySession {
            username,
            expires_at,
        },
    );
    (
        StatusCode::CREATED,
        Json(Some(serde_json::json!({
            "accessToken": URL_SAFE_NO_PAD.encode(token),
            "expiresAt": expires_at
        }))),
    )
}

async fn store_envelope(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(envelope): Json<EncryptedEnvelope>,
) -> StatusCode {
    if headers
        .get("x-idempotency-key")
        .and_then(|v| v.to_str().ok())
        != Some(envelope.idempotency_key.as_str())
        || envelope.protocol_version != PROTOCOL_VERSION
        || envelope.expires_at <= unix_now()
        || envelope.ciphertext.is_empty()
        || envelope.ciphertext.len() > MAX_ENVELOPE_BYTES
        || envelope.signature.is_empty()
    {
        return StatusCode::BAD_REQUEST;
    }
    let authenticated = match authenticated_rate_limit(&state, &headers, "envelopes", 120, 60).await
    {
        Ok(device_id) => device_id,
        Err(status) => return status,
    };
    if authenticated != envelope.sender_device_id {
        return StatusCode::UNAUTHORIZED;
    }
    let mut store = state.inner.lock().await;
    let Some(sender) = store.devices.get(&envelope.sender_device_id) else {
        return StatusCode::UNAUTHORIZED;
    };
    if sender.revoked_at.is_some() || !verify_envelope_signature(sender, &envelope) {
        return StatusCode::UNAUTHORIZED;
    }
    let Some(recipient_device) = store.devices.get(&envelope.recipient_device_id) else {
        return StatusCode::NOT_FOUND;
    };
    if recipient_device.revoked_at.is_some() {
        return StatusCode::GONE;
    }
    if store
        .blocks
        .contains(&(recipient_device.username.clone(), sender.username.clone()))
    {
        return StatusCode::FORBIDDEN;
    }
    let sequence_key = (envelope.sender_device_id, envelope.conversation_id);
    if store
        .last_sequence
        .get(&sequence_key)
        .is_some_and(|last| envelope.sequence <= *last)
    {
        return StatusCode::CONFLICT;
    }
    let now = unix_now();
    store.idempotency.retain(|_, expires_at| *expires_at > now);
    if store.idempotency.contains_key(&envelope.idempotency_key) {
        return StatusCode::CONFLICT;
    }
    let previous_sequence = store.last_sequence.get(&sequence_key).copied();
    store
        .idempotency
        .insert(envelope.idempotency_key.clone(), envelope.expires_at);
    store.last_sequence.insert(sequence_key, envelope.sequence);
    let recipient = envelope.recipient_device_id;
    store
        .envelopes
        .entry(recipient)
        .or_default()
        .push(envelope.clone());
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.insert_envelope(&envelope).await
    {
        let mut store = state.inner.lock().await;
        store
            .envelopes
            .entry(recipient)
            .or_default()
            .retain(|item| item.envelope_id != envelope.envelope_id);
        store.idempotency.remove(&envelope.idempotency_key);
        match previous_sequence {
            Some(value) => {
                store.last_sequence.insert(sequence_key, value);
            }
            None => {
                store.last_sequence.remove(&sequence_key);
            }
        }
        tracing::error!(error = %error, "persist envelope");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    if let Err(error) = state.events.publish(recipient).await {
        tracing::error!(error = %error, "publish mailbox event");
    }
    StatusCode::ACCEPTED
}

async fn read_directory(
    State(state): State<AppState>,
    Path(username): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let mut store = state.inner.lock().await;
    if authenticated_device(&headers, &mut store).is_none() {
        return (StatusCode::UNAUTHORIZED, Json(None));
    }
    let Some(account) = store.accounts.get(&username).cloned() else {
        return (StatusCode::NOT_FOUND, Json(None));
    };
    let devices = store
        .devices
        .values()
        .filter(|device| device.username == username && device.revoked_at.is_none())
        .cloned()
        .collect();
    (
        StatusCode::OK,
        Json(Some(DirectoryResponse { account, devices })),
    )
}

async fn store_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(backup): Json<EncryptedBackup>,
) -> StatusCode {
    if backup.protocol_version != PROTOCOL_VERSION
        || backup.version == 0
        || backup.ciphertext.is_empty()
        || backup.ciphertext.len() > MAX_BACKUP_BYTES
        || backup.created_at > unix_now() + 300
        || digest_text(&backup.ciphertext) != backup.ciphertext_digest
    {
        return StatusCode::BAD_REQUEST;
    }
    let mut store = state.inner.lock().await;
    let Some(device_id) = authenticated_device(&headers, &mut store) else {
        return StatusCode::UNAUTHORIZED;
    };
    let Some(username) = store
        .devices
        .get(&device_id)
        .map(|device| device.username.clone())
    else {
        return StatusCode::UNAUTHORIZED;
    };
    match store.backups.get(&username) {
        None if backup.version != 1 || backup.previous_digest.is_some() => {
            return StatusCode::CONFLICT;
        }
        Some(previous)
            if backup.version != previous.version + 1
                || backup.previous_digest.as_deref() != Some(&previous.ciphertext_digest) =>
        {
            return StatusCode::CONFLICT;
        }
        _ => {}
    }
    let previous = store.backups.insert(username.clone(), backup.clone());
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.upsert_backup(&username, &backup).await
    {
        let mut store = state.inner.lock().await;
        if let Some(previous) = previous {
            store.backups.insert(username, previous);
        } else {
            store.backups.remove(&username);
        }
        tracing::error!(error = %error, "persist backup");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

async fn read_latest_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let mut store = state.inner.lock().await;
    let Some(device_id) = authenticated_device(&headers, &mut store) else {
        return (StatusCode::UNAUTHORIZED, Json(None));
    };
    let Some(username) = store
        .devices
        .get(&device_id)
        .map(|device| device.username.clone())
    else {
        return (StatusCode::UNAUTHORIZED, Json(None));
    };
    match store.backups.get(&username).cloned() {
        Some(backup) => (StatusCode::OK, Json(Some(backup))),
        None => (StatusCode::NOT_FOUND, Json(None)),
    }
}

async fn create_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateAttachment>,
) -> StatusCode {
    if input.protocol_version != PROTOCOL_VERSION
        || input.chunk_count == 0
        || input.chunk_count > 1024
        || input.ciphertext_size == 0
        || input.ciphertext_size > 100 * 1024 * 1024
        || input.expires_at <= unix_now()
    {
        return StatusCode::BAD_REQUEST;
    }
    let mut store = state.inner.lock().await;
    let Some(owner_device_id) = authenticated_device(&headers, &mut store) else {
        return StatusCode::UNAUTHORIZED;
    };
    if store.attachments.contains_key(&input.object_id) {
        return StatusCode::CONFLICT;
    }
    let object = AttachmentObject {
        owner_device_id,
        chunk_count: input.chunk_count,
        ciphertext_size: input.ciphertext_size,
        expires_at: input.expires_at,
        chunks: HashMap::new(),
        finalized: false,
    };
    store.attachments.insert(input.object_id, object.clone());
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.insert_attachment(input.object_id, &object).await
    {
        state
            .inner
            .lock()
            .await
            .attachments
            .remove(&input.object_id);
        tracing::error!(error = %error, "persist attachment");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::CREATED
}

async fn store_attachment_chunk(
    State(state): State<AppState>,
    Path((object_id, chunk_index)): Path<(Uuid, u32)>,
    headers: HeaderMap,
    Json(mut chunk): Json<AttachmentChunk>,
) -> StatusCode {
    if chunk.ciphertext.is_empty()
        || chunk.ciphertext.len() > 8 * 1024 * 1024
        || digest_text(&chunk.ciphertext) != chunk.ciphertext_digest
    {
        return StatusCode::BAD_REQUEST;
    }
    chunk.ciphertext_size = chunk.ciphertext.len() as u64;
    let mut store = state.inner.lock().await;
    let Some(device_id) = authenticated_device(&headers, &mut store) else {
        return StatusCode::UNAUTHORIZED;
    };
    let Some(object) = store.attachments.get_mut(&object_id) else {
        return StatusCode::NOT_FOUND;
    };
    if object.owner_device_id != device_id {
        return StatusCode::FORBIDDEN;
    }
    if object.finalized || object.expires_at <= unix_now() || chunk_index >= object.chunk_count {
        return StatusCode::CONFLICT;
    }
    if let Some(existing) = object.chunks.get(&chunk_index) {
        return if existing.ciphertext_digest == chunk.ciphertext_digest {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::CONFLICT
        };
    }
    object.chunks.insert(chunk_index, chunk.clone());
    drop(store);
    if let Some(objects) = &state.object_store
        && let Err(error) = objects
            .put_chunk(
                object_id,
                chunk_index,
                &chunk.ciphertext,
                &chunk.ciphertext_digest,
            )
            .await
    {
        state
            .inner
            .lock()
            .await
            .attachments
            .get_mut(&object_id)
            .unwrap()
            .chunks
            .remove(&chunk_index);
        tracing::error!(error = %error, "store S3 attachment chunk");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    if let Some(database) = &state.persistence
        && let Err(error) = database
            .insert_attachment_chunk(object_id, chunk_index, &chunk, state.object_store.is_none())
            .await
    {
        if let Some(objects) = &state.object_store {
            let _ = objects.delete_chunk(object_id, chunk_index).await;
        }
        if let Some(object) = state.inner.lock().await.attachments.get_mut(&object_id) {
            object.chunks.remove(&chunk_index);
        }
        tracing::error!(error = %error, "persist attachment chunk");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

async fn finalize_attachment(
    State(state): State<AppState>,
    Path(object_id): Path<Uuid>,
    headers: HeaderMap,
) -> StatusCode {
    let mut store = state.inner.lock().await;
    let Some(device_id) = authenticated_device(&headers, &mut store) else {
        return StatusCode::UNAUTHORIZED;
    };
    let Some(object) = store.attachments.get_mut(&object_id) else {
        return StatusCode::NOT_FOUND;
    };
    if object.owner_device_id != device_id {
        return StatusCode::FORBIDDEN;
    }
    if object.expires_at <= unix_now()
        || object.chunks.len() != object.chunk_count as usize
        || (0..object.chunk_count).any(|index| !object.chunks.contains_key(&index))
        || object
            .chunks
            .values()
            .map(|chunk| chunk.ciphertext_size)
            .sum::<u64>()
            != object.ciphertext_size
    {
        return StatusCode::CONFLICT;
    }
    object.finalized = true;
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.finalize_attachment(object_id).await
    {
        state
            .inner
            .lock()
            .await
            .attachments
            .get_mut(&object_id)
            .unwrap()
            .finalized = false;
        tracing::error!(error = %error, "persist attachment finalize");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

async fn read_attachment_manifest(
    State(state): State<AppState>,
    Path(object_id): Path<Uuid>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let mut store = state.inner.lock().await;
    if authenticated_device(&headers, &mut store).is_none() {
        return (StatusCode::UNAUTHORIZED, Json(None));
    }
    let Some(object) = store.attachments.get(&object_id) else {
        return (StatusCode::NOT_FOUND, Json(None));
    };
    if !object.finalized || object.expires_at <= unix_now() {
        return (StatusCode::NOT_FOUND, Json(None));
    }
    let chunk_digests = (0..object.chunk_count)
        .map(|index| object.chunks[&index].ciphertext_digest.clone())
        .collect();
    (
        StatusCode::OK,
        Json(Some(AttachmentManifest {
            protocol_version: PROTOCOL_VERSION,
            object_id,
            chunk_count: object.chunk_count,
            ciphertext_size: object.ciphertext_size,
            chunk_digests,
            expires_at: object.expires_at,
        })),
    )
}

async fn read_attachment_chunk(
    State(state): State<AppState>,
    Path((object_id, chunk_index)): Path<(Uuid, u32)>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let mut store = state.inner.lock().await;
    if authenticated_device(&headers, &mut store).is_none() {
        return (StatusCode::UNAUTHORIZED, Json(None));
    }
    let Some(object) = store.attachments.get(&object_id) else {
        return (StatusCode::NOT_FOUND, Json(None));
    };
    if !object.finalized || object.expires_at <= unix_now() {
        return (StatusCode::NOT_FOUND, Json(None));
    }
    let Some(mut chunk) = object.chunks.get(&chunk_index).cloned() else {
        return (StatusCode::NOT_FOUND, Json(None));
    };
    drop(store);
    if chunk.ciphertext.is_empty() {
        let Some(objects) = &state.object_store else {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(None));
        };
        match objects.get_chunk(object_id, chunk_index).await {
            Ok(ciphertext)
                if ciphertext.len() as u64 == chunk.ciphertext_size
                    && digest_text(&ciphertext) == chunk.ciphertext_digest =>
            {
                chunk.ciphertext = ciphertext;
            }
            Ok(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(None)),
            Err(error) => {
                tracing::error!(error = %error, "read S3 attachment chunk");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(None));
            }
        }
    }
    (StatusCode::OK, Json(Some(chunk)))
}

async fn delete_attachment(
    State(state): State<AppState>,
    Path(object_id): Path<Uuid>,
    headers: HeaderMap,
) -> StatusCode {
    let mut store = state.inner.lock().await;
    let Some(device_id) = authenticated_device(&headers, &mut store) else {
        return StatusCode::UNAUTHORIZED;
    };
    let Some(object) = store.attachments.get(&object_id) else {
        return StatusCode::NOT_FOUND;
    };
    if object.owner_device_id != device_id {
        return StatusCode::FORBIDDEN;
    }
    let removed = store.attachments.remove(&object_id).unwrap();
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.delete_attachment(object_id).await
    {
        state
            .inner
            .lock()
            .await
            .attachments
            .insert(object_id, removed);
        tracing::error!(error = %error, "persist attachment delete");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    if let Some(objects) = &state.object_store
        && let Err(error) = objects
            .delete_attachment(object_id, removed.chunk_count)
            .await
    {
        tracing::error!(error = %error, "delete S3 attachment");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

async fn read_latest_backup_with_recovery(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let mut store = state.inner.lock().await;
    let Some(username) = authenticated_recovery(&headers, &mut store) else {
        return (StatusCode::UNAUTHORIZED, Json(None));
    };
    let Some(account) = store.accounts.get(&username).cloned() else {
        return (StatusCode::NOT_FOUND, Json(None));
    };
    match store.backups.get(&username).cloned() {
        Some(backup) => (
            StatusCode::OK,
            Json(Some(RecoveryBackupResponse { account, backup })),
        ),
        None => (StatusCode::NOT_FOUND, Json(None)),
    }
}

async fn register_recovered_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(device): Json<DeviceRecord>,
) -> StatusCode {
    let mut store = state.inner.lock().await;
    let Some(username) = authenticated_recovery(&headers, &mut store) else {
        return StatusCode::UNAUTHORIZED;
    };
    if device.protocol_version != PROTOCOL_VERSION
        || device.username != username
        || decode_key(&device.signing_public_key).is_none()
        || device.prekey_version != 1
        || device.prekey_bundle.is_empty()
        || device.prekey_bundle.len() > 256_000
    {
        return StatusCode::BAD_REQUEST;
    }
    let Some(account) = store.accounts.get(&username) else {
        return StatusCode::NOT_FOUND;
    };
    if !verify_device_authorization(account, &device) {
        return StatusCode::UNAUTHORIZED;
    }
    if store.devices.contains_key(&device.device_id) {
        return StatusCode::CONFLICT;
    }
    let previous_devices: Vec<_> = store
        .devices
        .values()
        .filter(|item| item.username == username && item.revoked_at.is_none())
        .cloned()
        .collect();
    let revoked_ids: HashSet<_> = previous_devices.iter().map(|item| item.device_id).collect();
    for id in &revoked_ids {
        store.devices.get_mut(id).unwrap().revoked_at = Some(unix_now());
    }
    let revoked_devices: Vec<_> = revoked_ids
        .iter()
        .map(|id| store.devices[id].clone())
        .collect();
    store
        .sessions
        .retain(|_, session| !revoked_ids.contains(&session.device_id));
    store.devices.insert(device.device_id, device.clone());
    store
        .recovery_sessions
        .retain(|_, session| session.username != username);
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.recover_device(&revoked_devices, &device).await
    {
        let mut store = state.inner.lock().await;
        store.devices.remove(&device.device_id);
        for previous in previous_devices {
            store.devices.insert(previous.device_id, previous);
        }
        tracing::error!(error = %error, "persist recovered device");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::CREATED
}

async fn read_mailbox(
    State(state): State<AppState>,
    Path(device_id): Path<Uuid>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let mut store = state.inner.lock().await;
    if authenticated_device(&headers, &mut store) != Some(device_id) {
        return (StatusCode::UNAUTHORIZED, Json(Vec::new()));
    }
    let now = unix_now();
    let messages = store.envelopes.entry(device_id).or_default();
    messages.retain(|item| item.expires_at > now);
    (StatusCode::OK, Json(messages.clone()))
}

async fn acknowledge_envelope(
    State(state): State<AppState>,
    Path((device_id, envelope_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> StatusCode {
    let mut store = state.inner.lock().await;
    if authenticated_device(&headers, &mut store) != Some(device_id) {
        return StatusCode::UNAUTHORIZED;
    }
    let Some(messages) = store.envelopes.get_mut(&device_id) else {
        return StatusCode::NOT_FOUND;
    };
    let Some(position) = messages
        .iter()
        .position(|item| item.envelope_id == envelope_id)
    else {
        return StatusCode::NOT_FOUND;
    };
    let removed = messages.remove(position);
    drop(store);
    if let Some(database) = &state.persistence
        && let Err(error) = database.delete_envelope(envelope_id).await
    {
        state
            .inner
            .lock()
            .await
            .envelopes
            .entry(device_id)
            .or_default()
            .insert(position, removed);
        tracing::error!(error = %error, "persist envelope acknowledgement");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

async fn events(
    State(state): State<AppState>,
    Path(device_id): Path<Uuid>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let mut store = state.inner.lock().await;
    if authenticated_websocket_device(&headers, &mut store) != Some(device_id) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    drop(store);
    ws.protocols(["covechat"])
        .on_upgrade(move |socket| event_socket(socket, state.events.subscribe(), device_id))
        .into_response()
}

async fn event_socket(
    mut socket: WebSocket,
    mut events: broadcast::Receiver<String>,
    device_id: Uuid,
) {
    while let Ok(target) = events.recv().await {
        if target == device_id.to_string()
            && socket
                .send(Message::Text("mailbox.changed".into()))
                .await
                .is_err()
        {
            break;
        }
    }
}

async fn cleanup_loop(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(60));
    loop {
        interval.tick().await;
        let now = unix_now();
        let expired = {
            let mut store = state.inner.lock().await;
            store.idempotency.retain(|_, expires_at| *expires_at > now);
            store.envelopes.values_mut().for_each(|messages| {
                messages.retain(|message| message.expires_at > now);
            });
            let expired: Vec<_> = store
                .attachments
                .iter()
                .filter(|(_, item)| item.expires_at <= now)
                .map(|(id, item)| (*id, item.chunk_count))
                .collect();
            store
                .attachments
                .retain(|_, attachment| attachment.expires_at > now);
            expired
        };
        if let Some(objects) = &state.object_store {
            for (object_id, chunk_count) in expired {
                if let Err(error) = objects.delete_attachment(object_id, chunk_count).await {
                    tracing::error!(error = %error, "clean expired S3 attachment");
                }
            }
        }
        if let Some(database) = &state.persistence
            && let Err(error) = database.cleanup_expired(now).await
        {
            tracing::error!(error = %error, "clean expired durable ciphertext");
        }
    }
}

fn valid_username(value: &str) -> bool {
    (3..=32).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

fn decode_key(value: &str) -> Option<VerifyingKey> {
    let bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(value).ok()?.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

fn verify_signature(public_key: &str, payload: &[u8], signature: &str) -> bool {
    let Some(key) = decode_key(public_key) else {
        return false;
    };
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&bytes) else {
        return false;
    };
    key.verify(payload, &signature).is_ok()
}

fn verify_device_authorization(account: &AccountIdentity, device: &DeviceRecord) -> bool {
    let Ok(payload) = serde_json::to_vec(&(
        device.protocol_version,
        device.device_id,
        &device.username,
        &device.signing_public_key,
        device.prekey_version,
        &device.prekey_bundle,
        device.created_at,
    )) else {
        return false;
    };
    verify_signature(
        &account.signing_public_key,
        &payload,
        &device.authorization_signature,
    )
}

fn verify_envelope_signature(sender: &DeviceRecord, envelope: &EncryptedEnvelope) -> bool {
    let Ok(payload) = serde_json::to_vec(&(
        envelope.protocol_version,
        envelope.envelope_id,
        envelope.sender_device_id,
        envelope.recipient_device_id,
        envelope.conversation_id,
        envelope.sequence,
        envelope.expires_at,
        &envelope.ciphertext,
        &envelope.idempotency_key,
    )) else {
        return false;
    };
    verify_signature(&sender.signing_public_key, &payload, &envelope.signature)
}

fn authenticated_device(headers: &HeaderMap, store: &mut Store) -> Option<Uuid> {
    let token = headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")?;
    authenticate_token(token, store)
}

async fn authenticated_rate_limit(
    state: &AppState,
    headers: &HeaderMap,
    scope: &str,
    limit: u64,
    window_seconds: u64,
) -> Result<Uuid, StatusCode> {
    let device_id = {
        let mut store = state.inner.lock().await;
        authenticated_device(headers, &mut store).ok_or(StatusCode::UNAUTHORIZED)?
    };
    if let Some(rate_limiter) = &state.rate_limiter {
        match rate_limiter
            .check(scope, &device_id.to_string(), limit, window_seconds)
            .await
        {
            Ok(true) => {}
            Ok(false) => return Err(StatusCode::TOO_MANY_REQUESTS),
            Err(error) => {
                tracing::error!(error = %error, scope, "Redis rate limit failure");
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            }
        }
    }
    Ok(device_id)
}

fn authenticated_websocket_device(headers: &HeaderMap, store: &mut Store) -> Option<Uuid> {
    let mut values = headers
        .get("sec-websocket-protocol")?
        .to_str()
        .ok()?
        .split(',')
        .map(str::trim);
    if values.next()? != "covechat" {
        return None;
    }
    authenticate_token(values.next()?, store)
}

fn authenticate_token(token: &str, store: &mut Store) -> Option<Uuid> {
    let bytes = URL_SAFE_NO_PAD.decode(token).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let now = unix_now();
    store.sessions.retain(|_, session| session.expires_at > now);
    let token_hash: [u8; 32] = Sha256::digest(bytes).into();
    let id = store.sessions.get(&token_hash)?.device_id;
    store.devices.get(&id)?.revoked_at.is_none().then_some(id)
}

fn authenticated_recovery(headers: &HeaderMap, store: &mut Store) -> Option<String> {
    let token = headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")?;
    let bytes = URL_SAFE_NO_PAD.decode(token).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let now = unix_now();
    store
        .recovery_sessions
        .retain(|_, session| session.expires_at > now);
    let token_hash: [u8; 32] = Sha256::digest(bytes).into();
    Some(store.recovery_sessions.get(&token_hash)?.username.clone())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

const fn initial_prekey_version() -> u64 {
    1
}

fn digest_text(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderValue, header::AUTHORIZATION};
    use ed25519_dalek::{Signer, SigningKey};

    fn account_and_device(username: &str) -> (AccountIdentity, DeviceRecord) {
        let account_key = SigningKey::from_bytes(&[7; 32]);
        let device_key = SigningKey::from_bytes(&[9; 32]);
        let account = AccountIdentity {
            protocol_version: 1,
            username: username.into(),
            signing_public_key: URL_SAFE_NO_PAD.encode(account_key.verifying_key().to_bytes()),
            recovery_public_key: URL_SAFE_NO_PAD
                .encode(SigningKey::from_bytes(&[11; 32]).verifying_key().to_bytes()),
            recovery_version: 1,
        };
        let mut device = DeviceRecord {
            protocol_version: 1,
            device_id: Uuid::new_v4(),
            username: username.into(),
            signing_public_key: URL_SAFE_NO_PAD.encode(device_key.verifying_key().to_bytes()),
            prekey_version: 1,
            prekey_bundle: "opaque".into(),
            authorization_signature: String::new(),
            created_at: 123,
            revoked_at: None,
        };
        let payload = serde_json::to_vec(&(
            device.protocol_version,
            device.device_id,
            &device.username,
            &device.signing_public_key,
            device.prekey_version,
            &device.prekey_bundle,
            device.created_at,
        ))
        .unwrap();
        device.authorization_signature =
            URL_SAFE_NO_PAD.encode(account_key.sign(&payload).to_bytes());
        (account, device)
    }

    fn authenticated_state(username: &str) -> (AppState, HeaderMap, Uuid) {
        let (account, device) = account_and_device(username);
        let device_id = device.device_id;
        let token = [3; 32];
        let mut store = Store::default();
        store.accounts.insert(username.to_string(), account);
        store.devices.insert(device_id, device);
        store.sessions.insert(
            Sha256::digest(token).into(),
            Session {
                device_id,
                expires_at: unix_now() + 60,
            },
        );
        let state = AppState {
            inner: Arc::new(Mutex::new(store)),
            events: EventBus::local(),
            persistence: None,
            object_store: None,
            rate_limiter: None,
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", URL_SAFE_NO_PAD.encode(token))).unwrap(),
        );
        (state, headers, device_id)
    }

    #[test]
    fn username_and_device_authorization_are_canonical() {
        assert!(valid_username("maya_chen"));
        assert!(!valid_username("../maya"));
        let (account, mut device) = account_and_device("maya_chen");
        assert!(verify_device_authorization(&account, &device));
        device.prekey_bundle.push('x');
        assert!(!verify_device_authorization(&account, &device));
    }

    #[tokio::test]
    async fn health_discloses_experimental_state() {
        let value = health().await.0;
        assert_eq!(value["plaintextAccepted"], false);
        assert_eq!(value["securityStatus"], "experimental-unaudited");
    }

    #[test]
    fn bearer_session_is_bound_to_active_device() {
        let (_, device) = account_and_device("maya_chen");
        let id = device.device_id;
        let token = [3; 32];
        let mut store = Store::default();
        store.devices.insert(id, device);
        store.sessions.insert(
            Sha256::digest(token).into(),
            Session {
                device_id: id,
                expires_at: unix_now() + 60,
            },
        );
        assert_eq!(
            authenticate_token(&URL_SAFE_NO_PAD.encode(token), &mut store),
            Some(id)
        );
        store.devices.get_mut(&id).unwrap().revoked_at = Some(unix_now());
        assert_eq!(
            authenticate_token(&URL_SAFE_NO_PAD.encode(token), &mut store),
            None
        );
    }

    #[tokio::test]
    async fn backup_chain_rejects_rollback_and_wrong_parent() {
        let (state, headers, _) = authenticated_state("maya_chen");
        let first_ciphertext = "encrypted-backup-v1".to_string();
        let first = EncryptedBackup {
            protocol_version: PROTOCOL_VERSION,
            version: 1,
            previous_digest: None,
            ciphertext_digest: digest_text(&first_ciphertext),
            ciphertext: first_ciphertext,
            created_at: unix_now(),
        };
        assert_eq!(
            store_backup(State(state.clone()), headers.clone(), Json(first.clone())).await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            store_backup(State(state.clone()), headers.clone(), Json(first)).await,
            StatusCode::CONFLICT
        );
        let second_ciphertext = "encrypted-backup-v2".to_string();
        let wrong_parent = EncryptedBackup {
            protocol_version: PROTOCOL_VERSION,
            version: 2,
            previous_digest: Some("wrong-parent".into()),
            ciphertext_digest: digest_text(&second_ciphertext),
            ciphertext: second_ciphertext,
            created_at: unix_now(),
        };
        assert_eq!(
            store_backup(State(state), headers, Json(wrong_parent)).await,
            StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn attachment_cannot_finalize_with_missing_chunks() {
        let (state, headers, _) = authenticated_state("maya_chen");
        let object_id = Uuid::new_v4();
        assert_eq!(
            create_attachment(
                State(state.clone()),
                headers.clone(),
                Json(CreateAttachment {
                    protocol_version: PROTOCOL_VERSION,
                    object_id,
                    chunk_count: 2,
                    ciphertext_size: 6,
                    expires_at: unix_now() + 60,
                }),
            )
            .await,
            StatusCode::CREATED
        );
        let ciphertext = "abc".to_string();
        assert_eq!(
            store_attachment_chunk(
                State(state.clone()),
                Path((object_id, 0)),
                headers.clone(),
                Json(AttachmentChunk {
                    ciphertext_digest: digest_text(&ciphertext),
                    ciphertext,
                    ciphertext_size: 0,
                }),
            )
            .await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            finalize_attachment(State(state), Path(object_id), headers).await,
            StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn acknowledgement_deletes_only_the_recipient_envelope() {
        let (state, headers, device_id) = authenticated_state("maya_chen");
        let envelope_id = Uuid::new_v4();
        let envelope = EncryptedEnvelope {
            protocol_version: PROTOCOL_VERSION,
            envelope_id,
            sender_device_id: Uuid::new_v4(),
            recipient_device_id: device_id,
            conversation_id: Uuid::new_v4(),
            sequence: 1,
            expires_at: unix_now() + 60,
            ciphertext: "opaque".into(),
            signature: "opaque".into(),
            idempotency_key: "idempotency".into(),
        };
        state
            .inner
            .lock()
            .await
            .envelopes
            .insert(device_id, vec![envelope]);
        assert_eq!(
            acknowledge_envelope(
                State(state.clone()),
                Path((device_id, envelope_id)),
                headers
            )
            .await,
            StatusCode::NO_CONTENT
        );
        assert!(state.inner.lock().await.envelopes[&device_id].is_empty());
    }

    #[tokio::test]
    async fn prekey_updates_are_signed_and_strictly_monotonic() {
        let (state, headers, device_id) = authenticated_state("maya_chen");
        let signing_key = SigningKey::from_bytes(&[9; 32]);
        let updated_at = unix_now();
        let bundle = "new-pqxdh-bundle".to_string();
        let payload =
            serde_json::to_vec(&(PROTOCOL_VERSION, device_id, 2_u64, &bundle, updated_at)).unwrap();
        let input = PreKeyUpdate {
            protocol_version: PROTOCOL_VERSION,
            prekey_version: 2,
            prekey_bundle: bundle,
            updated_at,
            signature: URL_SAFE_NO_PAD.encode(signing_key.sign(&payload).to_bytes()),
        };
        assert_eq!(
            update_prekeys(
                State(state.clone()),
                Path(device_id),
                headers.clone(),
                Json(input)
            )
            .await,
            StatusCode::NO_CONTENT
        );
        let replay_bundle = "new-pqxdh-bundle".to_string();
        let replay_payload = serde_json::to_vec(&(
            PROTOCOL_VERSION,
            device_id,
            2_u64,
            &replay_bundle,
            updated_at,
        ))
        .unwrap();
        assert_eq!(
            update_prekeys(
                State(state),
                Path(device_id),
                headers,
                Json(PreKeyUpdate {
                    protocol_version: PROTOCOL_VERSION,
                    prekey_version: 2,
                    prekey_bundle: replay_bundle,
                    updated_at,
                    signature: URL_SAFE_NO_PAD.encode(signing_key.sign(&replay_payload).to_bytes()),
                })
            )
            .await,
            StatusCode::CONFLICT
        );
    }
}
