import { parseDocument } from "yaml";
import { CONFIG_PATH, renderConfig } from "./config.ts";
import { HANDBOOK_PATH, renderHandbook } from "./handbook.ts";
import { v1ToV2 } from "./migrations/v1-to-v2.ts";
import type { HippoConfig } from "./schema.ts";
import { applyChanges, bufferedStore, type Change, type VaultStore } from "./store.ts";
import { ACTOR_TRAILER, actorTrailer, withTrailers } from "./trailers.ts";
import { Vault } from "./vault.ts";

/** The vault format this build of Hippocampus reads and writes. */
export const CURRENT_VAULT_VERSION = 2;

/** What a migration gets besides the store. */
export interface MigrationContext {
  /** The current template's files, by vault path (`TEMPLATE` from @hippocampus/template), for notes and scaffolding it adds. */
  template?: Record<string, string>;
  /** Tell the human about something the migration couldn't carry over as it was. */
  note(message: string): void;
}

export interface Migration {
  from: number;
  to: number;
  description: string;
  /** Rewrite vault files for the new format through `store` (a buffer: the changes are collected, then audited and committed). */
  run(store: VaultStore, ctx: MigrationContext): Promise<void>;
}

/** Ordered list of format migrations. */
export const MIGRATIONS: Migration[] = [v1ToV2];

export class VaultVersionError extends Error {}

export function vaultVersionStatus(config: Pick<HippoConfig, "version">): "current" | "older" | "newer" {
  if (config.version === CURRENT_VAULT_VERSION) return "current";
  return config.version < CURRENT_VAULT_VERSION ? "older" : "newer";
}

export function assertVaultVersion(config: Pick<HippoConfig, "version">): void {
  const status = vaultVersionStatus(config);
  if (status === "newer")
    throw new VaultVersionError(
      `vault format v${config.version} is newer than this Hippocampus (v${CURRENT_VAULT_VERSION}); upgrade the tool`,
    );
  if (status === "older")
    throw new VaultVersionError(`vault format v${config.version} is older than v${CURRENT_VAULT_VERSION}; run \`hippo migrate\``);
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
  /** The changes, to commit as one (and audit as the `migration` actor). Applied already unless `dryRun`. */
  changes: Change[];
  /** Paths changed. */
  changed: string[];
  /** What the human should know: things carried over in another shape, or left as they were. */
  notes: string[];
}

export interface MigrateOptions {
  /** Collect the changes without writing them. */
  dryRun?: boolean;
  /** The current template's files (see `MigrationContext.template`). */
  template?: Record<string, string>;
  /** Commit message for the changes. */
  message?: string;
}

/**
 * Run pending migrations in order over a buffer, bump `version` in the config (comments preserved)
 * and regenerate the handbook, then apply the changes to `store` as one batch, unless `dryRun`.
 */
export async function migrate(store: VaultStore, config: Pick<HippoConfig, "version">, opts: MigrateOptions = {}): Promise<MigrateResult> {
  if (vaultVersionStatus(config) === "newer") assertVaultVersion(config);
  const result: MigrateResult = { from: config.version, to: config.version, applied: [], changes: [], changed: [], notes: [] };
  const buffer = bufferedStore(store);
  const ctx: MigrationContext = { template: opts.template, note: (m) => void result.notes.push(m) };
  let version = config.version;
  for (const m of MIGRATIONS) {
    if (m.from !== version || m.to > CURRENT_VAULT_VERSION) continue;
    result.applied.push(`v${m.from} → v${m.to}: ${m.description}`);
    await m.run(buffer.store, ctx);
    version = m.to;
  }
  if (version !== CURRENT_VAULT_VERSION && version < CURRENT_VAULT_VERSION)
    throw new VaultVersionError(`no migration path from v${version} to v${CURRENT_VAULT_VERSION}`);
  result.to = version;
  if (version === config.version) return result;

  const doc = parseDocument((await buffer.store.read(CONFIG_PATH)) ?? "");
  if (doc.get("version") !== version) {
    doc.set("version", version);
    await buffer.store.write(CONFIG_PATH, renderConfig(doc));
  }
  const vault = await Vault.load(buffer.store, { skipVersionCheck: true });
  await buffer.store.write(HANDBOOK_PATH, renderHandbook(vault));

  result.changes = await buffer.changes();
  result.changed = result.changes.map((c) => c.path);
  if (!opts.dryRun)
    await applyChanges(store, result.changes, {
      message: withTrailers(opts.message ?? `chore: migrate vault format to v${version}`, { [ACTOR_TRAILER]: actorTrailer({ kind: "migration" }) }),
    });
  return result;
}
