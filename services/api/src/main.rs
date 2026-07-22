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
        Path, Request, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, Method, StatusCode},
    middleware::{Next, from_fn_with_state},
    response::{IntoResponse, Response},
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
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, RwLock, broadcast};
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
    allowed_origins: Arc<RwLock<AllowedOrigins>>,
}

/// 允许的 Origin 列表，用于 CSRF 纵深防御。
/// 从 `ALLOWED_ORIGINS` 环境变量读取（逗号分隔，如 `https://chat.example.com`）。
/// 空列表 = 开发模式，放行所有（启动时打印 WARN）。
#[derive(Clone, Default)]
struct AllowedOrigins(Vec<String>);

impl AllowedOrigins {
    /// 从环境变量构造。空值或未设置时返回空列表（开发模式）。
    fn from_env() -> Self {
        match env::var("ALLOWED_ORIGINS") {
            Ok(value) => {
                let origins: Vec<String> = value
                    .split(',')
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(str::to_owned)
                    .collect();
                if origins.is_empty() {
                    tracing::warn!(
                        "ALLOWED_ORIGINS is empty; Origin checks are disabled (development mode)"
                    );
                } else {
                    tracing::info!(?origins, "Origin enforcement enabled");
                }
                Self(origins)
            }
            Err(_) => {
                tracing::warn!(
                    "ALLOWED_ORIGINS is unset; Origin checks are disabled (development mode)"
                );
                Self::default()
            }
        }
    }

