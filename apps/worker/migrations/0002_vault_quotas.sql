-- An admin's overrides of one vault's hosted limits (quotas.ts), as JSON, e.g. {"sleepRunsPerDay":96}.
-- NULL means the defaults. Added, not changed, so the previous Worker still reads the table.
ALTER TABLE vaults ADD COLUMN quotas TEXT;
