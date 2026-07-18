CREATE TABLE IF NOT EXISTS abuse_reports (
    report_id UUID PRIMARY KEY,
    reporter_device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    reported_username TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    blocked_username TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_username, blocked_username),
    CHECK (blocker_username <> blocked_username)
);
