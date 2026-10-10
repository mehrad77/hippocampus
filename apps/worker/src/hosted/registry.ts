import { AGENT_ID, RESERVED_AGENT_IDS } from "@hippocampus/core";
import { HttpError } from "@hippocampus/dashboard";
import type { SqlDriver, SqlValue } from "@hippocampus/index";
import { hashToken, newToken } from "../auth.ts";
import { storedQuotas, type Quotas } from "./quotas.ts";

// The hosted app's registry over SQL (D1 in the Worker, node:sqlite in tests). The schema is
// apps/worker/migrations/0001_registry.sql. It holds accounts, which repo is whose vault, and
// hashed keys: never vault content.

export type AccountStatus = "waitlisted" | "approved" | "denied" | "deleted";

export interface Account {
  /** GitHub's numeric user id. */
  id: number;
  login: string;
  status: AccountStatus;
  /** What the person wrote when asking for access; set means they asked. */
  note?: string;
  /** Sessions carry the epoch they were made in; bumping it signs the account out everywhere. */
  epoch: number;
  created: string;
  updated: string;
}

export type VaultStatus = "bootstrapping" | "ready" | "disconnected";

/** Why a vault is disconnected. Only the matching event reconnects it (unsuspending doesn't fix a public repo). */
export type DisconnectReason = "uninstalled" | "suspended" | "repo_removed" | "repo_deleted" | "public" | "bootstrap_failed";

export interface VaultRecord {
  id: string;
  accountId: number;
  installationId: number;
  /** GitHub's repo id: survives renames and transfers. */
  repoId: number;
  fullName: string;
  branch: string;
  status: VaultStatus;
  reason?: DisconnectReason;
  /** An admin's overrides of the hosted limits for this vault; absent means the defaults. */
  quotas?: Partial<Quotas>;
  created: string;
  updated: string;
}

export const KEY_KINDS = ["agent", "curator", "bound"] as const;
export type KeyKind = (typeof KEY_KINDS)[number];

/** MCP's scopes, plus `curate` for the curator's own key. */
export const KEY_SCOPES = ["read", "remember", "quest", "curate"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** What each kind of key may do. Only `bound` keys choose (from `read`, `remember`, `quest`). */
export const KIND_SCOPES: Record<KeyKind, readonly KeyScope[]> = {
  agent: ["read", "remember", "quest"],
  curator: ["read", "curate"],
  bound: ["read", "remember", "quest"],
};

export interface KeyRecord {
  /** SHA-256 of the key, hex. The key itself is never stored. */
  id: string;
  vaultId: string;
  /** `agent`: any agent, which names itself; `curator`: the curator, named at sleep_start; `bound`: one agent. */
  kind: KeyKind;
  agent?: string;
  scopes: KeyScope[];
  label: string;
  created: string;
  lastUsed?: string;
}

/** A key with the vault it opens and its owner's standing, for authenticating a request. */
export interface KeyGrant extends KeyRecord {
  vault: VaultRecord;
  accountStatus: AccountStatus;
}

export interface KeyRequest {
  kind: KeyKind;
  label: string;
  agent?: string;
  scopes: KeyScope[];
}

export const MAX_KEYS_PER_VAULT = 50;
const TOUCH_EVERY_MS = 15 * 60_000;
const DELIVERY_TTL_MS = 7 * 24 * 3600_000;
/** A bootstrap this old was cut off (the Worker died mid-way), so another may take its place. */
const STALE_BOOTSTRAP_MS = 5 * 60_000;

/** A key in use: the vault is ready and its owner still approved. */
export const isLive = (grant: KeyGrant) => grant.vault.status === "ready" && grant.accountStatus === "approved";

export const isKeyScope = (s: unknown): s is KeyScope => (KEY_SCOPES as readonly unknown[]).includes(s);

/**
 * An agent id that's valid in any vault: the slug rule and not reserved. Whether it's the
 * vault's human is only known with the vault loaded, so that's checked when the key is used.
 */
export function agentId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!AGENT_ID.test(id)) throw new HttpError(400, "agent: use lowercase letters, digits and dashes, like home-finder", "INVALID");
  if ((RESERVED_AGENT_IDS as readonly string[]).includes(id)) throw new HttpError(400, `agent: "${id}" is reserved, not an agent id`, "INVALID");
  return id;
}

