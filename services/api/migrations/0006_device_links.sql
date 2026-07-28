CREATE TABLE IF NOT EXISTS device_links (
    link_id UUID PRIMARY KEY,
    expires_at BIGINT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_links_expiry_idx ON device_links(expires_at);
