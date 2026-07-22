use std::collections::HashMap;

use anyhow::Context;
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use uuid::Uuid;

use super::{
    AbuseReport, AccountIdentity, AttachmentChunk, AttachmentObject, DeviceRecord, EncryptedBackup,
    EncryptedEnvelope, Store,
};

#[derive(Clone)]
pub struct Persistence {
    pool: PgPool,
}

impl Persistence {
    pub async fn admin_overview(&self) -> anyhow::Result<serde_json::Value> {
        let row = sqlx::query(
            "SELECT
              (SELECT count(*) FROM accounts) AS accounts,
              (SELECT count(*) FROM devices WHERE revoked_at IS NULL) AS active_devices,
              (SELECT count(*) FROM abuse_reports WHERE status = 'pending') AS pending_reports,
              (SELECT count(*) FROM account_suspensions) AS suspended_accounts",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(serde_json::json!({
            "accounts": row.get::<i64, _>("accounts"),
            "activeDevices": row.get::<i64, _>("active_devices"),
            "pendingReports": row.get::<i64, _>("pending_reports"),
            "suspendedAccounts": row.get::<i64, _>("suspended_accounts"),
        }))
    }

    pub async fn admin_accounts(&self) -> anyhow::Result<Vec<serde_json::Value>> {
        let rows = sqlx::query(
            "SELECT a.username, extract(epoch from a.created_at)::bigint AS created_at, count(d.device_id) AS device_count,
                    count(d.device_id) FILTER (WHERE d.revoked_at IS NULL) AS active_devices,
                    s.reason AS suspension_reason
             FROM accounts a LEFT JOIN devices d ON d.username = a.username
             LEFT JOIN account_suspensions s ON s.username = a.username
             GROUP BY a.username, a.created_at, s.reason ORDER BY a.created_at DESC LIMIT 500"
        ).fetch_all(&self.pool).await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                serde_json::json!({
                    "username": row.get::<String, _>("username"),
                    "createdAt": row.get::<i64, _>("created_at"),
                    "deviceCount": row.get::<i64, _>("device_count"),
                    "activeDevices": row.get::<i64, _>("active_devices"),
                    "suspended": row.get::<Option<String>, _>("suspension_reason").is_some(),
                    "suspensionReason": row.get::<Option<String>, _>("suspension_reason"),
                })
            })
            .collect())
    }

    pub async fn admin_reports(&self) -> anyhow::Result<Vec<serde_json::Value>> {
        let rows = sqlx::query(
            "SELECT report_id, reported_username, payload, status, resolution_note,
                    extract(epoch from created_at)::bigint AS created_at,
                    extract(epoch from resolved_at)::bigint AS resolved_at
             FROM abuse_reports ORDER BY created_at DESC LIMIT 500",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                serde_json::json!({
                    "reportId": row.get::<Uuid, _>("report_id"),
                    "reportedUsername": row.get::<String, _>("reported_username"),
                    "payload": row.get::<serde_json::Value, _>("payload"),
                    "status": row.get::<String, _>("status"),
                    "resolutionNote": row.get::<Option<String>, _>("resolution_note"),
                    "createdAt": row.get::<i64, _>("created_at"),
                    "resolvedAt": row.get::<Option<i64>, _>("resolved_at"),
                })
            })
            .collect())
    }

    pub async fn admin_resolve_report(
        &self,
        report_id: Uuid,
        status: &str,
        note: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE abuse_reports SET status = $2, resolution_note = $3, resolved_at = now()
             WHERE report_id = $1",
        )
        .bind(report_id)
        .bind(status)
        .bind(note)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn admin_suspend_account(
        &self,
        username: &str,
        reason: &str,
        suspended: bool,
    ) -> anyhow::Result<bool> {
        let exists = sqlx::query("SELECT 1 FROM accounts WHERE username = $1")
            .bind(username)
            .fetch_optional(&self.pool)
            .await?
            .is_some();
        if !exists {
            return Ok(false);
        }
        if suspended {
            sqlx::query("INSERT INTO account_suspensions(username, reason) VALUES ($1, $2) ON CONFLICT(username) DO UPDATE SET reason = EXCLUDED.reason, created_at = now()")
                .bind(username).bind(reason).execute(&self.pool).await?;
        } else {
            sqlx::query("DELETE FROM account_suspensions WHERE username = $1")
                .bind(username)
                .execute(&self.pool)
                .await?;
        }
        Ok(true)
    }

    pub async fn account_suspended(&self, username: &str) -> anyhow::Result<bool> {
        Ok(
            sqlx::query("SELECT 1 FROM account_suspensions WHERE username = $1")
                .bind(username)
                .fetch_optional(&self.pool)
                .await?
                .is_some(),
        )
    }

    pub async fn admin_audit(
        &self,
        action: &str,
        target: &str,
        detail: serde_json::Value,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO admin_audit_log(audit_id, action, target, detail) VALUES ($1, $2, $3, $4)",
        )
        .bind(Uuid::new_v4())
        .bind(action)
        .bind(target)
        .bind(detail)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn admin_audit_log(&self) -> anyhow::Result<Vec<serde_json::Value>> {
        let rows = sqlx::query("SELECT audit_id, action, target, detail, extract(epoch from created_at)::bigint AS created_at FROM admin_audit_log ORDER BY created_at DESC LIMIT 500")
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|row| serde_json::json!({
            "auditId": row.get::<Uuid, _>("audit_id"), "action": row.get::<String, _>("action"),
            "target": row.get::<String, _>("target"), "detail": row.get::<serde_json::Value, _>("detail"),
            "createdAt": row.get::<i64, _>("created_at"),
        })).collect())
    }

    pub async fn delete_account(&self, username: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM accounts WHERE username = $1")
            .bind(username)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
    pub async fn connect_from_env() -> anyhow::Result<Option<Self>> {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            return Ok(None);
        };
        let pool = PgPoolOptions::new()
            .max_connections(20)
            .connect(&database_url)
            .await
            .context("connect PostgreSQL")?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .context("run PostgreSQL migrations")?;
        Ok(Some(Self { pool }))
    }

    pub async fn hydrate(&self) -> anyhow::Result<Store> {
        let mut store = Store::default();
        for row in sqlx::query("SELECT payload FROM accounts")
            .fetch_all(&self.pool)
            .await?
        {
            let account: AccountIdentity = serde_json::from_value(row.try_get("payload")?)?;
            store.accounts.insert(account.username.clone(), account);
        }
        for row in sqlx::query("SELECT payload FROM devices")
            .fetch_all(&self.pool)
            .await?
        {
            let device: DeviceRecord = serde_json::from_value(row.try_get("payload")?)?;
            store.devices.insert(device.device_id, device);
        }
        for row in sqlx::query("SELECT payload FROM envelopes WHERE expires_at > $1")
            .bind(super::unix_now() as i64)
            .fetch_all(&self.pool)
            .await?
        {
            let envelope: EncryptedEnvelope = serde_json::from_value(row.try_get("payload")?)?;
            store
                .envelopes
                .entry(envelope.recipient_device_id)
                .or_default()
                .push(envelope);
        }
        for row in sqlx::query(
            "SELECT sender_device_id, conversation_id, last_sequence FROM delivery_counters",
        )
        .fetch_all(&self.pool)
        .await?
        {
            store.last_sequence.insert(
                (
                    row.try_get("sender_device_id")?,
                    row.try_get("conversation_id")?,
                ),
                row.try_get::<i64, _>("last_sequence")? as u64,
            );
        }
        for row in sqlx::query(
            "SELECT idempotency_key, expires_at FROM idempotency_keys WHERE expires_at > $1",
        )
        .bind(super::unix_now() as i64)
        .fetch_all(&self.pool)
        .await?
        {
            store.idempotency.insert(
                row.try_get("idempotency_key")?,
                row.try_get::<i64, _>("expires_at")? as u64,
            );
        }
        for row in sqlx::query("SELECT username, payload FROM backups")
            .fetch_all(&self.pool)
            .await?
        {
            let username: String = row.try_get("username")?;
            let backup: EncryptedBackup = serde_json::from_value(row.try_get("payload")?)?;
            store.backups.insert(username, backup);
        }
        for row in sqlx::query(
            "SELECT object_id, owner_device_id, chunk_count, ciphertext_size, expires_at, finalized
             FROM attachments WHERE expires_at > $1",
        )
        .bind(super::unix_now() as i64)
        .fetch_all(&self.pool)
        .await?
        {
            let object_id: Uuid = row.try_get("object_id")?;
            store.attachments.insert(
                object_id,
                AttachmentObject {
                    owner_device_id: row.try_get("owner_device_id")?,
                    chunk_count: row.try_get::<i32, _>("chunk_count")? as u32,
                    ciphertext_size: row.try_get::<i64, _>("ciphertext_size")? as u64,
                    expires_at: row.try_get::<i64, _>("expires_at")? as u64,
                    chunks: HashMap::new(),
                    finalized: row.try_get("finalized")?,
                },
            );
        }
        for row in sqlx::query(
            "SELECT object_id, chunk_index, ciphertext_digest, ciphertext_size, ciphertext
             FROM attachment_chunks",
        )
        .fetch_all(&self.pool)
        .await?
        {
            let object_id: Uuid = row.try_get("object_id")?;
            if let Some(object) = store.attachments.get_mut(&object_id) {
                object.chunks.insert(
                    row.try_get::<i32, _>("chunk_index")? as u32,
                    AttachmentChunk {
                        ciphertext_digest: row.try_get("ciphertext_digest")?,
                        ciphertext_size: row.try_get::<i64, _>("ciphertext_size")? as u64,
                        ciphertext: row
                            .try_get::<Option<String>, _>("ciphertext")?
                            .unwrap_or_default(),
                    },
                );
            }
        }
        for row in sqlx::query("SELECT payload FROM abuse_reports")
            .fetch_all(&self.pool)
            .await?
        {
            let report: AbuseReport = serde_json::from_value(row.try_get("payload")?)?;
            store.abuse_reports.insert(report.report_id, report);
        }
        for row in sqlx::query("SELECT blocker_username, blocked_username FROM user_blocks")
            .fetch_all(&self.pool)
            .await?
        {
            store.blocks.insert((
                row.try_get("blocker_username")?,
                row.try_get("blocked_username")?,
            ));
        }
        Ok(store)
    }

    pub async fn read_deployment_setting(&self, key: &str) -> anyhow::Result<Option<String>> {
        Ok(
            sqlx::query("SELECT setting_value FROM deployment_settings WHERE setting_key = $1")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?
                .map(|row| row.get("setting_value")),
        )
    }

    pub async fn write_deployment_setting(&self, key: &str, value: &str) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO deployment_settings (setting_key, setting_value) VALUES ($1, $2)
             ON CONFLICT (setting_key) DO UPDATE
             SET setting_value = EXCLUDED.setting_value, updated_at = now()",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn onboard(
        &self,
        account: &AccountIdentity,
        device: &DeviceRecord,
    ) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("INSERT INTO accounts (username, payload) VALUES ($1, $2)")
            .bind(&account.username)
            .bind(serde_json::to_value(account)?)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO devices (device_id, username, revoked_at, payload)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(device.device_id)
        .bind(&device.username)
        .bind(device.revoked_at.map(|value| value as i64))
        .bind(serde_json::to_value(device)?)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn insert_device(&self, device: &DeviceRecord) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO devices (device_id, username, revoked_at, payload)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(device.device_id)
        .bind(&device.username)
        .bind(device.revoked_at.map(|value| value as i64))
        .bind(serde_json::to_value(device)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_device(&self, device: &DeviceRecord) -> anyhow::Result<()> {
        sqlx::query("UPDATE devices SET revoked_at = $2, payload = $3 WHERE device_id = $1")
            .bind(device.device_id)
            .bind(device.revoked_at.map(|value| value as i64))
            .bind(serde_json::to_value(device)?)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn recover_device(
        &self,
        revoked_devices: &[DeviceRecord],
        new_device: &DeviceRecord,
    ) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await?;
        for device in revoked_devices {
            sqlx::query("UPDATE devices SET revoked_at = $2, payload = $3 WHERE device_id = $1")
                .bind(device.device_id)
                .bind(device.revoked_at.map(|value| value as i64))
                .bind(serde_json::to_value(device)?)
                .execute(&mut *transaction)
                .await?;
        }
        sqlx::query(
            "INSERT INTO devices (device_id, username, revoked_at, payload)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(new_device.device_id)
        .bind(&new_device.username)
        .bind(new_device.revoked_at.map(|value| value as i64))
        .bind(serde_json::to_value(new_device)?)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn insert_envelope(&self, envelope: &EncryptedEnvelope) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await?;
        let counter = sqlx::query(
            "INSERT INTO delivery_counters
             (sender_device_id, conversation_id, last_sequence)
             VALUES ($1, $2, $3)
             ON CONFLICT (sender_device_id, conversation_id) DO UPDATE
             SET last_sequence = EXCLUDED.last_sequence
             WHERE delivery_counters.last_sequence < EXCLUDED.last_sequence",
        )
        .bind(envelope.sender_device_id)
        .bind(envelope.conversation_id)
        .bind(envelope.sequence as i64)
        .execute(&mut *transaction)
        .await?;
        if counter.rows_affected() != 1 {
            anyhow::bail!("non-monotonic envelope sequence");
        }
        sqlx::query(
            "INSERT INTO idempotency_keys (idempotency_key, expires_at)
             VALUES ($1, $2)",
        )
        .bind(&envelope.idempotency_key)
        .bind(envelope.expires_at as i64)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO envelopes
             (envelope_id, recipient_device_id, expires_at, idempotency_key, payload)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(envelope.envelope_id)
        .bind(envelope.recipient_device_id)
        .bind(envelope.expires_at as i64)
        .bind(&envelope.idempotency_key)
        .bind(serde_json::to_value(envelope)?)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn delete_envelope(&self, envelope_id: Uuid) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM envelopes WHERE envelope_id = $1")
            .bind(envelope_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn upsert_backup(
        &self,
        username: &str,
        backup: &EncryptedBackup,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO backups (username, version, ciphertext_digest, payload)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (username) DO UPDATE SET
             version = EXCLUDED.version,
             ciphertext_digest = EXCLUDED.ciphertext_digest,
             payload = EXCLUDED.payload,
             created_at = now()
             WHERE backups.version + 1 = EXCLUDED.version
               AND backups.ciphertext_digest = (EXCLUDED.payload->>'previousDigest')",
        )
        .bind(username)
        .bind(backup.version as i64)
        .bind(&backup.ciphertext_digest)
        .bind(serde_json::to_value(backup)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_abuse_report(&self, report: &AbuseReport) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO abuse_reports
             (report_id, reporter_device_id, reported_username, payload)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(report.report_id)
        .bind(report.reporter_device_id)
        .bind(&report.reported_username)
        .bind(serde_json::to_value(report)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_user_block(
        &self,
        blocker_username: &str,
        blocked_username: &str,
        blocked: bool,
    ) -> anyhow::Result<()> {
        if blocked {
            sqlx::query(
                "INSERT INTO user_blocks (blocker_username, blocked_username)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING",
            )
            .bind(blocker_username)
            .bind(blocked_username)
            .execute(&self.pool)
            .await?;
        } else {
            sqlx::query(
                "DELETE FROM user_blocks
                 WHERE blocker_username = $1 AND blocked_username = $2",
            )
            .bind(blocker_username)
            .bind(blocked_username)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    pub async fn insert_attachment(
        &self,
        object_id: Uuid,
        object: &AttachmentObject,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO attachments
             (object_id, owner_device_id, chunk_count, ciphertext_size, expires_at, finalized)
             VALUES ($1, $2, $3, $4, $5, FALSE)",
        )
        .bind(object_id)
        .bind(object.owner_device_id)
        .bind(object.chunk_count as i32)
        .bind(object.ciphertext_size as i64)
        .bind(object.expires_at as i64)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_attachment_chunk(
        &self,
        object_id: Uuid,
        chunk_index: u32,
        chunk: &AttachmentChunk,
        store_ciphertext: bool,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO attachment_chunks
             (object_id, chunk_index, ciphertext_digest, ciphertext_size, ciphertext)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (object_id, chunk_index) DO NOTHING",
        )
        .bind(object_id)
        .bind(chunk_index as i32)
        .bind(&chunk.ciphertext_digest)
        .bind(chunk.ciphertext_size as i64)
        .bind(store_ciphertext.then_some(chunk.ciphertext.as_str()))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn finalize_attachment(&self, object_id: Uuid) -> anyhow::Result<()> {
        sqlx::query("UPDATE attachments SET finalized = TRUE WHERE object_id = $1")
            .bind(object_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_attachment(&self, object_id: Uuid) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM attachments WHERE object_id = $1")
            .bind(object_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn cleanup_expired(&self, now: u64) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM envelopes WHERE expires_at <= $1")
            .bind(now as i64)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM idempotency_keys WHERE expires_at <= $1")
            .bind(now as i64)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM attachments WHERE expires_at <= $1")
            .bind(now as i64)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }
}