/** `{ kind, label?, agent?, scopes? }` for a new key, checked and filled in. */
export function keyRequest(body: unknown): KeyRequest {
  const b = (body ?? {}) as { kind?: unknown; label?: unknown; agent?: unknown; scopes?: unknown };
  const kind = b.kind as KeyKind;
  if (!KEY_KINDS.includes(kind)) throw new HttpError(400, `kind: expected one of ${KEY_KINDS.join(", ")}`, "INVALID");
  if (b.label !== undefined && typeof b.label !== "string") throw new HttpError(400, "label: expected text", "INVALID");
  const label = (b.label ?? "").trim();
  if (label.length > 80) throw new HttpError(400, "label: 80 characters at most", "INVALID");
  if (kind !== "bound") {
    if (b.agent !== undefined || b.scopes !== undefined) throw new HttpError(400, `${kind} keys have fixed scopes and no agent; use a bound key to choose`, "INVALID");
    return { kind, label: label || (kind === "curator" ? "Curator" : "Any agent"), scopes: [...KIND_SCOPES[kind]] };
  }
  const agent = agentId(b.agent);
  const allowed = KIND_SCOPES.bound;
  const asked = b.scopes === undefined ? allowed : b.scopes;
  if (!Array.isArray(asked)) throw new HttpError(400, `scopes: expected a list from ${allowed.join(", ")}`, "INVALID");
  const unknown = asked.filter((s) => !allowed.includes(s as KeyScope));
  if (unknown.length) throw new HttpError(400, `scopes: unknown ${unknown.map(String).join(", ")}; choose from ${allowed.join(", ")}`, "INVALID");
  if (!asked.includes("read")) throw new HttpError(400, "scopes: every key needs read", "INVALID");
  return { kind, label: label || agent, agent, scopes: allowed.filter((s) => asked.includes(s)) };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: sorts by creation time, unguessable, and safe as a Durable Object name. */
export function ulid(now: Date, random: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
  let t = now.getTime();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 256 is a multiple of 32, so `% 32` stays uniform.
  return time + [...random.subarray(0, 16)].map((b) => CROCKFORD[b % 32]).join("");
}

interface AccountRow {
  id: number;
  login: string;
  status: AccountStatus;
  note: string | null;
  session_epoch: number;
  created: string;
  updated: string;
}

interface VaultRow {
  id: string;
  account_id: number;
  installation_id: number;
  repo_id: number;
  full_name: string;
  branch: string;
  status: VaultStatus;
  reason: DisconnectReason | null;
  quotas: string | null;
  created: string;
  updated: string;
}

interface KeyRow {
  hash: string;
  vault_id: string;
  kind: KeyKind;
  agent: string | null;
  scopes: string;
  label: string;
  created: string;
  last_used: string | null;
}

/** A key joined with its vault (columns prefixed `v_`) and its owner's status. */
interface GrantRow extends KeyRow {
  v_id: string;
  v_account_id: number;
  v_installation_id: number;
  v_repo_id: number;
  v_full_name: string;
  v_branch: string;
  v_status: VaultStatus;
  v_reason: DisconnectReason | null;
  v_quotas: string | null;
  v_created: string;
  v_updated: string;
  account_status: AccountStatus;
}

const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  login: r.login,
  status: r.status,
  ...(r.note === null ? {} : { note: r.note }),
  epoch: r.session_epoch,
  created: r.created,
  updated: r.updated,
});

