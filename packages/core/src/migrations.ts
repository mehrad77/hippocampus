import { parseDocument } from "yaml";
import { CONFIG_PATH } from "./config.ts";
import type { HippoConfig } from "./schema.ts";
import type { VaultStore } from "./store.ts";

/** The vault format this build of Hippocampus reads and writes. */
export const CURRENT_VAULT_VERSION = 1;

export interface Migration {
  from: number;
  to: number;
  description: string;
  /** Rewrite vault files for the new format. Returns the paths changed. */
  run(store: VaultStore): Promise<string[]>;
}

/** Ordered list of format migrations. Empty while the format is still v1. */
export const MIGRATIONS: Migration[] = [];

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
  changed: string[];
}

/** Run pending migrations in order and bump `version` in the config (comments preserved). */
export async function migrate(store: VaultStore, config: Pick<HippoConfig, "version">, opts: { dryRun?: boolean } = {}): Promise<MigrateResult> {
  if (vaultVersionStatus(config) === "newer") assertVaultVersion(config);
  const result: MigrateResult = { from: config.version, to: config.version, applied: [], changed: [] };
  let version = config.version;
  for (const m of MIGRATIONS) {
    if (m.from !== version) continue;
    result.applied.push(`v${m.from} → v${m.to}: ${m.description}`);
    if (!opts.dryRun) result.changed.push(...(await m.run(store)));
    version = m.to;
  }
  if (version !== CURRENT_VAULT_VERSION && version < CURRENT_VAULT_VERSION)
    throw new VaultVersionError(`no migration path from v${version} to v${CURRENT_VAULT_VERSION}`);
  result.to = version;
  if (version !== config.version && !opts.dryRun) {
    const doc = parseDocument((await store.read(CONFIG_PATH)) ?? "");
    doc.set("version", version);
    await store.write(CONFIG_PATH, doc.toString());
    result.changed.push(CONFIG_PATH);
  }
  return result;
}
