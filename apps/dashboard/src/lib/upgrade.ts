import { ApiError } from "./api.ts";
import type { VaultUpgrade } from "./types.ts";

/** The hosted app's answer for a vault in an older format: nothing works until its owner upgrades it. */
export const UPGRADE_NEEDED = "VAULT_UPGRADE_NEEDED";

export function needsUpgrade(error: unknown): boolean {
  return error instanceof ApiError && error.code === UPGRADE_NEEDED;
}

/** What to tell the owner after they clicked Upgrade. */
export function upgradeSummary(r: VaultUpgrade): string {
  if (!r.upgraded) return "The vault was already in the current format.";
  const files = r.changed === 1 ? "1 file" : `${r.changed} files`;
  return `Upgraded the vault from format v${r.from} to v${r.to} (${files} changed, in one commit).`;
}