const toVault = (r: VaultRow): VaultRecord => {
  const quotas = storedQuotas(r.quotas);
  return {
    id: r.id,
    accountId: r.account_id,
    installationId: r.installation_id,
    repoId: r.repo_id,
    fullName: r.full_name,
    branch: r.branch,
    status: r.status,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(quotas ? { quotas } : {}),
    created: r.created,
    updated: r.updated,
  };
};

function toKey(r: KeyRow): KeyRecord {
  const scopes = (() => {
    try {
      return (JSON.parse(r.scopes) as unknown[]).filter(isKeyScope);
    } catch {
      return [];
    }
  })();
  return {
    id: r.hash,
    vaultId: r.vault_id,
    kind: r.kind,
    ...(r.agent ? { agent: r.agent } : {}),
    scopes,
    label: r.label,
    created: r.created,
    ...(r.last_used ? { lastUsed: r.last_used } : {}),
  };
}

const VAULT_COLUMNS = "id, account_id, installation_id, repo_id, full_name, branch, status, reason, quotas, created, updated";

export interface NewVault {
  accountId: number;
  installationId: number;
  repoId: number;
  fullName: string;
  branch: string;
}

export class Registry {
  constructor(
    readonly db: SqlDriver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private stamp(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  private async one<T>(sql: string, params: SqlValue[]): Promise<T | undefined> {
    return (await this.db.all<T>(sql, params))[0];
  }

  // ── Accounts ───────────────────────────────────────────────────────────────

  /**
   * Record a sign-in. New accounts wait for approval; admins are approved whenever they sign in
   * (the env is the authority); a deleted account starts over; a denied one stays denied.
   */
  async signIn(user: { id: number; login: string }, opts: { admin?: boolean } = {}): Promise<Account> {
    const at = this.stamp();
    const fresh: AccountStatus = opts.admin ? "approved" : "waitlisted";
    const row = await this.one<AccountRow>(
      `INSERT INTO accounts (id, login, status, created, updated) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         login = excluded.login,
         status = CASE WHEN ? = 1 OR accounts.status = 'deleted' THEN excluded.status ELSE accounts.status END,
         note = CASE WHEN accounts.status = 'deleted' THEN NULL ELSE accounts.note END,
         updated = excluded.updated
       RETURNING *`,
      [user.id, user.login, fresh, at, at, opts.admin ? 1 : 0],
    );
    return toAccount(row!);
  }

  async account(id: number): Promise<Account | undefined> {
    const row = await this.one<AccountRow>("SELECT * FROM accounts WHERE id = ?", [id]);
    return row && toAccount(row);
  }

  /** Ask to be let in, with a note for the admins. Only while waitlisted. */
  async requestAccess(id: number, note: string): Promise<Account> {
    const row = await this.one<AccountRow>("UPDATE accounts SET note = ?, updated = ? WHERE id = ? AND status = 'waitlisted' RETURNING *", [note, this.stamp(), id]);
    if (row) return toAccount(row);
    const account = await this.account(id);
    if (account?.status === "approved") throw new HttpError(409, "Your account is already approved.", "ALREADY_APPROVED");
    if (account?.status === "denied") throw new HttpError(403, "Access to this Hippocampus wasn't granted.", "DENIED");
    throw new HttpError(404, "No such account", "NOT_FOUND");
  }

  async accounts(status?: AccountStatus): Promise<Account[]> {
    const rows = status
      ? await this.db.all<AccountRow>("SELECT * FROM accounts WHERE status = ? ORDER BY created, id", [status])
      : await this.db.all<AccountRow>("SELECT * FROM accounts WHERE status != 'deleted' ORDER BY created, id");
    return rows.map(toAccount);
  }

  /** Approve or deny. Deleted accounts stay deleted. */
  async setAccountStatus(id: number, status: "approved" | "denied"): Promise<Account> {
    const row = await this.one<AccountRow>("UPDATE accounts SET status = ?, updated = ? WHERE id = ? AND status != 'deleted' RETURNING *", [status, this.stamp(), id]);
    if (!row) throw new HttpError(404, "No such account", "NOT_FOUND");
    return toAccount(row);
  }

  /** Sign the account out everywhere. */
  async bumpEpoch(id: number): Promise<void> {
    await this.db.all("UPDATE accounts SET session_epoch = session_epoch + 1, updated = ? WHERE id = ?", [this.stamp(), id]);
  }

  /**
   * Forget the account's vault and keys, and leave a tombstone: status `deleted`, note cleared,
   * epoch bumped. The tombstone keeps the epoch growing, so an old session can't revive on re-signup.
   */
  async removeAccount(id: number): Promise<void> {
    await this.db.batch([
      { sql: "DELETE FROM keys WHERE vault_id IN (SELECT id FROM vaults WHERE account_id = ?)", params: [id] },
      { sql: "DELETE FROM vaults WHERE account_id = ?", params: [id] },
      { sql: "UPDATE accounts SET status = 'deleted', note = NULL, session_epoch = session_epoch + 1, updated = ? WHERE id = ?", params: [this.stamp(), id] },
    ]);
  }

  // ── Vaults ─────────────────────────────────────────────────────────────────

  async vault(id: string): Promise<VaultRecord | undefined> {
    const row = await this.one<VaultRow>(`SELECT ${VAULT_COLUMNS} FROM vaults WHERE id = ?`, [id]);
    return row && toVault(row);
  }

  /** The account's vault (one per account for now). */
  async vaultOf(accountId: number): Promise<VaultRecord | undefined> {
    const row = await this.one<VaultRow>(`SELECT ${VAULT_COLUMNS} FROM vaults WHERE account_id = ? ORDER BY created LIMIT 1`, [accountId]);
    return row && toVault(row);
  }

  async vaultByRepo(repoId: number): Promise<VaultRecord | undefined> {
    const row = await this.one<VaultRow>(`SELECT ${VAULT_COLUMNS} FROM vaults WHERE repo_id = ?`, [repoId]);
    return row && toVault(row);
  }

  async vaultsByInstallation(installationId: number): Promise<VaultRecord[]> {
    return (await this.db.all<VaultRow>(`SELECT ${VAULT_COLUMNS} FROM vaults WHERE installation_id = ? ORDER BY created`, [installationId])).map(toVault);
  }

  /** Every vault with its owner's login, for admins. */
  async vaults(): Promise<(VaultRecord & { login: string })[]> {
    const rows = await this.db.all<VaultRow & { login: string }>(
      `SELECT v.id, v.account_id, v.installation_id, v.repo_id, v.full_name, v.branch, v.status, v.reason, v.quotas, v.created, v.updated, a.login
       FROM vaults v JOIN accounts a ON a.id = v.account_id ORDER BY v.created`,
    );
    return rows.map((r) => ({ ...toVault(r), login: r.login }));
  }

  /**
   * Take a repo as the account's vault, in `bootstrapping`. One vault per account: a ready one
   * blocks this; a disconnected (or abandoned) one on the same repo is taken back with its keys;
   * one on another repo is replaced, keys and all (`replaced` names it).
   */
  async claimVault(v: NewVault): Promise<{ vault: VaultRecord; replaced?: string }> {
    const at = this.stamp();
    const taken = await this.vaultByRepo(v.repoId);
    if (taken && taken.accountId !== v.accountId) throw new HttpError(409, `${v.fullName} is already another account's vault.`, "REPO_TAKEN");
    const existing = await this.vaultOf(v.accountId);
    if (existing) {
      const stale = existing.status === "bootstrapping" && existing.updated < this.stamp(-STALE_BOOTSTRAP_MS);
      if (existing.status === "ready") throw new HttpError(409, `You already have a vault: ${existing.fullName}.`, "HAS_VAULT");
      if (existing.status === "bootstrapping" && !stale) throw new HttpError(409, `${existing.fullName} is being set up right now.`, "BUSY");
      if (existing.repoId === v.repoId) {
        // Compare-and-set on `updated`, so two tabs can't both take it back.
        const row = await this.one<VaultRow>(
          `UPDATE vaults SET installation_id = ?, full_name = ?, branch = ?, status = 'bootstrapping', reason = NULL, updated = ?
           WHERE id = ? AND updated = ? RETURNING ${VAULT_COLUMNS}`,
          [v.installationId, v.fullName, v.branch, at, existing.id, existing.updated],
        );
        if (!row) throw new HttpError(409, `${existing.fullName} is being set up right now.`, "BUSY");
        return { vault: toVault(row) };
      }
      // Both deletes check `updated`, so a racing request that changed the vault keeps it, keys and all.
      await this.db.batch([
        { sql: "DELETE FROM keys WHERE vault_id = ? AND EXISTS (SELECT 1 FROM vaults WHERE id = ? AND updated = ?)", params: [existing.id, existing.id, existing.updated] },
        { sql: "DELETE FROM vaults WHERE id = ? AND updated = ?", params: [existing.id, existing.updated] },
      ]);
      return { vault: await this.insertVault(v, at), replaced: existing.id };
    }
    return { vault: await this.insertVault(v, at) };
  }

  private async insertVault(v: NewVault, at: string): Promise<VaultRecord> {
    let row: VaultRow | undefined;
    try {
      // NOT EXISTS makes "one vault per account" hold even for two requests racing each other.
      row = await this.one<VaultRow>(
        `INSERT INTO vaults (id, account_id, installation_id, repo_id, full_name, branch, status, created, updated)
         SELECT ?, ?, ?, ?, ?, ?, 'bootstrapping', ?, ? WHERE NOT EXISTS (SELECT 1 FROM vaults WHERE account_id = ?)
         RETURNING ${VAULT_COLUMNS}`,
        [ulid(this.now()), v.accountId, v.installationId, v.repoId, v.fullName, v.branch, at, at, v.accountId],
      );
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(String(err))) throw new HttpError(409, `${v.fullName} is already a vault.`, "REPO_TAKEN");
      throw err;
    }
    if (!row) throw new HttpError(409, "You already have a vault.", "HAS_VAULT");
    return toVault(row);
  }

  async setVaultStatus(id: string, status: VaultStatus, reason?: DisconnectReason): Promise<VaultRecord | undefined> {
    const row = await this.one<VaultRow>(`UPDATE vaults SET status = ?, reason = ?, updated = ? WHERE id = ? RETURNING ${VAULT_COLUMNS}`, [
      status,
      status === "disconnected" ? (reason ?? null) : null,
      this.stamp(),
      id,
    ]);
    return row && toVault(row);
  }

  /** Set an admin's overrides of a vault's limits; `null` or none clears them. Callers check the values first (`quotaOverrides`). */
  async setVaultQuotas(id: string, quotas: Partial<Quotas> | null): Promise<VaultRecord | undefined> {
    const json = quotas && Object.keys(quotas).length ? JSON.stringify(quotas) : null;
    const row = await this.one<VaultRow>(`UPDATE vaults SET quotas = ? WHERE id = ? RETURNING ${VAULT_COLUMNS}`, [json, id]);
    return row && toVault(row);
  }

  async renameVault(id: string, fullName: string): Promise<VaultRecord | undefined> {
    const row = await this.one<VaultRow>(`UPDATE vaults SET full_name = ?, updated = ? WHERE id = ? RETURNING ${VAULT_COLUMNS}`, [fullName, this.stamp(), id]);
    return row && toVault(row);
  }

  // ── Keys ───────────────────────────────────────────────────────────────────

  /** A new key for the vault. Returns the key itself (show it once) and its record. */
  async mintKey(vaultId: string, req: KeyRequest): Promise<{ token: string; key: KeyRecord }> {
    const token = newToken();
    const hash = await hashToken(token);
    const row = await this.one<KeyRow>(
      `INSERT INTO keys (hash, vault_id, kind, agent, scopes, label, created)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM keys WHERE vault_id = ?) < ?
       RETURNING *`,
      [hash, vaultId, req.kind, req.agent ?? null, JSON.stringify(req.scopes), req.label, this.stamp(), vaultId, MAX_KEYS_PER_VAULT],
    );
    if (!row) throw new HttpError(409, `A vault can have ${MAX_KEYS_PER_VAULT} keys; revoke some first.`, "TOO_MANY_KEYS");
    return { token, key: toKey(row) };
  }

  /** The grant for one of our keys (`hippo_…`); undefined for anything else. */
  async keyForToken(token: string): Promise<KeyGrant | undefined> {
    return token.startsWith("hippo_") ? this.keyByHash(await hashToken(token)) : undefined;
  }

  async keyByHash(hash: string): Promise<KeyGrant | undefined> {
    const row = await this.one<GrantRow>(
      `SELECT k.*, v.id AS v_id, v.account_id AS v_account_id, v.installation_id AS v_installation_id, v.repo_id AS v_repo_id,
         v.full_name AS v_full_name, v.branch AS v_branch, v.status AS v_status, v.reason AS v_reason,
         v.quotas AS v_quotas, v.created AS v_created, v.updated AS v_updated, a.status AS account_status
       FROM keys k JOIN vaults v ON v.id = k.vault_id JOIN accounts a ON a.id = v.account_id
       WHERE k.hash = ?`,
      [hash],
    );
    if (!row) return undefined;
    const vault = toVault({
      id: row.v_id,
      account_id: row.v_account_id,
      installation_id: row.v_installation_id,
      repo_id: row.v_repo_id,
      full_name: row.v_full_name,
      branch: row.v_branch,
      status: row.v_status,
      reason: row.v_reason,
      quotas: row.v_quotas,
      created: row.v_created,
      updated: row.v_updated,
    });
    return { ...toKey(row), vault, accountStatus: row.account_status };
  }

  /** The vault's keys, newest first. Hashes and grants only. */
  async keys(vaultId: string): Promise<KeyRecord[]> {
    return (await this.db.all<KeyRow>("SELECT * FROM keys WHERE vault_id = ? ORDER BY created DESC, hash", [vaultId])).map(toKey);
  }

  /** Revoke one of this vault's keys. Another vault's key is "not found", so ids can't be probed. */
  async revokeKey(vaultId: string, hash: string): Promise<void> {
    const gone = await this.one("DELETE FROM keys WHERE hash = ? AND vault_id = ? RETURNING hash", [hash, vaultId]);
    if (!gone) throw new HttpError(404, "No such key: it may be revoked already.", "NOT_FOUND");
  }

  async revokeAllKeys(vaultId: string): Promise<void> {
    await this.db.all("DELETE FROM keys WHERE vault_id = ?", [vaultId]);
  }

  /** Note that a key was used, at most every quarter hour: a write per request would be wasteful. */
  async touchKey(key: Pick<KeyRecord, "id" | "lastUsed">): Promise<void> {
    const cutoff = this.stamp(-TOUCH_EVERY_MS);
    if (key.lastUsed && key.lastUsed >= cutoff) return;
    await this.db.all("UPDATE keys SET last_used = ? WHERE hash = ? AND (last_used IS NULL OR last_used < ?)", [this.stamp(), key.id, cutoff]);
  }

  // ── Webhook deliveries ─────────────────────────────────────────────────────

  /** Claim a webhook delivery: true the first time, false for a redelivery. Also forgets week-old ones. */
  async claimDelivery(id: string): Promise<boolean> {
    await this.db.all("DELETE FROM webhook_deliveries WHERE at < ?", [this.stamp(-DELIVERY_TTL_MS)]);
    return !!(await this.one("INSERT INTO webhook_deliveries (id, at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING RETURNING id", [id, this.stamp()]));
  }

  /** Give a claim back (handling failed), so GitHub's redelivery is handled. */
  async releaseDelivery(id: string): Promise<void> {
    await this.db.all("DELETE FROM webhook_deliveries WHERE id = ?", [id]);
  }
}
