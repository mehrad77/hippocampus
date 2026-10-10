import { HttpError } from "@hippocampus/dashboard";
import type { Account, AccountStatus, Registry } from "./registry.ts";
import { quotaOverrides } from "./quotas.ts";

// Routes under /dashboard/api/admin/ for the admins in HIPPO_ADMINS: approve the waitlist, see which
// vaults exist, and raise one vault's limits. Admins see names, states and limits, never what's in
// anyone's vault.

const STATUSES: AccountStatus[] = ["waitlisted", "approved", "denied", "deleted"];

export interface AdminDeps {
  registry: Registry;
  admins: Set<number>;
  /** A vault's limits changed: tell its Durable Object, which reads them when it's configured. */
  onVaultChanged?: (vaultId: string) => void | Promise<void>;
}

export function adminRoutes(deps: AdminDeps) {
  const { registry } = deps;
  const accountView = (a: Account) => ({ id: a.id, login: a.login, status: a.status, note: a.note, created: a.created, updated: a.updated, admin: deps.admins.has(a.id) });

  /** `path` is relative to `/admin/`. */
  return async (method: "GET" | "POST", path: string, body: unknown, url: URL, caller: Account): Promise<unknown> => {
    // Re-checked on every request against the env, so removing an admin takes effect at once.
    if (!deps.admins.has(caller.id)) throw new HttpError(403, "Only admins can do that.", "ADMIN");
    if (path === "accounts" && method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      if (status !== undefined && !STATUSES.includes(status as AccountStatus)) throw new HttpError(400, `status: one of ${STATUSES.join(", ")}`, "INVALID");
      return { accounts: (await registry.accounts(status as AccountStatus | undefined)).map(accountView) };
    }
    const decision = /^accounts\/(approve|deny)$/.exec(path)?.[1];
    if (decision && method === "POST") {
      const id = (body as { id?: unknown } | undefined)?.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new HttpError(400, "id: the account's GitHub user id", "INVALID");
      if (decision === "deny" && deps.admins.has(id)) throw new HttpError(400, "Admins can't be denied; remove them from HIPPO_ADMINS first.", "INVALID");
      return { account: accountView(await registry.setAccountStatus(id, decision === "approve" ? "approved" : "denied")) };
    }
    if (path === "vaults" && method === "GET") {
      const vaults = await registry.vaults();
      return { vaults: vaults.map((v) => ({ id: v.id, fullName: v.fullName, status: v.status, reason: v.reason, login: v.login, created: v.created, quotas: v.quotas ?? null })) };
    }
    if (path === "vaults/quotas" && method === "POST") {
      const b = (body ?? {}) as { id?: unknown; quotas?: unknown };
      if (typeof b.id !== "string" || !b.id) throw new HttpError(400, "id: the vault's id", "INVALID");
      if (b.quotas === undefined) throw new HttpError(400, "quotas: an object of limits, or null to clear them", "INVALID");
      const quotas = quotaOverrides(b.quotas);
      const vault = await registry.setVaultQuotas(b.id, Object.keys(quotas).length ? quotas : null);
      if (!vault) throw new HttpError(404, "No such vault", "NOT_FOUND");
      await deps.onVaultChanged?.(vault.id);
      return { vault: { id: vault.id, fullName: vault.fullName, quotas: vault.quotas ?? null } };
    }
    throw new HttpError(404, `No such admin route: ${method} ${path}`, "NOT_FOUND");
  };
}
