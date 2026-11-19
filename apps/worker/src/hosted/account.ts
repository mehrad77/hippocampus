import { HttpError, type HostedConnectedApp } from "@hippocampus/dashboard";
import type { GitHubApp } from "./github-app.ts";
import type { GitLabAccess } from "./gitlab.ts";
import { keyCredential } from "../oauth.ts";
import type { Account, MemberVault, Registry } from "./registry.ts";
import { clearPendingInstallation, pendingInstallation, type SessionKV } from "./session.ts";

// The account's own settings: the apps it connected, and deleting it. Deleting takes everything the
// hosted app holds for it; the vault repos themselves are the person's own and stay untouched.

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
  /** Revoke the account's connector grants for one vault. */
  revokeVaultGrants?: (accountId: number, vaultId: string) => Promise<void>;
  /** Wipe the vault's Durable Object (its cache and index). */
  destroyVault?: (vaultId: string) => Promise<void>;
  /** Link (or unlink, `null`) a GitHub login to one of a vault's humans, in its config (someone joining or leaving). */
  linkHuman?: (vault: MemberVault, human: string, login: string | null, via: string, create?: { domains?: string[] }) => Promise<void>;
  /** Connections to a vault were revoked (`key:<hash>`, `oauth:<grant>`): free the agent names they held. */
  releaseCredentials?: (vaultId: string, credentials: string[]) => Promise<void>;
}

export interface DeleteAccountDeps {
  registry: Registry;
  app: GitHubApp;
  /** Set when the instance has GitLab: the account's connection is revoked there. */
  gitlab?: GitLabAccess;
  kv: SessionKV;
  hooks?: AccountHooks;
}

/**
 * Keys go first, so agents stop at once. The rows go last, in one batch that also bumps the
 * session epoch: if GitHub fails midway, the person is still signed in and can simply retry.
 */
export async function deleteAccount(account: Pick<Account, "id" | "user" | "login">, deps: DeleteAccountDeps): Promise<{ vaults: string[] }> {
  const { registry, app, gitlab, kv, hooks } = deps;
  const accountId = account.id;
  // Only the vaults it owns: one shared with it stays its owner's, with their keys and their installation.
  const all = await registry.vaultsOf(account);
  const vaults = all.filter((v) => v.role === "owner");
  const pending = await pendingInstallation(kv, accountId);
  for (const vault of vaults) await registry.revokeAllKeys(vault.id);
  // From a shared vault the person leaves, the way leaving does: their keys and the agent names they held
  // go, and so does the login linked to their human (a deleted account's login can be someone else's later).
  for (const vault of all.filter((v) => v.role !== "owner")) {
    const gone = await registry.removeMember(vault.id, account.user);
    if (!gone) continue;
    await hooks?.releaseCredentials?.(vault.id, gone.keys.map(keyCredential));
    // Best effort, as when leaving: the seat is gone either way.
    if (gone.human) await hooks?.linkHuman?.(vault, gone.human, null, `@${account.login}`).catch(() => undefined);
  }
  await hooks?.revokeOAuthGrants?.(accountId);
  for (const vault of vaults) await hooks?.destroyVault?.(vault.id);
  // GitLab vaults have no installation (0).
  const owned = new Set(vaults.map((v) => v.id));
  for (const id of new Set([...vaults.map((v) => v.installationId), pending?.installationId])) if (id && (await ownInstallation(id, accountId, owned, deps))) await app.deleteInstallation(id);
  await clearPendingInstallation(kv, accountId);
  // Before the rows go: revoking needs the stored tokens.
  await gitlab?.disconnect(accountId);
  await registry.removeAccount(accountId);
  return { vaults: vaults.map((v) => v.id) };
}

/**
 * Whether deleting the account may uninstall the app from this installation: it's on the person's own
 * personal account (GitHub says so, not the registry), and no vault of anyone else's uses it. An
 * organization's install serves other people, so it's never removed on one person's say.
 */
async function ownInstallation(id: number, accountId: number, owned: Set<string>, { registry, app }: DeleteAccountDeps): Promise<boolean> {
  if ((await registry.vaultsByInstallation(id)).some((v) => !owned.has(v.id))) return false;
  const installation = await app.installation(id);
  return installation?.account.type === "User" && installation.account.id === accountId;
}

/** The typed confirmation: the account's GitHub login, so a stray click can't delete anything. */
export function confirmDeletion(account: Account, body: unknown): void {
  const typed = (body as { confirm?: unknown } | undefined)?.confirm;
  const given = typeof typed === "string" ? typed.trim().replace(/^@/, "").toLowerCase() : "";
  if (given !== account.login.toLowerCase()) throw new HttpError(400, `To delete your account, type your GitHub login (${account.login}) as confirm.`, "CONFIRM");
}
