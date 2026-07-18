use anyhow::{Context, bail};
use aws_config::{BehaviorVersion, Region};
use aws_sdk_s3::{Client, primitives::ByteStream};
use tokio::time::{Duration, sleep};
use uuid::Uuid;

const CONNECT_ATTEMPTS: usize = 30;
const CONNECT_RETRY_DELAY: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct ObjectStore {
    client: Client,
    bucket: String,
}

impl ObjectStore {
    pub async fn connect_from_env() -> anyhow::Result<Option<Self>> {
        let Ok(endpoint) = std::env::var("S3_ENDPOINT") else {
            return Ok(None);
        };
        let bucket =
            std::env::var("S3_BUCKET").unwrap_or_else(|_| "covechat-attachments".to_string());
        if !valid_bucket_name(&bucket) {
            bail!("invalid S3_BUCKET");
        }
        let region = std::env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
        let shared = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(region))
            .endpoint_url(endpoint)
            .load()
            .await;
        let config = aws_sdk_s3::config::Builder::from(&shared)
            .force_path_style(true)
            .build();
        let object_store = Self {
            client: Client::from_conf(config),
            bucket,
        };
        object_store.ensure_bucket_with_retry().await?;
        Ok(Some(object_store))
    }

    async fn ensure_bucket_with_retry(&self) -> anyhow::Result<()> {
        let mut last_error = None;
        for attempt in 1..=CONNECT_ATTEMPTS {
            match self.ensure_bucket().await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    last_error = Some(error);
                    if attempt < CONNECT_ATTEMPTS {
                        tracing::warn!(
                            attempt,
                            max_attempts = CONNECT_ATTEMPTS,
                            "S3 attachment store is not ready; retrying"
                        );
                        sleep(CONNECT_RETRY_DELAY).await;
                    }
                }
            }
        }
        Err(last_error.expect("at least one S3 connection attempt"))
            .context("S3 attachment store did not become ready")
    }

    async fn ensure_bucket(&self) -> anyhow::Result<()> {
        if self
            .client
            .head_bucket()
            .bucket(&self.bucket)
            .send()
            .await
            .is_ok()
        {
            return Ok(());
        }
        self.client
            .create_bucket()
            .bucket(&self.bucket)
            .send()
            .await
            .context("create S3 attachment bucket")?;
        Ok(())
    }

    pub async fn put_chunk(
        &self,
        object_id: Uuid,
        chunk_index: u32,
        ciphertext: &str,
        digest: &str,
    ) -> anyhow::Result<()> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(chunk_key(object_id, chunk_index))
            .metadata("sha256", digest)
            .content_type("application/octet-stream")
            .body(ByteStream::from(ciphertext.as_bytes().to_vec()))
            .send()
            .await
            .context("put S3 attachment chunk")?;
        Ok(())
    }

    pub async fn get_chunk(&self, object_id: Uuid, chunk_index: u32) -> anyhow::Result<String> {
        let output = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(chunk_key(object_id, chunk_index))
            .send()
            .await
            .context("get S3 attachment chunk")?;
        let bytes = output
            .body
            .collect()
            .await
            .context("read S3 attachment chunk")?
            .into_bytes();
        String::from_utf8(bytes.to_vec()).context("S3 attachment chunk is not UTF-8")
    }

    pub async fn delete_attachment(&self, object_id: Uuid, chunk_count: u32) -> anyhow::Result<()> {
        for chunk_index in 0..chunk_count {
            self.client
                .delete_object()
                .bucket(&self.bucket)
                .key(chunk_key(object_id, chunk_index))
                .send()
                .await
                .context("delete S3 attachment chunk")?;
        }
        Ok(())
    }

    pub async fn delete_chunk(&self, object_id: Uuid, chunk_index: u32) -> anyhow::Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(chunk_key(object_id, chunk_index))
            .send()
            .await
            .context("delete S3 attachment chunk")?;
        Ok(())
    }
}

fn chunk_key(object_id: Uuid, chunk_index: u32) -> String {
    format!("attachments/{object_id}/{chunk_index:08}")
}

fn valid_bucket_name(value: &str) -> bool {
    (3..=63).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_keys_and_bucket_names_are_canonical() {
        let id = Uuid::nil();
        assert_eq!(
            chunk_key(id, 12),
            "attachments/00000000-0000-0000-0000-000000000000/00000012",
        );
        assert!(valid_bucket_name("covechat-attachments"));
        assert!(!valid_bucket_name("../escape"));
        assert!(!valid_bucket_name("Uppercase"));
    }
}
