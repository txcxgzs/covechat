CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
    device_id UUID PRIMARY KEY,
    username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    revoked_at BIGINT,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_username_active_idx
    ON devices(username) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS envelopes (
    envelope_id UUID PRIMARY KEY,
    recipient_device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS envelopes_recipient_expiry_idx
    ON envelopes(recipient_device_id, expires_at);

CREATE TABLE IF NOT EXISTS delivery_counters (
    sender_device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL,
    last_sequence BIGINT NOT NULL CHECK (last_sequence > 0),
    PRIMARY KEY (sender_device_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key TEXT PRIMARY KEY,
    expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx
    ON idempotency_keys(expires_at);

CREATE TABLE IF NOT EXISTS backups (
    username TEXT PRIMARY KEY REFERENCES accounts(username) ON DELETE CASCADE,
    version BIGINT NOT NULL CHECK (version > 0),
    ciphertext_digest TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments (
    object_id UUID PRIMARY KEY,
    owner_device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
    ciphertext_size BIGINT NOT NULL CHECK (ciphertext_size > 0),
    expires_at BIGINT NOT NULL,
    finalized BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachment_chunks (
    object_id UUID NOT NULL REFERENCES attachments(object_id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    ciphertext_digest TEXT NOT NULL,
    ciphertext_size BIGINT NOT NULL CHECK (ciphertext_size > 0),
    ciphertext TEXT,
    PRIMARY KEY (object_id, chunk_index)
);
