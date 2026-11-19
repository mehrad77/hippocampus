-- GitHub organizations that may hold vaults. An org asks the first time someone ties
-- one of its installations to their account; an admin approves or denies it, as with accounts.
-- Added, not changed, so the previous Worker still runs on this database (it reads none of it).

-- `subject` is the provider's own id for the org (GitHub's numeric account id, as text), which survives
-- renames. `installation_id` is the app's install there, so a person can pick its repos up again.
-- `requested_by` is the user who first asked. No CHECK on `provider`: GitLab groups come later, and
-- SQLite can't relax a CHECK.
CREATE TABLE orgs (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  login TEXT NOT NULL,
  installation_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('waitlisted', 'approved', 'denied')),
  requested_by TEXT REFERENCES users (id),
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE INDEX orgs_status ON orgs (status, created);

-- Who has tried an org's install: their setup page lists the org and how far it got.
CREATE TABLE org_requests (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  at TEXT NOT NULL,
  PRIMARY KEY (provider, subject, user_id),
  FOREIGN KEY (provider, subject) REFERENCES orgs (provider, subject)
);

CREATE INDEX org_requests_user ON org_requests (user_id);
