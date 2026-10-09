-- The hosted app's registry (D1): who has an account, which private repo holds their vault, and the
-- keys their agents use. Never vault content: memories stay in each person's own GitHub repo.

-- GitHub's numeric user id, which survives renames. A deleted account stays as a tombstone so its
-- session epoch only ever grows: an old session cookie can't come back to life on re-signup.
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waitlisted', 'approved', 'denied', 'deleted')),
  note TEXT,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);

CREATE INDEX accounts_status ON accounts (status, created);

-- One vault per account for now (enforced in code). `repo_id` is GitHub's, so renames and transfers
-- don't orphan it. `reason` says why a vault is disconnected, so only the matching event reconnects it.
CREATE TABLE vaults (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  installation_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('bootstrapping', 'ready', 'disconnected')),
  reason TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);

CREATE INDEX vaults_account ON vaults (account_id);
CREATE INDEX vaults_installation ON vaults (installation_id);

-- Only the SHA-256 of each key is stored; the key itself is shown once.
CREATE TABLE keys (
  hash TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults (id),
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'curator', 'bound')),
  agent TEXT,
  scopes TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  last_used TEXT
);

CREATE INDEX keys_vault ON keys (vault_id);

-- GitHub redelivers webhooks; each delivery is handled once. Pruned after a week.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);

CREATE INDEX webhook_deliveries_at ON webhook_deliveries (at);
