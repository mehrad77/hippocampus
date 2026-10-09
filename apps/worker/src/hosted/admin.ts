import { HttpError } from "@hippocampus/dashboard";
import type { Account, AccountStatus, Registry } from "./registry.ts";

// Routes under /dashboard/api/admin/ for the admins in HIPPO_ADMINS: approve the waitlist and see
// which vaults exist. Admins see names and states, never what's in anyone's vault.

const STATUSES: AccountStatus[] = ["waitlisted", "approved", "denied", "deleted"];

export interface AdminDeps {
  registry: Registry;
  admins: Set<number>;
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
      return { vaults: vaults.map((v) => ({ id: v.id, fullName: v.fullName, status: v.status, reason: v.reason, login: v.login, created: v.created })) };
    }
    throw new HttpError(404, `No such admin route: ${method} ${path}`, "NOT_FOUND");
  };
}
