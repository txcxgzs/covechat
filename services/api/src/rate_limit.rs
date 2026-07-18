use anyhow::Context;
use redis::aio::ConnectionManager;

#[derive(Clone)]
pub struct RateLimiter {
    connection: ConnectionManager,
}

impl RateLimiter {
    pub async fn connect_from_env() -> anyhow::Result<Option<Self>> {
        let Ok(url) = std::env::var("REDIS_URL") else {
            return Ok(None);
        };
        let client = redis::Client::open(url).context("parse REDIS_URL")?;
        let connection = client
            .get_connection_manager()
            .await
            .context("connect Redis")?;
        Ok(Some(Self { connection }))
    }

    pub async fn check(
        &self,
        scope: &str,
        subject: &str,
        limit: u64,
        window_seconds: u64,
    ) -> anyhow::Result<bool> {
        let key = format!("covechat:rate:{scope}:{subject}");
        let mut connection = self.connection.clone();
        let count: u64 = redis::cmd("INCR")
            .arg(&key)
            .query_async(&mut connection)
            .await?;
        if count == 1 {
            let _: bool = redis::cmd("EXPIRE")
                .arg(&key)
                .arg(window_seconds)
                .query_async(&mut connection)
                .await?;
        }
        Ok(count <= limit)
    }
}
