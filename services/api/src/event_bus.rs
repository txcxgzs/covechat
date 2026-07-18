use std::time::Duration;

use anyhow::Context;
use futures_util::StreamExt;
use redis::aio::ConnectionManager;
use tokio::sync::broadcast;
use uuid::Uuid;

const CHANNEL: &str = "covechat:mailbox-events:v1";

#[derive(Clone)]
pub struct EventBus {
    local: broadcast::Sender<String>,
    publisher: Option<ConnectionManager>,
}

impl EventBus {
    pub fn local() -> Self {
        let (local, _) = broadcast::channel(1024);
        Self {
            local,
            publisher: None,
        }
    }

    pub async fn connect_from_env() -> anyhow::Result<Self> {
        let (local, _) = broadcast::channel(1024);
        let Ok(url) = std::env::var("REDIS_URL") else {
            return Ok(Self::local());
        };
        let client = redis::Client::open(url).context("parse event bus REDIS_URL")?;
        let publisher = client
            .get_connection_manager()
            .await
            .context("connect Redis event publisher")?;
        let subscriber_client = client.clone();
        let target = local.clone();
        tokio::spawn(async move {
            loop {
                let result = async {
                    let mut subscriber = subscriber_client.get_async_pubsub().await?;
                    subscriber.subscribe(CHANNEL).await?;
                    let mut messages = subscriber.on_message();
                    while let Some(message) = messages.next().await {
                        let payload: String = message.get_payload()?;
                        let _ = target.send(payload);
                    }
                    Ok::<(), redis::RedisError>(())
                }
                .await;
                if let Err(error) = result {
                    tracing::error!(error = %error, "Redis event subscriber disconnected");
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
        Ok(Self {
            local,
            publisher: Some(publisher),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.local.subscribe()
    }

    pub async fn publish(&self, device_id: Uuid) -> anyhow::Result<()> {
        let payload = device_id.to_string();
        let _ = self.local.send(payload.clone());
        if let Some(connection) = &self.publisher {
            let mut connection = connection.clone();
            let _: u64 = redis::cmd("PUBLISH")
                .arg(CHANNEL)
                .arg(payload)
                .query_async(&mut connection)
                .await?;
        }
        Ok(())
    }

    pub fn distributed(&self) -> bool {
        self.publisher.is_some()
    }
}
