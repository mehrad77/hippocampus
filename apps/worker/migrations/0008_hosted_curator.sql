-- Hosted curation: the Worker runs sleep itself with the owner's own model key, under a hard budget.
-- Added, not changed, so the previous Worker still runs on this database (it reads none of it).

-- An account's model key and budget. `secret` is the key, sealed with HIPPO_TOKEN_KEY (AES-GCM, bound
-- to the account id), so a database dump alone can't use it. `steps` is JSON {step: model}. Money is
-- integer micro-dollars. `paused` is why runs wait: "auth" or "credit" until the owner saves a key
-- again, "budget:<YYYY-MM>" until that month is over or the cap is raised.
CREATE TABLE llm_credentials (
  account_id INTEGER PRIMARY KEY REFERENCES accounts (id),
  provider TEXT NOT NULL,
  steps TEXT NOT NULL,
  secret TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  month_cap_micros INTEGER NOT NULL,
  run_cap_micros INTEGER NOT NULL,
  paused TEXT,
  updated TEXT NOT NULL
);

-- What an account spent on models in a UTC month (YYYY-MM).
CREATE TABLE llm_spend (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  month TEXT NOT NULL,
  micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

-- Money held for a model call in flight. One is made only when spend plus every live reservation
-- stays under the month's cap, in one statement, so two vaults of one account can't overspend
-- together. A reservation left by an evicted object counts as spent when it expires.
CREATE TABLE llm_reservations (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  month TEXT NOT NULL,
  micros INTEGER NOT NULL,
  expires TEXT NOT NULL
);
CREATE INDEX llm_reservations_account ON llm_reservations (account_id, month);

-- A vault's hosted curation: JSON {"hourUtc": 0-23}, or NULL when it's off. Also what the Cron
-- backstop reads to re-arm a lost alarm.
ALTER TABLE vaults ADD COLUMN hosted_curator TEXT;
