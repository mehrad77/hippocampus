-- People as Hippocampus's own users, apart from how they sign in, so a vault can be shared with them and
-- sign-in can later go beyond GitHub. Added, not changed, so the previous Worker still runs on this database.
--
-- `users.id` is ours ('u_' + 20 hex digits). Each GitHub account's `accounts` row stays, keyed by GitHub's
-- id, and is still written on every change (registry.ts mirrors status, note and epoch into `users`): the
-- previous Worker reads only `accounts`. `legacy_account` links the two until nothing reads `accounts`.
-- `last_vault` is the vault the dashboard opens when it isn't told which.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waitlisted', 'approved', 'denied', 'deleted')),
  note TEXT,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  last_vault TEXT,
  legacy_account INTEGER UNIQUE REFERENCES accounts (id),
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);

-- How a user signs in or is recognized: a provider's stable id (`subject`) and its current login, which
-- can change. GitLab identities come from connecting GitLab, not from signing in (yet).
CREATE TABLE identities (
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  subject TEXT NOT NULL,
  login TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE INDEX identities_user ON identities (user_id);
CREATE INDEX identities_login ON identities (provider, login COLLATE NOCASE);

-- The user who owns the vault. `account_id` stays its GitHub account, which the previous Worker reads.
-- A vault made by the previous Worker (after a rollback) has none; registry.ts falls back to account_id.
ALTER TABLE vaults ADD COLUMN owner TEXT REFERENCES users (id);

INSERT INTO users (id, name, status, note, session_epoch, legacy_account, created, updated)
  SELECT 'u_' || lower(hex(randomblob(10))), login, status, note, session_epoch, id, created, updated FROM accounts;

INSERT INTO identities (provider, subject, login, user_id, created, updated)
  SELECT 'github', CAST(a.id AS TEXT), a.login, u.id, a.created, a.updated FROM accounts a JOIN users u ON u.legacy_account = a.id;

INSERT INTO identities (provider, subject, login, user_id, created, updated)
  SELECT 'gitlab', CAST(g.gitlab_user_id AS TEXT), g.gitlab_login, u.id, g.updated, g.updated FROM gitlab_credentials g JOIN users u ON u.legacy_account = g.account_id
  WHERE true ON CONFLICT (provider, subject) DO NOTHING;

UPDATE vaults SET owner = (SELECT u.id FROM users u WHERE u.legacy_account = vaults.account_id);

CREATE INDEX vaults_owner ON vaults (owner);
