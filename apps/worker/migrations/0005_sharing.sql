-- Sharing: a vault's members, invites (to a vault, or to the app alone), and who invited whom.
-- Added, not changed, so the previous Worker still runs on this database (it reads only owners).
--
-- A member is one of the vault's humans (`human`, its id in the vault's config): the owner, a member
-- who acts as their human on the dashboard, or a viewer who only reads. The owner's row mirrors
-- `vaults.owner`, which stays the source of truth for ownership.
CREATE TABLE vault_members (
  vault_id TEXT NOT NULL REFERENCES vaults (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  human TEXT,
  added_by TEXT REFERENCES users (id),
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (vault_id, user_id)
);

CREATE INDEX vault_members_user ON vault_members (user_id);

INSERT INTO vault_members (vault_id, user_id, role, added_by, created, updated)
  SELECT id, owner, 'owner', owner, created, updated FROM vaults WHERE owner IS NOT NULL;

-- An invite: to a vault (`vault_id`, with the role and human it grants) or, with no vault, to the app.
-- `id` is the SHA-256 of the invite's token, which is shown once (as a link). An invite for a login
-- (`provider`, `login`) can only be accepted by that account. Accepted invites stay: they are the
-- referral graph (who brought whom, and when), so `vault_id` has no foreign key and outlives its vault.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  vault_id TEXT,
  role TEXT CHECK (role IS NULL OR role IN ('member', 'viewer')),
  human TEXT,
  domains TEXT,
  provider TEXT CHECK (provider IS NULL OR provider IN ('github', 'gitlab')),
  login TEXT,
  created_by TEXT NOT NULL REFERENCES users (id),
  created TEXT NOT NULL,
  expires TEXT NOT NULL,
  accepted_by TEXT REFERENCES users (id),
  accepted TEXT,
  revoked TEXT
);

CREATE INDEX invites_vault ON invites (vault_id);
CREATE INDEX invites_creator ON invites (created_by);
CREATE INDEX invites_login ON invites (provider, login COLLATE NOCASE);

-- The first invite a user accepted, and whether they may invite others (an admin can stop them).
ALTER TABLE users ADD COLUMN invited_by TEXT REFERENCES users (id);
ALTER TABLE users ADD COLUMN can_invite INTEGER NOT NULL DEFAULT 1;

-- Who minted a key, so a member's keys go when they leave.
ALTER TABLE keys ADD COLUMN created_by TEXT REFERENCES users (id);
