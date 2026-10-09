import { HttpError, type HostedConnectedApp } from "@hippocampus/dashboard";
import type { GitHubApp } from "./github-app.ts";
import type { Account, Registry } from "./registry.ts";
import { clearPendingInstallation, pendingInstallation, type SessionKV } from "./session.ts";

// The account's own settings: the apps it connected, and deleting it. Deleting takes everything the
// hosted app holds for it; the vault repo itself is the person's own and stays on GitHub, untouched.

export type ConnectedApp = HostedConnectedApp;

/** The account's apps connected over OAuth. The Worker's OAuth provider answers this. */
export interface ConnectedApps {
  list(accountId: number): Promise<ConnectedApp[]>;
  /** Revoke one of the account's grants. False when the account has no grant with that id. */
  revoke(accountId: number, id: string): Promise<boolean>;
}

/** A grant id as the OAuth library makes them. */
export const GRANT_ID = /^[\w-]{1,64}$/;

export interface AccountHooks {
  /** Revoke the account's connector (OAuth) grants. */
  revokeOAuthGrants?: (accountId: number) => Promise<void>;
  /** Wipe the vault's Durable Object (its cache and index). */
  destroyVault?: (vaultId: string) => Promise<void>;
}

export interface DeleteAccountDeps {
  registry: Registry;
  app: GitHubApp;
  kv: SessionKV;
  hooks?: AccountHooks;
}

/**
 * Keys go first, so agents stop at once. The rows go last, in one batch that also bumps the
 * session epoch: if GitHub fails midway, the person is still signed in and can simply retry.
 */
export async function deleteAccount(accountId: number, deps: DeleteAccountDeps): Promise<{ vault?: string }> {
  const { registry, app, kv, hooks } = deps;
  const vault = await registry.vaultOf(accountId);
  const pending = await pendingInstallation(kv, accountId);
  if (vault) await registry.revokeAllKeys(vault.id);
  await hooks?.revokeOAuthGrants?.(accountId);
  if (vault) await hooks?.destroyVault?.(vault.id);
  for (const id of new Set([vault?.installationId, pending?.installationId])) if (id !== undefined) await app.deleteInstallation(id);
  await clearPendingInstallation(kv, accountId);
  await registry.removeAccount(accountId);
  return vault ? { vault: vault.id } : {};
}

/** The typed confirmation: the account's GitHub login, so a stray click can't delete anything. */
export function confirmDeletion(account: Account, body: unknown): void {
  const typed = (body as { confirm?: unknown } | undefined)?.confirm;
  const given = typeof typed === "string" ? typed.trim().replace(/^@/, "").toLowerCase() : "";
  if (given !== account.login.toLowerCase()) throw new HttpError(400, `To delete your account, type your GitHub login (${account.login}) as confirm.`, "CONFIRM");
}
