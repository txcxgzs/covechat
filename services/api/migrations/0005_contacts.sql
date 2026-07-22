CREATE TABLE IF NOT EXISTS contact_requests (
    sender_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    recipient_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sender_username, recipient_username),
    CHECK (sender_username <> recipient_username)
);
CREATE INDEX IF NOT EXISTS contact_requests_recipient_idx
    ON contact_requests(recipient_username, created_at DESC);

CREATE TABLE IF NOT EXISTS contacts (
    username_low TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    username_high TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (username_low, username_high),
    CHECK (username_low < username_high)
);
CREATE INDEX IF NOT EXISTS contacts_high_idx ON contacts(username_high, created_at DESC);
