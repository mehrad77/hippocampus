-- An agent asking to connect on a person's behalf, the way command-line apps sign in (the OAuth device
-- grant, RFC 8628): it gets a short code, the person approves it on the dashboard (which vault, which
-- agent, what it may do), and the agent's next poll gets a key, minted then and never stored. Added,
-- not changed, so the previous Worker still runs. Rows expire after ten minutes and are pruned.
CREATE TABLE device_requests (
  id TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client TEXT NOT NULL,
  agent TEXT,
  access TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  vault_id TEXT,
  approved_by TEXT REFERENCES users (id),
  created TEXT NOT NULL,
  expires TEXT NOT NULL,
  polled TEXT
);

CREATE INDEX device_requests_expires ON device_requests (expires);
