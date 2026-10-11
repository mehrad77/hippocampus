-- GitLab vaults. Added, not changed, so the previous Worker still reads these tables.
--
-- A vault's provider. GitLab vaults keep installation_id = 0 (it is NOT NULL, and SQLite can't relax that)
-- and store their project id NEGATED in repo_id: ids are only unique within one provider, and the
-- existing UNIQUE (repo_id) can't be dropped, so the sign keeps a GitLab project from colliding with
-- a GitHub repo. registry.ts converts at the edge; nothing else sees the negative value.
ALTER TABLE vaults ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';

-- An account's GitLab connection (OAuth). `secret` is the access and refresh tokens, sealed with
-- the Worker's HIPPO_TOKEN_KEY (AES-GCM, bound to the account id), so a database dump alone can't use them.
-- `version` makes refresh-token rotation compare-and-set: GitLab invalidates the old refresh token on use.
CREATE TABLE gitlab_credentials (
  account_id INTEGER PRIMARY KEY REFERENCES accounts (id),
  gitlab_user_id INTEGER NOT NULL,
  gitlab_login TEXT NOT NULL,
  secret TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated TEXT NOT NULL
);