    /// 空列表表示开发模式（放行所有）。
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// 判断 Origin 是否在允许列表中。
    fn is_allowed(&self, origin: &str) -> bool {
        self.0.iter().any(|allowed| allowed == origin)
    }
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentUploadStatus {
    protocol_version: u8,
    object_id: Uuid,
    chunk_count: u32,
    ciphertext_size: u64,
    expires_at: u64,
    finalized: bool,
    received_chunks: Vec<ReceivedAttachmentChunk>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceivedAttachmentChunk {
    chunk_index: u32,
    ciphertext_digest: String,
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
    let mut allowed_origins = AllowedOrigins::from_env();
    if let Some(database) = &persistence
        && let Some(origin) = database
            .read_deployment_setting("public_origin")
            .await
            .expect("read deployment origin")
    {
        allowed_origins = AllowedOrigins(vec![origin]);
        tracing::info!("Origin enforcement loaded from deployment settings");
    }
    let state = AppState {
        inner: Arc::new(Mutex::new(store)),
        events,
        persistence,
        object_store,
        rate_limiter,
        allowed_origins: Arc::new(RwLock::new(allowed_origins)),
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

/// Origin 校验中间件：对 POST/PUT/DELETE 方法校验 Origin 头。
/// 空 allowed_origins = 开发模式，放行所有。
/// 用于 CSRF 纵深防御（本项目用 Bearer token 不用 cookie，CSRF 风险本身低，但 Origin 校验仍能挡住跨站请求）。
async fn require_origin(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if request.uri().path() == "/health" || request.uri().path().starts_with("/v1/setup") {
        return next.run(request).await;
    }
    let allowed_origins = state.allowed_origins.read().await;
    if allowed_origins.is_empty() {
        if setup_is_required() {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        return next.run(request).await;
    }
    let method = request.method();
    if method != Method::POST && method != Method::PUT && method != Method::DELETE {
        return next.run(request).await;
    }
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok());
    match origin {
        Some(origin) if allowed_origins.is_allowed(origin) => next.run(request).await,
        _ => StatusCode::FORBIDDEN.into_response(),
    }
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/setup/status", get(setup_status))
        .route("/v1/setup", post(complete_setup))
        .route("/v1/onboarding", post(onboard_account))
        .route("/v1/account", delete(delete_account))
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
        .route("/v1/contacts", get(list_contacts))
        .route("/v1/contacts/{username}", delete(delete_contact))
        .route("/v1/contact-requests", get(list_contact_requests))
        .route(
            "/v1/contact-requests/{username}",
            post(create_contact_request).delete(delete_contact_request),
        )
        .route(
            "/v1/contact-requests/{username}/accept",
            post(accept_contact_request),
        )
        .route("/v1/management/overview", get(admin_overview))
        .route("/v1/management/accounts", get(admin_accounts))
        .route("/v1/management/devices", get(admin_devices))
        .route("/v1/management/reports", get(admin_reports))
        .route("/v1/management/audit", get(admin_audit_log))
        .route(
            "/v1/management/reports/{report_id}/resolve",
            post(admin_resolve_report),
        )
        .route(
            "/v1/management/accounts/{username}/suspension",
            post(admin_set_suspension).delete(admin_clear_suspension),
        )
        .route(
            "/v1/management/devices/{device_id}/revoke",
            post(admin_revoke_device),
        )
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
            "/v1/attachments/{object_id}/upload-status",
            get(read_attachment_upload_status),
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
        .layer(from_fn_with_state(state.clone(), require_origin))
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

fn authenticated_username(headers: &HeaderMap, store: &mut Store) -> Option<String> {
    let device_id = authenticated_device(headers, store)?;
    store
        .devices
        .get(&device_id)
        .map(|device| device.username.clone())
}

async fn list_contacts(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let username = {
        let mut store = state.inner.lock().await;
        match authenticated_username(&headers, &mut store) {
            Some(value) => value,
            None => return StatusCode::UNAUTHORIZED.into_response(),
        }
    };
    let Some(database) = &state.persistence else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match database.list_contacts(&username).await {
        Ok(value) => Json(value).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn list_contact_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let username = {
        let mut store = state.inner.lock().await;
        match authenticated_username(&headers, &mut store) {
            Some(value) => value,
            None => return StatusCode::UNAUTHORIZED.into_response(),
        }
    };
    let Some(database) = &state.persistence else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match database.list_contact_requests(&username).await {
        Ok(value) => Json(value).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn create_contact_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(other): Path<String>,
) -> impl IntoResponse {
    if !valid_username(&other) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if authenticated_rate_limit(&state, &headers, "contact_request", 30, 3600)
        .await
        .is_err()
    {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let username = {
        let mut store = state.inner.lock().await;
        let Some(username) = authenticated_username(&headers, &mut store) else {
            return StatusCode::UNAUTHORIZED.into_response();
        };
        if username == other {
            return StatusCode::BAD_REQUEST.into_response();
        }
        if !store.accounts.contains_key(&other) {
            return StatusCode::NOT_FOUND.into_response();
        }
        if store.blocks.contains(&(username.clone(), other.clone()))
            || store.blocks.contains(&(other.clone(), username.clone()))
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        username
    };
    let Some(database) = &state.persistence else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match database.create_contact_request(&username, &other).await {
        Ok(status) => (StatusCode::OK, Json(serde_json::json!({"status": status}))).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn accept_contact_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(sender): Path<String>,
) -> impl IntoResponse {
    if !valid_username(&sender) {
        return StatusCode::BAD_REQUEST;
    }
    let recipient = {
        let mut store = state.inner.lock().await;
        match authenticated_username(&headers, &mut store) {
            Some(value) => value,
            None => return StatusCode::UNAUTHORIZED,
        }
    };
    let Some(database) = &state.persistence else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    match database.accept_contact_request(&sender, &recipient).await {
        Ok(true) => StatusCode::NO_CONTENT,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn delete_contact_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(other): Path<String>,
) -> impl IntoResponse {
    if !valid_username(&other) {
        return StatusCode::BAD_REQUEST;
    }
    let username = {
        let mut store = state.inner.lock().await;
        match authenticated_username(&headers, &mut store) {
            Some(value) => value,
            None => return StatusCode::UNAUTHORIZED,
        }
    };
    let Some(database) = &state.persistence else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    match database.delete_contact_request(&username, &other).await {
        Ok(true) => StatusCode::NO_CONTENT,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn delete_contact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(other): Path<String>,
) -> impl IntoResponse {
    if !valid_username(&other) {
        return StatusCode::BAD_REQUEST;
    }
    let username = {
        let mut store = state.inner.lock().await;
        match authenticated_username(&headers, &mut store) {
            Some(value) => value,
            None => return StatusCode::UNAUTHORIZED,
        }
    };
    let Some(database) = &state.persistence else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    match database.delete_contact(&username, &other).await {
        Ok(true) => StatusCode::NO_CONTENT,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn admin_authorized(headers: &HeaderMap) -> bool {
    let Ok(expected) = env::var("COVECHAT_ADMIN_TOKEN") else {
        return false;
    };
    if expected.len() < 32 {
        return false;
    }
    let Some(provided) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return false;
    };
    admin_token_matches(&expected, provided)
}

fn admin_token_matches(expected: &str, provided: &str) -> bool {
    let expected_hash = Sha256::digest(expected.as_bytes());
    let provided_hash = Sha256::digest(provided.as_bytes());
    expected_hash
        .as_slice()
        .ct_eq(provided_hash.as_slice())
        .into()
}

fn admin_database(state: &AppState, headers: &HeaderMap) -> Result<Persistence, StatusCode> {
    if !admin_authorized(headers) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    state
        .persistence
        .clone()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)
}

async fn admin_overview(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let database = match admin_database(&state, &headers) {
        Ok(value) => value,
        Err(code) => return code.into_response(),
    };
    match database.admin_overview().await {
        Ok(value) => Json(value).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn admin_accounts(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let database = match admin_database(&state, &headers) {
        Ok(value) => value,
        Err(code) => return code.into_response(),
    };
    match database.admin_accounts().await {
        Ok(value) => Json(value).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn admin_devices(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(code) = admin_database(&state, &headers) {
        return code.into_response();
    }
    let store = state.inner.lock().await;
    Json(store.devices.values().map(|device| serde_json::json!({
        "deviceId": device.device_id, "username": device.username, "createdAt": device.created_at,
        "revokedAt": device.revoked_at, "prekeyVersion": device.prekey_version,
    })).collect::<Vec<_>>()).into_response()
}

async fn admin_revoke_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
) -> impl IntoResponse {
    let database = match admin_database(&state, &headers) {
        Ok(value) => value,
        Err(code) => return code,
    };
    let updated = {
        let mut store = state.inner.lock().await;
        let Some(device) = store.devices.get_mut(&device_id) else {
            return StatusCode::NOT_FOUND;
        };
        if device.revoked_at.is_some() {
            return StatusCode::NO_CONTENT;
        }
        device.revoked_at = Some(unix_now());
        let updated = device.clone();
        store
            .sessions
            .retain(|_, session| session.device_id != device_id);
        updated
    };
    if database.update_device(&updated).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let _ = database
        .admin_audit(
            "device.revoke",
            &device_id.to_string(),
            serde_json::json!({"username": updated.username}),
        )
        .await;
    StatusCode::NO_CONTENT
}

async fn admin_reports(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let database = match admin_database(&state, &headers) {
        Ok(value) => value,
        Err(code) => return code.into_response(),
    };
    match database.admin_reports().await {
        Ok(value) => Json(value).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn admin_audit_log(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let database = match admin_database(&state, &headers) {
        Ok(value) => value,
        Err(code) => return code.into_response(),
    };
    match database.admin_audit_log().await {
        Ok(value) => Json(value).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminResolution {
    status: String,
    note: String,
}

async fn admin_resolve_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(report_id): Path<Uuid>,
    Json(input): Json<AdminResolution>,
) -> impl IntoResponse {
    let database = match admin_database(&state, &headers) {
        Ok(value) => value,
        Err(code) => return code,
    };
    if !matches!(input.status.as_str(), "resolved" | "dismissed") || input.note.len() > 2000 {
        return StatusCode::BAD_REQUEST;
    }
    match database
        .admin_resolve_report(report_id, &input.status, &input.note)
        .await
    {
        Ok(true) => {
            let _ = database
                .admin_audit(
                    "report.resolve",
                    &report_id.to_string(),
                    serde_json::json!({"status": input.status, "note": input.note}),
                )
                .await;
            StatusCode::NO_CONTENT
        }
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[derive(Deserialize)]
struct AdminSuspension {
    reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteAccountRequest {
    username: String,
    created_at: u64,
    signature: String,
}

async fn delete_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<DeleteAccountRequest>,
) -> impl IntoResponse {
    if !valid_username(&input.username) || unix_now().abs_diff(input.created_at) > 300 {
        return StatusCode::BAD_REQUEST;
    }
    let (account, owned_devices, attachments) = {
        let mut store = state.inner.lock().await;
        let Some(device_id) = authenticated_device(&headers, &mut store) else {
            return StatusCode::UNAUTHORIZED;
        };
        let Some(device) = store.devices.get(&device_id) else {
            return StatusCode::UNAUTHORIZED;
        };
        if device.username != input.username {
            return StatusCode::FORBIDDEN;
        }
        let Some(account) = store.accounts.get(&input.username).cloned() else {
            return StatusCode::NOT_FOUND;
        };
        let owned_devices = store
            .devices
            .values()
            .filter(|item| item.username == input.username)
            .map(|item| item.device_id)
            .collect::<HashSet<_>>();
        let attachments = store
            .attachments
            .iter()
            .filter(|(_, object)| owned_devices.contains(&object.owner_device_id))
            .map(|(id, object)| (*id, object.chunk_count))
            .collect::<Vec<_>>();
        (account, owned_devices, attachments)
    };
    let payload = serde_json::to_vec(&(
        PROTOCOL_VERSION,
        "delete-account",
        &input.username,
        input.created_at,
    ))
    .unwrap_or_default();
    if !verify_signature(&account.signing_public_key, &payload, &input.signature) {
        return StatusCode::UNAUTHORIZED;
    }
    let Some(database) = &state.persistence else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    if database
        .admin_audit(
            "account.delete",
            &input.username,
            serde_json::json!({"deviceCount": owned_devices.len()}),
        )
        .await
        .is_err()
        || database.delete_account(&input.username).await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    if let Some(object_store) = &state.object_store {
        for (object_id, chunk_count) in &attachments {
            let _ = object_store
                .delete_attachment(*object_id, *chunk_count)
                .await;
        }
    }
    let mut store = state.inner.lock().await;
    store.accounts.remove(&input.username);
    store.devices.retain(|id, _| !owned_devices.contains(id));
    store
        .challenges
        .retain(|_, challenge| !owned_devices.contains(&challenge.device_id));
    store
        .sessions
        .retain(|_, session| !owned_devices.contains(&session.device_id));
    store
        .recovery_challenges
        .retain(|_, challenge| challenge.username != input.username);
    store
        .recovery_sessions
        .retain(|_, session| session.username != input.username);
    store.envelopes.retain(|id, _| !owned_devices.contains(id));
    store
        .last_sequence
        .retain(|(sender, _), _| !owned_devices.contains(sender));
    store.backups.remove(&input.username);
    store
        .attachments
        .retain(|id, _| !attachments.iter().any(|(owned_id, _)| owned_id == id));
    store
        .abuse_reports
        .retain(|_, report| !owned_devices.contains(&report.reporter_device_id));
    store
        .blocks
        .retain(|(blocker, blocked)| blocker != &input.username && blocked != &input.username);
    StatusCode::NO_CONTENT
}

async fn admin_set_suspension(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(username): Path<String>,
    Json(input): Json<AdminSuspension>,
) -> impl IntoResponse {
    let database = match admin_database(&state, &headers) {
        Ok(value) => value,
        Err(code) => return code,
    };
    if !valid_username(&username) || input.reason.trim().is_empty() || input.reason.len() > 500 {
        return StatusCode::BAD_REQUEST;
    }
    match database
        .admin_suspend_account(&username, input.reason.trim(), true)
        .await
    {
        Ok(true) => {
            let device_ids = state
                .inner
                .lock()
                .await
                .devices
                .values()
                .filter(|device| device.username == username)
                .map(|device| device.device_id)
                .collect::<HashSet<_>>();
            state
                .inner
                .lock()
                .await
                .sessions
                .retain(|_, session| !device_ids.contains(&session.device_id));
            let _ = database
                .admin_audit(
                    "account.suspend",
                    &username,
                    serde_json::json!({"reason": input.reason}),
                )
                .await;
            StatusCode::NO_CONTENT
        }
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn admin_clear_suspension(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(username): Path<String>,
) -> impl IntoResponse {
    let database = match admin_database(&state, &headers) {
        Ok(value) => value,
        Err(code) => return code,
    };
    match database.admin_suspend_account(&username, "", false).await {
        Ok(true) => {
            let _ = database
                .admin_audit("account.unsuspend", &username, serde_json::json!({}))
                .await;
            StatusCode::NO_CONTENT
        }
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStatus {
    configured: bool,
    public_origin: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupInput {
    setup_token: String,
    public_origin: String,
}

async fn setup_status(State(state): State<AppState>) -> Json<SetupStatus> {
    let origins = state.allowed_origins.read().await;
    Json(SetupStatus {
        configured: !origins.is_empty(),
        public_origin: origins.0.first().cloned(),
    })
}

async fn complete_setup(
    State(state): State<AppState>,
    Json(input): Json<SetupInput>,
) -> StatusCode {
    let expected = match env::var("COVECHAT_SETUP_TOKEN") {
        Ok(value) if value.len() >= 24 => value,
        _ => return StatusCode::SERVICE_UNAVAILABLE,
    };
    if input.setup_token.len() != expected.len()
        || input
            .setup_token
            .as_bytes()
            .ct_eq(expected.as_bytes())
            .unwrap_u8()
            != 1
    {
        return StatusCode::UNAUTHORIZED;
    }
    let Some(origin) = normalize_public_origin(&input.public_origin) else {
        return StatusCode::BAD_REQUEST;
    };
    let mut allowed_origins = state.allowed_origins.write().await;
    if !allowed_origins.is_empty() {
        return StatusCode::CONFLICT;
    }
    let Some(database) = &state.persistence else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    if database
        .write_deployment_setting("public_origin", &origin)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    *allowed_origins = AllowedOrigins(vec![origin]);
    StatusCode::NO_CONTENT
}

fn normalize_public_origin(value: &str) -> Option<String> {
    let origin = value.trim().trim_end_matches('/');
    let uri = origin.parse::<axum::http::Uri>().ok()?;
    let authority = uri.authority()?;
    let is_local = matches!(authority.host(), "localhost" | "127.0.0.1" | "[::1]");
    if !(matches!(uri.scheme_str(), Some("https"))
        || matches!(uri.scheme_str(), Some("http")) && is_local)
        || uri.path() != "/"
        || uri.query().is_some()
        || origin.contains('@')
    {
        return None;
    }
    Some(origin.to_owned())
}

fn setup_is_required() -> bool {
    matches!(env::var("COVECHAT_SETUP_TOKEN"), Ok(value) if value.len() >= 24)
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
    headers: HeaderMap,
    Json(input): Json<OnboardingRequest>,
) -> StatusCode {
    // 匿名限流：按 IP 限制注册频率（5 次/小时），防止批量注册。
    if anonymous_rate_limit(&state, &headers, "onboard", 5, 3600)
        .await
        .is_err()
    {
        return StatusCode::TOO_MANY_REQUESTS;
    }
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
    let device_count = store
        .devices
        .values()
        .filter(|d| d.username == device.username)
        .count();
    if device_count >= 10 {
        return StatusCode::TOO_MANY_REQUESTS;
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
    headers: HeaderMap,
) -> (StatusCode, Json<Option<ChallengeResponse>>) {
    // 匿名限流：按 IP 限制登录挑战频率（10 次/分钟），防止登录轰炸。
    if anonymous_rate_limit(&state, &headers, "challenge", 10, 60)
        .await
        .is_err()
    {
        return (StatusCode::TOO_MANY_REQUESTS, Json(None));
    }
    let store = state.inner.lock().await;
    let Some(device) = store.devices.get(&device_id).cloned() else {
        return (StatusCode::NOT_FOUND, Json(None));
    };
    if device.revoked_at.is_some() {
        return (StatusCode::FORBIDDEN, Json(None));
    }
    drop(store);
    if let Some(database) = &state.persistence
        && database
            .account_suspended(&device.username)
            .await
            .unwrap_or(true)
    {
        return (StatusCode::FORBIDDEN, Json(None));
    }
    let mut store = state.inner.lock().await;
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
    headers: HeaderMap,
) -> (StatusCode, Json<Option<ChallengeResponse>>) {
    // 匿名限流：按 IP 限制恢复挑战频率（5 次/小时），防止恢复码暴力枚举。
    if anonymous_rate_limit(&state, &headers, "recovery_challenge", 5, 3600)
        .await
        .is_err()
    {
        return (StatusCode::TOO_MANY_REQUESTS, Json(None));
    }
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
    Json(mut envelope): Json<EncryptedEnvelope>,
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
    envelope.expires_at = envelope.expires_at.min(unix_now() + 30 * 24 * 60 * 60);
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
    let mailbox = store.envelopes.get(&envelope.recipient_device_id);
    let message_count = mailbox.map(|m| m.len()).unwrap_or(0);
    let total_bytes: usize = mailbox
        .map(|m| m.iter().map(|e| e.ciphertext.len()).sum())
        .unwrap_or(0);
    if message_count >= 1000 || total_bytes > 50 * 1024 * 1024 {
        return StatusCode::INSUFFICIENT_STORAGE;
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
    // 认证限流：按 device_id 限流（60 次/分钟），防止用户名枚举。
    if authenticated_rate_limit(&state, &headers, "directory", 60, 60)
        .await
        .is_err()
    {
        return (StatusCode::TOO_MANY_REQUESTS, Json(None));
    }
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
    let pending_attachments = store
        .attachments
        .values()
        .filter(|object| object.owner_device_id == owner_device_id && !object.finalized)
        .count();
    if pending_attachments >= 10 {
        return StatusCode::TOO_MANY_REQUESTS;
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
    let total_size = object
        .chunks
        .values()
        .map(|c| c.ciphertext_size)
        .sum::<u64>()
        + chunk.ciphertext_size;
    if total_size > object.ciphertext_size {
        return StatusCode::PAYLOAD_TOO_LARGE;
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

async fn read_attachment_upload_status(
    State(state): State<AppState>,
    Path(object_id): Path<Uuid>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let mut store = state.inner.lock().await;
    let Some(device_id) = authenticated_device(&headers, &mut store) else {
        return (StatusCode::UNAUTHORIZED, Json(None));
    };
    let Some(object) = store.attachments.get(&object_id) else {
        return (StatusCode::NOT_FOUND, Json(None));
    };
    if object.owner_device_id != device_id {
        return (StatusCode::FORBIDDEN, Json(None));
    }
    if object.expires_at <= unix_now() {
        return (StatusCode::NOT_FOUND, Json(None));
    }
    let mut received_chunks = object
        .chunks
        .iter()
        .map(|(chunk_index, chunk)| ReceivedAttachmentChunk {
            chunk_index: *chunk_index,
            ciphertext_digest: chunk.ciphertext_digest.clone(),
        })
        .collect::<Vec<_>>();
    received_chunks.sort_by_key(|chunk| chunk.chunk_index);
    (
        StatusCode::OK,
        Json(Some(AttachmentUploadStatus {
            protocol_version: PROTOCOL_VERSION,
            object_id,
            chunk_count: object.chunk_count,
            ciphertext_size: object.ciphertext_size,
            expires_at: object.expires_at,
            finalized: object.finalized,
            received_chunks,
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
    // WebSocket 升级是 GET 请求，不经过 require_origin 中间件，这里手动校验 Origin。
    let allowed_origins = state.allowed_origins.read().await;
    if !allowed_origins.is_empty() {
        let origin = headers.get("origin").and_then(|value| value.to_str().ok());
        match origin {
            Some(origin) if allowed_origins.is_allowed(origin) => {}
            _ => return StatusCode::FORBIDDEN.into_response(),
        }
    } else if setup_is_required() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
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
        // 内存清理在锁内完成，返回需要从 S3 删除的附件列表（S3 删除在锁外做，避免长持锁）。
        let expired = {
            let mut store = state.inner.lock().await;
            cleanup_once(&mut store, now)
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

/// 单次内存清理：移除所有已过期的短期状态，返回需要从对象存储删除的附件列表。
///
/// 清理范围（PROJECT_CONTEXT 第 6 节第 8 项）：
/// - 幂等键（idempotency）
/// - 投递信封（envelopes）
/// - 登录挑战（challenges）与恢复挑战（recovery_challenges）
/// - 会话（sessions）与恢复会话（recovery_sessions）
/// - 附件对象（attachments，内存部分；S3 部分由调用方按返回值删除）
///
/// 提取为纯函数以便单元测试；`cleanup_loop` 是死循环不便直接调用。
fn cleanup_once(store: &mut Store, now: u64) -> Vec<(Uuid, u32)> {
    // 幂等键：过期后不能再用于去重，直接清除。
    store.idempotency.retain(|_, expires_at| *expires_at > now);
    // 信封：每个收件人邮箱里过期的信封移除。
    store.envelopes.values_mut().for_each(|messages| {
        messages.retain(|message| message.expires_at > now);
    });
    // 登录挑战：120s 寿命，过期未消费的清除。
    store
        .challenges
        .retain(|_, challenge| challenge.expires_at > now);
    // 恢复挑战：120s 寿命，过期未消费的清除。
    store
        .recovery_challenges
        .retain(|_, challenge| challenge.expires_at > now);
    // 会话：3600s 寿命，过期会话清除（authenticate_token 调用时也会被动清理）。
    store.sessions.retain(|_, session| session.expires_at > now);
    // 恢复会话：600s 寿命，过期清除。
    store
        .recovery_sessions
        .retain(|_, session| session.expires_at > now);
    // 附件：收集过期附件的 (id, chunk_count) 供调用方删除 S3 对象，然后从内存移除。
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

/// 匿名限流：基于 X-Forwarded-For 头的 IP 地址。
/// 用于不需要认证的接口（注册、登录挑战、恢复挑战），防止批量注册和暴力枚举。
/// 注意：X-Forwarded-For 必须在反向代理层设置并清除客户端伪造的值。
/// 若未配置 Redis，限流降级为放行（开发模式）。
async fn anonymous_rate_limit(
    state: &AppState,
    headers: &HeaderMap,
    scope: &str,
    limit: u64,
    window_seconds: u64,
) -> Result<(), StatusCode> {
    let Some(rate_limiter) = &state.rate_limiter else {
        return Ok(());
    };
    // 从 X-Forwarded-For 提取客户端 IP；缺失时用 "anonymous" 兜底。
    let subject = rate_limit_subject(headers);
    match rate_limiter
        .check(scope, subject, limit, window_seconds)
        .await
    {
        Ok(true) => Ok(()),
        Ok(false) => Err(StatusCode::TOO_MANY_REQUESTS),
        Err(error) => {
            tracing::error!(error = %error, scope, "Redis rate limit failure");
            Err(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

fn rate_limit_subject(headers: &HeaderMap) -> &str {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|item| item.parse::<IpAddr>().is_ok())
        .unwrap_or("anonymous")
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
            allowed_origins: Arc::new(RwLock::new(AllowedOrigins::default())),
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
            read_attachment_upload_status(State(state.clone()), Path(object_id), headers.clone(),)
                .await
                .into_response()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            read_attachment_upload_status(State(state.clone()), Path(object_id), HeaderMap::new(),)
                .await
                .into_response()
                .status(),
            StatusCode::UNAUTHORIZED
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

    // === 新增辅助：在已有 state 里再注册一个账户 + 设备 + session ===
    // 用于拉黑、备份归属等需要两个身份的测试。token 与 authenticated_state 的 [3;32] 区分开。
    async fn add_second_user(state: &AppState, username: &str) -> (HeaderMap, Uuid) {
        let (account, device) = account_and_device(username);
        let device_id = device.device_id;
        let token = [5; 32];
        let mut store = state.inner.lock().await;
        store.accounts.insert(username.to_string(), account);
        store.devices.insert(device_id, device);
        store.sessions.insert(
            Sha256::digest(token).into(),
            Session {
                device_id,
                expires_at: unix_now() + 60,
            },
        );
        drop(store);
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", URL_SAFE_NO_PAD.encode(token))).unwrap(),
        );
        (headers, device_id)
    }

    // === 新增辅助：构造一个签名合法的加密信封 ===
    // 信封签名载荷必须与 verify_envelope_signature 中的元组字段顺序完全一致。
    fn signed_envelope(
        sender_device_id: Uuid,
        recipient_device_id: Uuid,
        sender_key: &SigningKey,
        sequence: u64,
        idempotency_key: &str,
    ) -> EncryptedEnvelope {
        let envelope_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let expires_at = unix_now() + 60;
        let ciphertext = "ciphertext".to_string();
        let payload = serde_json::to_vec(&(
            PROTOCOL_VERSION,
            envelope_id,
            sender_device_id,
            recipient_device_id,
            conversation_id,
            sequence,
            expires_at,
            &ciphertext,
            idempotency_key,
        ))
        .unwrap();
        let signature = URL_SAFE_NO_PAD.encode(sender_key.sign(&payload).to_bytes());
        EncryptedEnvelope {
            protocol_version: PROTOCOL_VERSION,
            envelope_id,
            sender_device_id,
            recipient_device_id,
            conversation_id,
            sequence,
            expires_at,
            ciphertext,
            signature,
            idempotency_key: idempotency_key.to_string(),
        }
    }

    // 构造一个举报请求载荷。CreateAbuseReport 未派生 Clone（项目惯例），用函数按需重建。
    fn make_abuse_input(
        signing_key: &SigningKey,
        report_id: Uuid,
        reported_username: &str,
        bundle: &str,
        context: &str,
    ) -> CreateAbuseReport {
        let created_at = unix_now();
        let payload = serde_json::to_vec(&(
            PROTOCOL_VERSION,
            report_id,
            reported_username,
            bundle,
            context,
            created_at,
        ))
        .unwrap();
        let signature = URL_SAFE_NO_PAD.encode(signing_key.sign(&payload).to_bytes());
        CreateAbuseReport {
            protocol_version: PROTOCOL_VERSION,
            report_id,
            reported_username: reported_username.to_string(),
            disclosed_message_bundle: bundle.to_string(),
            context: context.to_string(),
            created_at,
            reporter_signature: signature,
        }
    }

    // 举报：签名正确 → CREATED；相同 report_id → CONFLICT；签名错误 → UNAUTHORIZED。
    #[tokio::test]
    async fn abuse_report_accepts_signed_payload_and_rejects_duplicates() {
        let (state, headers, _) = authenticated_state("maya_chen");
        let signing_key = SigningKey::from_bytes(&[9; 32]);
        let report_id = Uuid::new_v4();
        // 第一次提交：签名正确 → CREATED
        let input = make_abuse_input(&signing_key, report_id, "jonas_weber", "bundle", "ctx");
        assert_eq!(
            create_abuse_report(State(state.clone()), headers.clone(), Json(input)).await,
            StatusCode::CREATED
        );
        // 第二次：相同 report_id → CONFLICT（签名先验证通过，然后撞重复键）
        let dup = make_abuse_input(&signing_key, report_id, "jonas_weber", "bundle", "ctx");
        assert_eq!(
            create_abuse_report(State(state.clone()), headers.clone(), Json(dup)).await,
            StatusCode::CONFLICT
        );
        // 第三次：签名错误 → UNAUTHORIZED（换新 report_id 避免与重复检查混淆）
        let mut bad =
            make_abuse_input(&signing_key, Uuid::new_v4(), "jonas_weber", "bundle", "ctx");
        bad.reporter_signature = URL_SAFE_NO_PAD.encode([0u8; 64]);
        assert_eq!(
            create_abuse_report(State(state), headers, Json(bad)).await,
            StatusCode::UNAUTHORIZED
        );
    }

    // 拉黑：recipient 拉黑 sender 后，sender 投递返回 FORBIDDEN；解除后恢复 ACCEPTED。
    // 验证 abuse 控制在密文投递层生效，被拉黑用户无法向对方设备投递新消息。
    #[tokio::test]
    async fn block_user_blocks_delivery_and_unblock_restores() {
        let (state, sender_headers, sender_device_id) = authenticated_state("maya_chen");
        let (recipient_headers, recipient_device_id) = add_second_user(&state, "jonas_weber").await;
        let sender_key = SigningKey::from_bytes(&[9; 32]);

        // 初始投递 → ACCEPTED
        let envelope1 = signed_envelope(
            sender_device_id,
            recipient_device_id,
            &sender_key,
            1,
            "idem-1",
        );
        let mut headers1 = sender_headers.clone();
        headers1.insert(
            "x-idempotency-key",
            HeaderValue::from_str("idem-1").unwrap(),
        );
        assert_eq!(
            store_envelope(State(state.clone()), headers1, Json(envelope1)).await,
            StatusCode::ACCEPTED
        );

        // recipient 拉黑 sender
        assert_eq!(
            block_user(
                State(state.clone()),
                Path("maya_chen".into()),
                recipient_headers.clone(),
            )
            .await,
            StatusCode::NO_CONTENT
        );

        // 再投递 → FORBIDDEN（拉黑在密文投递层生效）
        let envelope2 = signed_envelope(
            sender_device_id,
            recipient_device_id,
            &sender_key,
            2,
            "idem-2",
        );
        let mut headers2 = sender_headers.clone();
        headers2.insert(
            "x-idempotency-key",
            HeaderValue::from_str("idem-2").unwrap(),
        );
        assert_eq!(
            store_envelope(State(state.clone()), headers2, Json(envelope2)).await,
            StatusCode::FORBIDDEN
        );

        // 解除拉黑
        assert_eq!(
            unblock_user(
                State(state.clone()),
                Path("maya_chen".into()),
                recipient_headers.clone(),
            )
            .await,
            StatusCode::NO_CONTENT
        );

        // 再投递 → ACCEPTED（sequence 跳到 3，因为被拒那次没有推进 last_sequence）
        let envelope3 = signed_envelope(
            sender_device_id,
            recipient_device_id,
            &sender_key,
            3,
            "idem-3",
        );
        let mut headers3 = sender_headers.clone();
        headers3.insert(
            "x-idempotency-key",
            HeaderValue::from_str("idem-3").unwrap(),
        );
        assert_eq!(
            store_envelope(State(state), headers3, Json(envelope3)).await,
            StatusCode::ACCEPTED
        );
    }

    // 备份读取：用户只能读到自己的备份；没有备份的用户返回 NOT_FOUND。
    #[tokio::test]
    async fn read_latest_backup_returns_only_owner_backup() {
        let (state, headers, _) = authenticated_state("maya_chen");
        let ciphertext = "owner-backup".to_string();
        let backup = EncryptedBackup {
            protocol_version: PROTOCOL_VERSION,
            version: 1,
            previous_digest: None,
            ciphertext_digest: digest_text(&ciphertext),
            ciphertext,
            created_at: unix_now(),
        };
        assert_eq!(
            store_backup(State(state.clone()), headers.clone(), Json(backup)).await,
            StatusCode::NO_CONTENT
        );
        // 自己能读
        let response = read_latest_backup(State(state.clone()), headers)
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        // 别人（无备份）→ NOT_FOUND
        let (other_headers, _) = add_second_user(&state, "jonas_weber").await;
        let other_response = read_latest_backup(State(state), other_headers)
            .await
            .into_response();
        assert_eq!(other_response.status(), StatusCode::NOT_FOUND);
    }

    // 恢复会话能读取账户备份：恢复码认证后能拿到加密备份用于灾难恢复。
    #[tokio::test]
    async fn recovery_session_can_read_backup() {
        let (state, _, _) = authenticated_state("maya_chen");
        let ciphertext = "recovery-backup".to_string();
        let backup = EncryptedBackup {
            protocol_version: PROTOCOL_VERSION,
            version: 1,
            previous_digest: None,
            ciphertext_digest: digest_text(&ciphertext),
            ciphertext,
            created_at: unix_now(),
        };
        {
            let mut store = state.inner.lock().await;
            store.backups.insert("maya_chen".to_string(), backup);
        }
        // 构造一个 recovery session（模拟 verify_recovery_challenge 成功后的状态）
        let recovery_token = [7; 32];
        {
            let mut store = state.inner.lock().await;
            store.recovery_sessions.insert(
                Sha256::digest(recovery_token).into(),
                RecoverySession {
                    username: "maya_chen".to_string(),
                    expires_at: unix_now() + 60,
                },
            );
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!(
                "Bearer {}",
                URL_SAFE_NO_PAD.encode(recovery_token)
            ))
            .unwrap(),
        );
        let response = read_latest_backup_with_recovery(State(state), headers)
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }

    // 过期处理：store_envelope 拒绝 expires_at <= now；read_mailbox 过滤掉已过期信封。
    // 这是 cleanup_loop 在可见行为层的等价测试（cleanup_loop 是死循环不便直接调用）。
    #[tokio::test]
    async fn expired_envelopes_are_rejected_and_filtered_from_mailbox() {
        let (state, headers, device_id) = authenticated_state("maya_chen");
        let sender_key = SigningKey::from_bytes(&[9; 32]);

        // 1) store_envelope 拒绝 expires_at <= now（边界值用 == now）
        let envelope_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let idempotency_key = "expired-at-submit".to_string();
        let expires_at = unix_now();
        let ciphertext = "ciphertext".to_string();
        let payload = serde_json::to_vec(&(
            PROTOCOL_VERSION,
            envelope_id,
            device_id,
            Uuid::new_v4(),
            conversation_id,
            1_u64,
            expires_at,
            &ciphertext,
            &idempotency_key,
        ))
        .unwrap();
        let signature = URL_SAFE_NO_PAD.encode(sender_key.sign(&payload).to_bytes());
        let expired = EncryptedEnvelope {
            protocol_version: PROTOCOL_VERSION,
            envelope_id,
            sender_device_id: device_id,
            recipient_device_id: Uuid::new_v4(),
            conversation_id,
            sequence: 1,
            expires_at,
            ciphertext,
            signature,
            idempotency_key: idempotency_key.clone(),
        };
        let mut headers_with_idem = headers.clone();
        headers_with_idem.insert(
            "x-idempotency-key",
            HeaderValue::from_str(&idempotency_key).unwrap(),
        );
        assert_eq!(
            store_envelope(State(state.clone()), headers_with_idem, Json(expired)).await,
            StatusCode::BAD_REQUEST
        );

        // 2) 手动塞一个已过期的信封，read_mailbox 应过滤掉，返回空数组
        {
            let mut store = state.inner.lock().await;
            store.envelopes.insert(
                device_id,
                vec![EncryptedEnvelope {
                    protocol_version: PROTOCOL_VERSION,
                    envelope_id: Uuid::new_v4(),
                    sender_device_id: Uuid::new_v4(),
                    recipient_device_id: device_id,
                    conversation_id: Uuid::new_v4(),
                    sequence: 100,
                    expires_at: unix_now().saturating_sub(1),
                    ciphertext: "expired".into(),
                    signature: "expired".into(),
                    idempotency_key: "expired-idem".into(),
                }],
            );
        }
        let response = read_mailbox(State(state), Path(device_id), headers)
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(&body[..], b"[]");
    }

    // === cleanup_once 单元测试 ===
    // cleanup_loop 是死循环不便直接测，提取的 cleanup_once 纯函数可直接验证清理行为。

    // 构造一个塞满各类过期 + 未过期条目的 Store，便于多个测试复用。
    fn store_with_mixed_expiry(now: u64) -> Store {
        let mut store = Store::default();
        // 幂等键：1 过期 / 1 存活
        store
            .idempotency
            .insert("expired-idem".into(), now.saturating_sub(1));
        store.idempotency.insert("live-idem".into(), now + 60);
        // 信封：1 过期 / 1 存活（同一收件人）
        let recipient = Uuid::new_v4();
        store.envelopes.insert(
            recipient,
            vec![
                EncryptedEnvelope {
                    protocol_version: PROTOCOL_VERSION,
                    envelope_id: Uuid::new_v4(),
                    sender_device_id: Uuid::new_v4(),
                    recipient_device_id: recipient,
                    conversation_id: Uuid::new_v4(),
                    sequence: 1,
                    expires_at: now.saturating_sub(1),
                    ciphertext: "expired".into(),
                    signature: "expired".into(),
                    idempotency_key: "expired-env".into(),
                },
                EncryptedEnvelope {
                    protocol_version: PROTOCOL_VERSION,
                    envelope_id: Uuid::new_v4(),
                    sender_device_id: Uuid::new_v4(),
                    recipient_device_id: recipient,
                    conversation_id: Uuid::new_v4(),
                    sequence: 2,
                    expires_at: now + 60,
                    ciphertext: "live".into(),
                    signature: "live".into(),
                    idempotency_key: "live-env".into(),
                },
            ],
        );
        // 登录挑战：1 过期 / 1 存活
        store.challenges.insert(
            Uuid::new_v4(),
            Challenge {
                device_id: Uuid::new_v4(),
                bytes: [0; 32],
                expires_at: now.saturating_sub(1),
                consumed: false,
            },
        );
        store.challenges.insert(
            Uuid::new_v4(),
            Challenge {
                device_id: Uuid::new_v4(),
                bytes: [1; 32],
                expires_at: now + 120,
                consumed: false,
            },
        );
        // 恢复挑战：1 过期 / 1 存活
        store.recovery_challenges.insert(
            Uuid::new_v4(),
            RecoveryChallenge {
                username: "maya_chen".into(),
                bytes: [0; 32],
                expires_at: now.saturating_sub(1),
                consumed: false,
            },
        );
        store.recovery_challenges.insert(
            Uuid::new_v4(),
            RecoveryChallenge {
                username: "jonas_weber".into(),
                bytes: [1; 32],
                expires_at: now + 120,
                consumed: false,
            },
        );
        // 会话：1 过期 / 1 存活
        store.sessions.insert(
            [0; 32],
            Session {
                device_id: Uuid::new_v4(),
                expires_at: now.saturating_sub(1),
            },
        );
        store.sessions.insert(
            [1; 32],
            Session {
                device_id: Uuid::new_v4(),
                expires_at: now + 3600,
            },
        );
        // 恢复会话：1 过期 / 1 存活
        store.recovery_sessions.insert(
            [0; 32],
            RecoverySession {
                username: "maya_chen".into(),
                expires_at: now.saturating_sub(1),
            },
        );
        store.recovery_sessions.insert(
            [1; 32],
            RecoverySession {
                username: "jonas_weber".into(),
                expires_at: now + 600,
            },
        );
        // 附件：1 过期（2 块）/ 1 存活（3 块）
        store.attachments.insert(
            Uuid::new_v4(),
            AttachmentObject {
                owner_device_id: Uuid::new_v4(),
                chunk_count: 2,
                ciphertext_size: 100,
                expires_at: now.saturating_sub(1),
                chunks: HashMap::new(),
                finalized: false,
            },
        );
        store.attachments.insert(
            Uuid::new_v4(),
            AttachmentObject {
                owner_device_id: Uuid::new_v4(),
                chunk_count: 3,
                ciphertext_size: 200,
                expires_at: now + 3600,
                chunks: HashMap::new(),
                finalized: true,
            },
        );
        store
    }

    #[test]
    fn cleanup_once_removes_all_expired_entries_and_keeps_live_ones() {
        let now = 1_000_000_u64;
        let mut store = store_with_mixed_expiry(now);
        let expired = cleanup_once(&mut store, now);

        // 幂等键：只剩存活的
        assert_eq!(store.idempotency.len(), 1);
        assert!(store.idempotency.contains_key("live-idem"));

        // 信封：每个邮箱只剩存活的（过期信封被移除）
        for messages in store.envelopes.values() {
            for message in messages {
                assert!(message.expires_at > now, "expired envelope not cleaned");
            }
        }
        let total_envelopes: usize = store.envelopes.values().map(Vec::len).sum();
        assert_eq!(total_envelopes, 1);

        // 挑战：只剩存活的
        assert_eq!(store.challenges.len(), 1);
        for challenge in store.challenges.values() {
            assert!(challenge.expires_at > now);
        }

        // 恢复挑战：只剩存活的
        assert_eq!(store.recovery_challenges.len(), 1);
        for challenge in store.recovery_challenges.values() {
            assert!(challenge.expires_at > now);
        }

        // 会话：只剩存活的
        assert_eq!(store.sessions.len(), 1);
        for session in store.sessions.values() {
            assert!(session.expires_at > now);
        }

        // 恢复会话：只剩存活的
        assert_eq!(store.recovery_sessions.len(), 1);
        for session in store.recovery_sessions.values() {
            assert!(session.expires_at > now);
        }

        // 附件：只剩存活的
        assert_eq!(store.attachments.len(), 1);
        for attachment in store.attachments.values() {
            assert!(attachment.expires_at > now);
        }

        // S3 删除列表：只包含过期附件，且 chunk_count 正确
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].1, 2, "expired attachment should have 2 chunks");
    }

    #[test]
    fn cleanup_once_with_empty_store_is_noop() {
        let mut store = Store::default();
        let expired = cleanup_once(&mut store, unix_now());
        assert!(expired.is_empty());
        assert!(store.idempotency.is_empty());
        assert!(store.envelopes.is_empty());
        assert!(store.challenges.is_empty());
        assert!(store.recovery_challenges.is_empty());
        assert!(store.sessions.is_empty());
        assert!(store.recovery_sessions.is_empty());
        assert!(store.attachments.is_empty());
    }

    #[test]
    fn cleanup_once_preserves_everything_when_nothing_expired() {
        // 全部未过期时，cleanup_once 应当是 no-op，且 S3 删除列表为空。
        // store_with_mixed_expiry(base) 构造的条目最小 expires_at 是 base-1（"过期"组）。
        // 用 base-2 作为判断基准，则所有条目都满足 expires_at > benchmark，等价于"没有任何条目过期"。
        let base = unix_now();
        let mut store = store_with_mixed_expiry(base);
        let benchmark = base.saturating_sub(2);
        let expired = cleanup_once(&mut store, benchmark);
        assert!(
            expired.is_empty(),
            "nothing should be expired relative to benchmark"
        );
        assert_eq!(store.idempotency.len(), 2);
        assert_eq!(store.challenges.len(), 2);
        assert_eq!(store.recovery_challenges.len(), 2);
        assert_eq!(store.sessions.len(), 2);
        assert_eq!(store.recovery_sessions.len(), 2);
        assert_eq!(store.attachments.len(), 2);
    }

    // === AllowedOrigins 单元测试 ===

    #[test]
    fn allowed_origins_default_is_empty_development_mode() {
        let origins = AllowedOrigins::default();
        assert!(origins.is_empty());
        // 空列表下任何 Origin 都不匹配，但中间件层会先检查 is_empty() 放行。
        assert!(!origins.is_allowed("https://example.com"));
    }

    #[test]
    fn allowed_origins_is_allowed_matches_exact() {
        let origins = AllowedOrigins(vec![
            "https://chat.example.com".to_string(),
            "https://app.example.com".to_string(),
        ]);
        assert!(!origins.is_empty());
        assert!(origins.is_allowed("https://chat.example.com"));
        assert!(origins.is_allowed("https://app.example.com"));
        // 不匹配的 Origin
        assert!(!origins.is_allowed("https://evil.com"));
        assert!(!origins.is_allowed("https://chat.example.com.evil.com"));
        assert!(!origins.is_allowed(""));
    }

    #[test]
    fn setup_origin_requires_https_except_for_local_development() {
        assert_eq!(
            normalize_public_origin("https://chat.example.com/"),
            Some("https://chat.example.com".to_owned())
        );
        assert_eq!(
            normalize_public_origin("http://localhost:8088"),
            Some("http://localhost:8088".to_owned())
        );
        assert!(normalize_public_origin("http://chat.example.com").is_none());
        assert!(normalize_public_origin("https://chat.example.com/path").is_none());
        assert!(normalize_public_origin("https://user@chat.example.com").is_none());
        assert!(normalize_public_origin("javascript:alert(1)").is_none());
    }

    // === anonymous_rate_limit 单元测试 ===
    // 无 Redis 时降级放行（开发模式），不返回 TOO_MANY_REQUESTS。

    #[tokio::test]
    async fn anonymous_rate_limit_passes_without_redis() {
        let (state, _, _) = authenticated_state("maya_chen");
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_str("203.0.113.1").unwrap(),
        );
        // 无 Redis → 放行
        assert!(
            anonymous_rate_limit(&state, &headers, "test", 1, 60)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn anonymous_rate_limit_uses_anonymous_when_no_xff() {
        let (state, _, _) = authenticated_state("maya_chen");
        let headers = HeaderMap::new();
        // 无 X-Forwarded-For + 无 Redis → 放行（subject 降级为 "anonymous"）
        assert!(
            anonymous_rate_limit(&state, &headers, "test", 1, 60)
                .await
                .is_ok()
        );
    }

    #[test]
    fn rate_limit_subject_accepts_only_a_valid_first_ip() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.8, 10.0.0.2"),
        );
        assert_eq!(rate_limit_subject(&headers), "203.0.113.8");
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("attacker-controlled-value"),
        );
        assert_eq!(rate_limit_subject(&headers), "anonymous");
    }

    // === read_directory 限流测试 ===
    // 无 Redis 时 authenticated_rate_limit 降级放行，read_directory 正常工作。

    #[tokio::test]
    async fn read_directory_works_without_redis_rate_limit() {
        let (state, headers, _) = authenticated_state("maya_chen");
        // read_directory 现在先调用 authenticated_rate_limit（无 Redis 放行），
        // 再调用 authenticated_device 验证。认证用户的 token 有效，应返回 OK。
        let response = read_directory(State(state.clone()), Path("maya_chen".into()), headers)
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }

    // === create_challenge 限流测试 ===
    // 无 Redis 时匿名限流放行；未注册的 device_id 返回 NOT_FOUND（而非限流错误）。

    #[tokio::test]
    async fn create_challenge_passes_rate_limit_without_redis() {
        let (state, _, device_id) = authenticated_state("maya_chen");
        let headers = HeaderMap::new();
        // 无 Redis → 限流放行；device_id 已注册 → 返回 CREATED（挑战已创建）
        let (status, _) = create_challenge(State(state), Path(device_id), headers).await;
        assert_eq!(status, StatusCode::CREATED);
    }

    #[test]
    fn admin_token_requires_exact_secret() {
        let secret = "9wL7j80bwK0v2N8zQ4L5f1dU7pR3mX6c";
        assert!(admin_token_matches(secret, secret));
        assert!(!admin_token_matches(
            secret,
            "9wL7j80bwK0v2N8zQ4L5f1dU7pR3mX6d"
        ));
        assert!(!admin_token_matches(secret, ""));
    }

    #[tokio::test]
    async fn contact_request_does_not_enumerate_into_database_errors() {
        let (state, headers, _) = authenticated_state("maya_chen");
        let response = create_contact_request(State(state), headers, Path("missing_user".into()))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
