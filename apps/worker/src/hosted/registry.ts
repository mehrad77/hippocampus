import { AGENT_ID, RESERVED_AGENT_IDS } from "@hippocampus/core";
import { HttpError } from "@hippocampus/dashboard";
import type { SqlDriver, SqlValue } from "@hippocampus/index";
import { LEGACY_GOAL_SCOPE, isScope, normalizeScopes } from "@hippocampus/mcp";
import { hashToken, newToken } from "../auth.ts";
import { storedQuotas, type Quotas } from "./quotas.ts";

// The hosted app's registry over SQL (D1 in the Worker, node:sqlite in tests). The schema is
// apps/worker/migrations/*.sql. It holds users and how they sign in, which repo is whose vault, and
// hashed keys: never vault content.

export type AccountStatus = "waitlisted" | "approved" | "denied" | "deleted";

export interface Account {
  /** GitHub's numeric user id: the `accounts` row, which GitLab connections and OAuth grants still use. */
  id: number;
  /** Our own id for the person (`users.id`), which vaults and anything new refer to. */
  user: string;
  login: string;
  status: AccountStatus;
  /** What the person wrote when asking for access; set means they asked. */
  note?: string;
  /** Sessions carry the epoch they were made in; bumping it signs the account out everywhere. */
  epoch: number;
  /** The vault the dashboard last showed, opened again when a request doesn't say which. */
  lastVault?: string;
  /** The user whose invite brought them in (the first one they accepted). */
  invitedBy?: string;
  /** Whether they may invite people to the app (an admin can stop it). */
  canInvite: boolean;
  created: string;
  updated: string;
}

export type VaultStatus = "bootstrapping" | "ready" | "disconnected";

/** Why a vault is disconnected. Only the matching event reconnects it (unsuspending doesn't fix a public repo). */
export type DisconnectReason = "uninstalled" | "suspended" | "repo_removed" | "repo_deleted" | "public" | "bootstrap_failed" | "token_revoked";

/** Where a vault's repo lives. */
export type Provider = "github" | "gitlab";

export interface VaultRecord {
  id: string;
  /** The owner's GitHub account (`accounts.id`); GitLab vaults use its GitLab connection. */
  accountId: number;
  /** The owning user (`users.id`); absent on a vault a rolled-back Worker made. */
  owner?: string;
  provider: Provider;
  /** The GitHub App installation; 0 for GitLab vaults, which have none. */
  installationId: number;
  /** The provider's repo (project) id: survives renames and transfers. */
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

/** What a person may do with a vault: everything (owner), act as their human (member), or only read (viewer). */
export const ROLES = ["owner", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** A vault as one person reaches it: with their role, and the human they are in it. */
export interface MemberVault extends VaultRecord {
  role: Role;
  /** Their human's id in the vault's config; unset for an owner, who is matched by login. */
  human?: string;
}

export interface Member {
  user: string;
  /** Their GitHub login, for showing. */
  login: string;
  role: Role;
  human?: string;
  since: string;
}

export interface Invite {
  /** SHA-256 of its token. */
  id: string;
  /** Unset: an invite to the app alone. */
  vaultId?: string;
  role?: Exclude<Role, "owner">;
  human?: string;
  /** Domains for a human the invite adds. */
  domains?: string[];
  /** Only this account may accept it. */
  login?: { provider: Provider; login: string };
  createdBy: string;
  created: string;
  expires: string;
  acceptedBy?: string;
  accepted?: string;
  revoked?: string;
}

export type NewInvite = Pick<Invite, "vaultId" | "role" | "human" | "domains" | "login" | "createdBy">;

/** An edge of the referral graph: `from` invited `to`, who accepted at `at`. */
export interface Referral {
  from: string;
  to: string;
  at: string;
  vault?: string;
}

export const KEY_KINDS = ["agent", "curator", "bound"] as const;
export type KeyKind = (typeof KEY_KINDS)[number];

/**
 * MCP's scopes, plus `curate` for the curator's own key. `quest` is `goal`'s old name: keys that may
 * update goals store both, so a rolled-back Worker (which knows only `quest`) keeps honoring them,
 * and stored scopes are read back under their current names.
 */
export const KEY_SCOPES = ["read", "remember", "goal", "quest", "curate"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** What each kind of key may do. Only `bound` keys choose (from `read`, `remember`, `goal`). */
export const KIND_SCOPES: Record<KeyKind, readonly KeyScope[]> = {
  agent: ["read", "remember", "goal"],
  curator: ["read", "curate"],
  bound: ["read", "remember", "goal"],
};

/** Scopes as stored: `goal` with its old name `quest` beside it. */
const stored = (scopes: readonly KeyScope[]): KeyScope[] => scopes.flatMap((s): KeyScope[] => (s === "goal" ? ["goal", LEGACY_GOAL_SCOPE] : s === LEGACY_GOAL_SCOPE ? [] : [s]));

/** Stored scopes under their current names (`quest` → `goal`), once each. */
export const currentScopes = (scopes: readonly unknown[]): KeyScope[] => normalizeScopes(scopes.filter(isScope));

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
  /** The user who minted it; unset for keys from before sharing. */
  createdBy?: string;
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
export const MAX_MEMBERS_PER_VAULT = 20;
export const MAX_PENDING_VAULT_INVITES = 20;
export const MAX_PENDING_APP_INVITES = 10;
const INVITE_TTL_MS = 7 * 24 * 3600_000;
export const MAX_VAULTS_PER_USER = 5;
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
  const raw = b.scopes === undefined ? allowed : b.scopes;
  if (!Array.isArray(raw)) throw new HttpError(400, `scopes: expected a list from ${allowed.join(", ")}`, "INVALID");
  // `quest` is still accepted, as `goal`.
  const asked = (raw as unknown[]).map((s) => (s === LEGACY_GOAL_SCOPE ? "goal" : s));
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

/** An `accounts` row joined with its user (see ACCOUNT_SELECT). */
interface AccountRow {
  id: number;
  user: string;
  login: string;
  status: AccountStatus;
  note: string | null;
  session_epoch: number;
  last_vault: string | null;
  invited_by: string | null;
  can_invite: number;
  created: string;
  updated: string;
}

/** A person as the rest of the app sees them: the GitHub account row with its user's state. */
const ACCOUNT_SELECT = `SELECT a.id, u.id AS user, a.login, u.status, u.note, u.session_epoch, u.last_vault, u.invited_by, u.can_invite, u.created, u.updated
  FROM accounts a JOIN users u ON u.legacy_account = a.id`;

/**
 * Copy an account's state into its user. Every change writes `accounts` first, which the previous
 * Worker reads, and this in the same batch, so the two never disagree; reads come from `users`.
 */
const SYNC_USER = `UPDATE users SET name = a.login, status = a.status, note = a.note, session_epoch = a.session_epoch, updated = a.updated
  FROM accounts a WHERE users.legacy_account = a.id AND a.id = ?`;

/** The account's user, made the first time it's needed (a rolled-back Worker signs people up without one). */
const ENSURE_USER = `INSERT INTO users (id, name, status, note, session_epoch, legacy_account, created, updated)
  SELECT ?, login, status, note, session_epoch, id, created, updated FROM accounts WHERE id = ?
  ON CONFLICT (legacy_account) DO NOTHING`;

const ENSURE_GITHUB_IDENTITY = `INSERT INTO identities (provider, subject, login, user_id, created, updated)
  SELECT 'github', CAST(a.id AS TEXT), a.login, u.id, a.updated, a.updated FROM accounts a JOIN users u ON u.legacy_account = a.id WHERE a.id = ?
  ON CONFLICT (provider, subject) DO UPDATE SET login = excluded.login, updated = excluded.updated`;

/** A fresh user id: ours, so nothing outside reads meaning into it. */
export const newUserId = () => `u_${[...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

interface VaultRow {
  id: string;
  account_id: number;
  owner: string | null;
  provider: Provider;
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
  created_by: string | null;
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
  v_owner: string | null;
  v_provider: Provider;
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

/** See migrations/0003_gitlab.sql: GitLab project ids are stored negated. The map is its own inverse. */
const storedRepoId = (provider: Provider, id: number) => (provider === "gitlab" ? -id : id);

const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  user: r.user,
  login: r.login,
  status: r.status,
  ...(r.note === null ? {} : { note: r.note }),
  epoch: r.session_epoch,
  ...(r.last_vault ? { lastVault: r.last_vault } : {}),
  ...(r.invited_by ? { invitedBy: r.invited_by } : {}),
  canInvite: r.can_invite !== 0,
  created: r.created,
  updated: r.updated,
});

const toVault = (r: VaultRow): VaultRecord => {
  const quotas = storedQuotas(r.quotas);
  return {
    id: r.id,
    accountId: r.account_id,
    ...(r.owner ? { owner: r.owner } : {}),
    provider: r.provider,
    installationId: r.installation_id,
    repoId: storedRepoId(r.provider, r.repo_id),
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
      return currentScopes(JSON.parse(r.scopes) as unknown[]);
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
    ...(r.created_by ? { createdBy: r.created_by } : {}),
  };
}

interface InviteRow {
  id: string;
  vault_id: string | null;
  role: Exclude<Role, "owner"> | null;
  human: string | null;
  domains: string | null;
  provider: Provider | null;
  login: string | null;
  created_by: string;
  created: string;
  expires: string;
  accepted_by: string | null;
  accepted: string | null;
  revoked: string | null;
}

const toInvite = (r: InviteRow): Invite => ({
  id: r.id,
  ...(r.vault_id ? { vaultId: r.vault_id } : {}),
  ...(r.role ? { role: r.role } : {}),
  ...(r.human ? { human: r.human } : {}),
  ...(r.domains ? { domains: JSON.parse(r.domains) as string[] } : {}),
  ...(r.provider && r.login ? { login: { provider: r.provider, login: r.login } } : {}),
  createdBy: r.created_by,
  created: r.created,
  expires: r.expires,
  ...(r.accepted_by ? { acceptedBy: r.accepted_by } : {}),
  ...(r.accepted ? { accepted: r.accepted } : {}),
  ...(r.revoked ? { revoked: r.revoked } : {}),
});

const VAULT_COLUMNS = "id, account_id, owner, provider, installation_id, repo_id, full_name, branch, status, reason, quotas, created, updated";

export interface GitLabCredentialRow {
  accountId: number;
  gitlabUserId: number;
  gitlabLogin: string;
  /** Sealed tokens (token-box.ts). */
  secret: string;
  version: number;
  updated: string;
}

interface GitLabCredentialDbRow {
  account_id: number;
  gitlab_user_id: number;
  gitlab_login: string;
  secret: string;
  version: number;
  updated: string;
}

export interface NewVault {
  accountId: number;
  /** The owning user; default the account's. */
  owner?: string;
  /** Default `github`. */
  provider?: Provider;
  /** 0 for GitLab. */
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
   * Also makes sure the person has a user and a GitHub identity.
   */
  async signIn(user: { id: number; login: string }, opts: { admin?: boolean } = {}): Promise<Account> {
    const at = this.stamp();
    const fresh: AccountStatus = opts.admin ? "approved" : "waitlisted";
    await this.db.batch([
      {
        sql: `INSERT INTO accounts (id, login, status, created, updated) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         login = excluded.login,
         status = CASE WHEN ? = 1 OR accounts.status = 'deleted' THEN excluded.status ELSE accounts.status END,
         note = CASE WHEN accounts.status = 'deleted' THEN NULL ELSE accounts.note END,
         updated = excluded.updated`,
        params: [user.id, user.login, fresh, at, at, opts.admin ? 1 : 0],
      },
      { sql: ENSURE_USER, params: [newUserId(), user.id] },
      { sql: SYNC_USER, params: [user.id] },
      { sql: ENSURE_GITHUB_IDENTITY, params: [user.id] },
    ]);
    return (await this.account(user.id))!;
  }

  async account(id: number): Promise<Account | undefined> {
    const row = await this.one<AccountRow>(`${ACCOUNT_SELECT} WHERE a.id = ?`, [id]);
    if (row) return toAccount(row);
    // An account the previous Worker made has no user yet.
    if (!(await this.one("SELECT id FROM accounts WHERE id = ?", [id]))) return undefined;
    await this.db.batch([
      { sql: ENSURE_USER, params: [newUserId(), id] },
      { sql: ENSURE_GITHUB_IDENTITY, params: [id] },
    ]);
    const made = await this.one<AccountRow>(`${ACCOUNT_SELECT} WHERE a.id = ?`, [id]);
    return made && toAccount(made);
  }

  async accountByUser(userId: string): Promise<Account | undefined> {
    const row = await this.one<AccountRow>(`${ACCOUNT_SELECT} WHERE u.id = ?`, [userId]);
    return row && toAccount(row);
  }

  /** How the user is known to each provider. */
  async identities(userId: string): Promise<{ provider: Provider; login: string }[]> {
    return this.db.all<{ provider: Provider; login: string }>("SELECT provider, login FROM identities WHERE user_id = ? ORDER BY provider", [userId]);
  }

  /** Change the account and copy it into its user, in one batch (atomic). */
  private async changeAccount(id: number, sql: string, params: SqlValue[]): Promise<Account | undefined> {
    await this.db.batch([
      { sql, params },
      { sql: SYNC_USER, params: [id] },
    ]);
    return this.account(id);
  }

  /** Ask to be let in, with a note for the admins. Only while waitlisted. */
  async requestAccess(id: number, note: string): Promise<Account> {
    const account = await this.changeAccount(id, "UPDATE accounts SET note = ?, updated = ? WHERE id = ? AND status = 'waitlisted'", [note, this.stamp(), id]);
    if (account?.status === "waitlisted") return account;
    if (account?.status === "approved") throw new HttpError(409, "Your account is already approved.", "ALREADY_APPROVED");
    if (account?.status === "denied") throw new HttpError(403, "Access to this Hippocampus wasn't granted.", "DENIED");
    throw new HttpError(404, "No such account", "NOT_FOUND");
  }

  async accounts(status?: AccountStatus): Promise<Account[]> {
    const rows = status
      ? await this.db.all<AccountRow>(`${ACCOUNT_SELECT} WHERE u.status = ? ORDER BY a.created, a.id`, [status])
      : await this.db.all<AccountRow>(`${ACCOUNT_SELECT} WHERE u.status != 'deleted' ORDER BY a.created, a.id`);
    return rows.map(toAccount);
  }

  /** Approve or deny. Deleted accounts stay deleted. */
  async setAccountStatus(id: number, status: "approved" | "denied"): Promise<Account> {
    const before = await this.account(id);
    if (!before || before.status === "deleted") throw new HttpError(404, "No such account", "NOT_FOUND");
    return (await this.changeAccount(id, "UPDATE accounts SET status = ?, updated = ? WHERE id = ? AND status != 'deleted'", [status, this.stamp(), id]))!;
  }

  /** Sign the account out everywhere. */
  async bumpEpoch(id: number): Promise<void> {
    await this.changeAccount(id, "UPDATE accounts SET session_epoch = session_epoch + 1, updated = ? WHERE id = ?", [this.stamp(), id]);
  }

  /** Remember which vault the user's dashboard showed last. */
  async setLastVault(userId: string, vaultId: string): Promise<void> {
    await this.db.all("UPDATE users SET last_vault = ? WHERE id = ? AND (last_vault IS NULL OR last_vault != ?)", [vaultId, userId, vaultId]);
  }

  /**
   * Forget the account's vaults and keys, and leave a tombstone: status `deleted`, note cleared,
   * epoch bumped. The tombstone keeps the epoch growing, so an old session can't revive on re-signup.
   * Callers destroy each vault's Durable Object first (`vaultsOf`).
   */
  async removeAccount(id: number): Promise<void> {
    await this.db.batch([
      { sql: "DELETE FROM keys WHERE vault_id IN (SELECT id FROM vaults WHERE account_id = ?)", params: [id] },
      // Their keys and seats in vaults shared with them go too; the owners keep their vaults.
      { sql: "DELETE FROM keys WHERE created_by = (SELECT id FROM users WHERE legacy_account = ?)", params: [id] },
      { sql: "DELETE FROM vault_members WHERE vault_id IN (SELECT id FROM vaults WHERE account_id = ?)", params: [id] },
      { sql: "DELETE FROM vault_members WHERE user_id = (SELECT id FROM users WHERE legacy_account = ?)", params: [id] },
      { sql: "UPDATE invites SET revoked = ? WHERE accepted IS NULL AND revoked IS NULL AND (created_by = (SELECT id FROM users WHERE legacy_account = ?) OR vault_id IN (SELECT id FROM vaults WHERE account_id = ?))", params: [this.stamp(), id, id] },
      { sql: "DELETE FROM vaults WHERE account_id = ?", params: [id] },
      { sql: "DELETE FROM gitlab_credentials WHERE account_id = ?", params: [id] },
      { sql: "DELETE FROM identities WHERE provider = 'gitlab' AND user_id = (SELECT id FROM users WHERE legacy_account = ?)", params: [id] },
      { sql: "UPDATE users SET last_vault = NULL WHERE legacy_account = ?", params: [id] },
      { sql: "UPDATE accounts SET status = 'deleted', note = NULL, session_epoch = session_epoch + 1, updated = ? WHERE id = ?", params: [this.stamp(), id] },
      { sql: SYNC_USER, params: [id] },
    ]);
  }

  // ── Vaults ─────────────────────────────────────────────────────────────────

  async vault(id: string): Promise<VaultRecord | undefined> {
    const row = await this.one<VaultRow>(`SELECT ${VAULT_COLUMNS} FROM vaults WHERE id = ?`, [id]);
    return row && toVault(row);
  }

  /**
   * The vaults the person owns or was let into, oldest first, with their role. Ownership is `vaults.owner`
   * (or, for a vault a rolled-back Worker made, its account); everything else is a membership.
   */
  async vaultsOf(account: Pick<Account, "id" | "user">): Promise<MemberVault[]> {
    const rows = await this.db.all<VaultRow & { m_role: Role | null; m_human: string | null }>(
      `SELECT ${VAULT_COLUMNS.split(", ").map((c) => `v.${c}`).join(", ")}, m.role AS m_role, m.human AS m_human
       FROM vaults v LEFT JOIN vault_members m ON m.vault_id = v.id AND m.user_id = ?
       WHERE v.owner = ? OR (v.owner IS NULL AND v.account_id = ?) OR m.user_id IS NOT NULL
       ORDER BY v.created, v.rowid`,
      [account.user, account.user, account.id],
    );
    return rows.map((r) => {
      const owns = r.owner === account.user || (r.owner === null && r.account_id === account.id);
      const role: Role = owns ? "owner" : (r.m_role ?? "viewer");
      return { ...toVault(r), role, ...(!owns && r.m_human ? { human: r.m_human } : {}) };
    });
  }

  /** The vaults the person owns (what counts against MAX_VAULTS_PER_USER). */
  async ownedVaults(account: Pick<Account, "id" | "user">): Promise<MemberVault[]> {
    return (await this.vaultsOf(account)).filter((v) => v.role === "owner");
  }

  /** The role the account has in a vault, or undefined. For checking an OAuth grant's holder. */
  async roleIn(accountId: number, vaultId: string): Promise<Role | undefined> {
    const account = await this.account(accountId);
    return account && (await this.vaultsOf(account)).find((v) => v.id === vaultId)?.role;
  }

  async vaultByRepo(repoId: number, provider: Provider = "github"): Promise<VaultRecord | undefined> {
    const row = await this.one<VaultRow>(`SELECT ${VAULT_COLUMNS} FROM vaults WHERE repo_id = ?`, [storedRepoId(provider, repoId)]);
    return row && toVault(row);
  }

  async vaultsByInstallation(installationId: number): Promise<VaultRecord[]> {
    return (await this.db.all<VaultRow>(`SELECT ${VAULT_COLUMNS} FROM vaults WHERE installation_id = ? AND provider = 'github' ORDER BY created`, [installationId])).map(toVault);
  }

  /** Every vault with its owner's login, for admins. */
  async vaults(): Promise<(VaultRecord & { login: string })[]> {
    const rows = await this.db.all<VaultRow & { login: string }>(
      `SELECT v.id, v.account_id, v.owner, v.provider, v.installation_id, v.repo_id, v.full_name, v.branch, v.status, v.reason, v.quotas, v.created, v.updated, a.login
       FROM vaults v JOIN accounts a ON a.id = v.account_id ORDER BY v.created`,
    );
    return rows.map((r) => ({ ...toVault(r), login: r.login }));
  }

  /**
   * Take a repo as one of the person's vaults, in `bootstrapping`. Someone else's repo is refused; one of
   * their own that's disconnected (or whose setup was abandoned) is taken back with its keys; a new one
   * counts against MAX_VAULTS_PER_USER.
   */
  async claimVault(input: NewVault): Promise<{ vault: VaultRecord }> {
    const owner = input.owner ?? (await this.account(input.accountId))?.user;
    if (!owner) throw new HttpError(404, "No such account", "NOT_FOUND");
    const v = { ...input, owner };
    const at = this.stamp();
    const provider = v.provider ?? "github";
    const taken = await this.vaultByRepo(v.repoId, provider);
    if (taken && taken.accountId !== v.accountId) throw new HttpError(409, `${v.fullName} is already another account's vault.`, "REPO_TAKEN");
    if (!taken) return { vault: await this.insertVault(v, at) };
    const stale = taken.status === "bootstrapping" && taken.updated < this.stamp(-STALE_BOOTSTRAP_MS);
    if (taken.status === "ready") throw new HttpError(409, `${taken.fullName} is already one of your vaults.`, "ALREADY_VAULT");
    if (taken.status === "bootstrapping" && !stale) throw new HttpError(409, `${taken.fullName} is being set up right now.`, "BUSY");
    // Compare-and-set on `updated`, so two tabs can't both take it back.
    const row = await this.one<VaultRow>(
      `UPDATE vaults SET owner = ?, installation_id = ?, full_name = ?, branch = ?, status = 'bootstrapping', reason = NULL, updated = ?
       WHERE id = ? AND updated = ? RETURNING ${VAULT_COLUMNS}`,
      [v.owner, v.installationId, v.fullName, v.branch, at, taken.id, taken.updated],
    );
    if (!row) throw new HttpError(409, `${taken.fullName} is being set up right now.`, "BUSY");
    return { vault: toVault(row) };
  }

  private async insertVault(v: NewVault & { owner: string }, at: string): Promise<VaultRecord> {
    const provider = v.provider ?? "github";
    let row: VaultRow | undefined;
    try {
      // The count is in the insert, so two requests racing each other can't both get past the cap.
      row = await this.one<VaultRow>(
        `INSERT INTO vaults (id, account_id, owner, provider, installation_id, repo_id, full_name, branch, status, created, updated)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'bootstrapping', ?, ?
         WHERE (SELECT COUNT(*) FROM vaults WHERE owner = ? OR (owner IS NULL AND account_id = ?)) < ?
         RETURNING ${VAULT_COLUMNS}`,
        [ulid(this.now()), v.accountId, v.owner, provider, v.installationId, storedRepoId(provider, v.repoId), v.fullName, v.branch, at, at, v.owner, v.accountId, MAX_VAULTS_PER_USER],
      );
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(String(err))) throw new HttpError(409, `${v.fullName} is already a vault.`, "REPO_TAKEN");
      throw err;
    }
    if (!row) throw new HttpError(409, `You can have ${MAX_VAULTS_PER_USER} vaults; remove one first.`, "VAULT_LIMIT");
    await this.db.all("INSERT INTO vault_members (vault_id, user_id, role, added_by, created, updated) VALUES (?, ?, 'owner', ?, ?, ?) ON CONFLICT DO NOTHING", [row.id, v.owner, v.owner, at, at]);
    return toVault(row);
  }

  /** Forget a vault and its keys. The repo is the person's and stays as it is. Callers destroy its Durable Object. */
  async removeVault(id: string): Promise<void> {
    await this.db.batch([
      { sql: "DELETE FROM keys WHERE vault_id = ?", params: [id] },
      { sql: "DELETE FROM vault_members WHERE vault_id = ?", params: [id] },
      { sql: "UPDATE invites SET revoked = ? WHERE vault_id = ? AND accepted IS NULL AND revoked IS NULL", params: [this.stamp(), id] },
      { sql: "DELETE FROM vaults WHERE id = ?", params: [id] },
      { sql: "UPDATE users SET last_vault = NULL WHERE last_vault = ?", params: [id] },
    ]);
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

  // ── GitLab connections ─────────────────────────────────────────────────────

  async gitlabCredential(accountId: number): Promise<GitLabCredentialRow | undefined> {
    const row = await this.one<GitLabCredentialDbRow>("SELECT * FROM gitlab_credentials WHERE account_id = ?", [accountId]);
    return row && { accountId: row.account_id, gitlabUserId: row.gitlab_user_id, gitlabLogin: row.gitlab_login, secret: row.secret, version: row.version, updated: row.updated };
  }

  /**
   * Connect (or reconnect) the account to GitLab, replacing any earlier connection. The GitLab user
   * becomes one of the user's identities; whoever connected it last holds it.
   */
  async saveGitLabCredential(c: { accountId: number; gitlabUserId: number; gitlabLogin: string; secret: string }): Promise<void> {
    const at = this.stamp();
    await this.db.batch([
      {
        sql: `INSERT INTO gitlab_credentials (account_id, gitlab_user_id, gitlab_login, secret, version, updated) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT (account_id) DO UPDATE SET gitlab_user_id = excluded.gitlab_user_id, gitlab_login = excluded.gitlab_login,
         secret = excluded.secret, version = gitlab_credentials.version + 1, updated = excluded.updated`,
        params: [c.accountId, c.gitlabUserId, c.gitlabLogin, c.secret, at],
      },
      { sql: "DELETE FROM identities WHERE provider = 'gitlab' AND user_id = (SELECT id FROM users WHERE legacy_account = ?)", params: [c.accountId] },
      {
        sql: `INSERT INTO identities (provider, subject, login, user_id, created, updated)
         SELECT 'gitlab', ?, ?, id, ?, ? FROM users WHERE legacy_account = ?
         ON CONFLICT (provider, subject) DO UPDATE SET login = excluded.login, user_id = excluded.user_id, updated = excluded.updated`,
        params: [String(c.gitlabUserId), c.gitlabLogin, at, at, c.accountId],
      },
    ]);
  }

  /**
   * Store refreshed tokens, only if nobody else refreshed since `version` was read. GitLab
   * invalidates a refresh token once used, so the loser of a race must re-read, not overwrite.
   */
  async rotateGitLabSecret(accountId: number, version: number, secret: string): Promise<boolean> {
    const row = await this.one("UPDATE gitlab_credentials SET secret = ?, version = version + 1, updated = ? WHERE account_id = ? AND version = ? RETURNING account_id", [secret, this.stamp(), accountId, version]);
    return !!row;
  }

  async deleteGitLabCredential(accountId: number): Promise<void> {
    await this.db.batch([
      { sql: "DELETE FROM gitlab_credentials WHERE account_id = ?", params: [accountId] },
      { sql: "DELETE FROM identities WHERE provider = 'gitlab' AND user_id = (SELECT id FROM users WHERE legacy_account = ?)", params: [accountId] },
    ]);
  }

  /** Every GitLab vault that is serving or being set up, for the health check. */
  async gitlabVaults(): Promise<VaultRecord[]> {
    return (await this.db.all<VaultRow>(`SELECT ${VAULT_COLUMNS} FROM vaults WHERE provider = 'gitlab' AND status != 'bootstrapping' ORDER BY created`)).map(toVault);
  }

  // ── Keys ───────────────────────────────────────────────────────────────────

  /** A new key for the vault. Returns the key itself (show it once) and its record. */
  async mintKey(vaultId: string, req: KeyRequest, createdBy?: string): Promise<{ token: string; key: KeyRecord }> {
    const token = newToken();
    const hash = await hashToken(token);
    const row = await this.one<KeyRow>(
      `INSERT INTO keys (hash, vault_id, kind, agent, scopes, label, created, created_by)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM keys WHERE vault_id = ?) < ?
       RETURNING *`,
      [hash, vaultId, req.kind, req.agent ?? null, JSON.stringify(stored(req.scopes)), req.label, this.stamp(), createdBy ?? null, vaultId, MAX_KEYS_PER_VAULT],
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
      `SELECT k.*, v.id AS v_id, v.account_id AS v_account_id, v.owner AS v_owner, v.provider AS v_provider, v.installation_id AS v_installation_id, v.repo_id AS v_repo_id,
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
      owner: row.v_owner,
      provider: row.v_provider,
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
  async keys(vaultId: string, createdBy?: string): Promise<KeyRecord[]> {
    const rows = createdBy
      ? await this.db.all<KeyRow>("SELECT * FROM keys WHERE vault_id = ? AND created_by = ? ORDER BY created DESC, hash", [vaultId, createdBy])
      : await this.db.all<KeyRow>("SELECT * FROM keys WHERE vault_id = ? ORDER BY created DESC, hash", [vaultId]);
    return rows.map(toKey);
  }

  /** Revoke one of this vault's keys. Another vault's key is "not found", so ids can't be probed. */
  /** With `createdBy`, only that person's key (a member revoking their own). */
  async revokeKey(vaultId: string, hash: string, createdBy?: string): Promise<void> {
    const gone = createdBy
      ? await this.one("DELETE FROM keys WHERE hash = ? AND vault_id = ? AND created_by = ? RETURNING hash", [hash, vaultId, createdBy])
      : await this.one("DELETE FROM keys WHERE hash = ? AND vault_id = ? RETURNING hash", [hash, vaultId]);
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

  // ── Members ────────────────────────────────────────────────────────────────

  /** Who's in the vault: its owner first, then members and viewers by when they joined. */
  async members(vaultId: string): Promise<Member[]> {
    const rows = await this.db.all<{ user: string; login: string | null; role: Role; human: string | null; since: string }>(
      `SELECT u.id AS user, (SELECT login FROM identities i WHERE i.user_id = u.id AND i.provider = 'github') AS login,
         CASE WHEN v.owner = u.id THEN 'owner' ELSE m.role END AS role, m.human AS human, m.created AS since
       FROM vault_members m JOIN users u ON u.id = m.user_id JOIN vaults v ON v.id = m.vault_id
       WHERE m.vault_id = ?
       ORDER BY CASE WHEN v.owner = u.id THEN 0 ELSE 1 END, m.created, u.id`,
      [vaultId],
    );
    return rows.map((r) => ({ user: r.user, login: r.login ?? r.user, role: r.role, ...(r.human ? { human: r.human } : {}), since: r.since }));
  }

  private async addMember(vaultId: string, userId: string, role: Exclude<Role, "owner">, human: string | undefined, addedBy: string): Promise<void> {
    const at = this.stamp();
    const row = await this.one(
      `INSERT INTO vault_members (vault_id, user_id, role, human, added_by, created, updated)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM vault_members WHERE vault_id = ?) < ?
       ON CONFLICT (vault_id, user_id) DO NOTHING
       RETURNING user_id`,
      [vaultId, userId, role, human ?? null, addedBy, at, at, vaultId, MAX_MEMBERS_PER_VAULT],
    );
    if (row) return;
    if (await this.one("SELECT 1 AS x FROM vault_members WHERE vault_id = ? AND user_id = ?", [vaultId, userId])) throw new HttpError(409, "You're in this vault already.", "ALREADY_MEMBER");
    throw new HttpError(409, `A vault can be shared with ${MAX_MEMBERS_PER_VAULT - 1} people.`, "TOO_MANY_MEMBERS");
  }

  /** Change a member's role. The owner's can't change here. */
  async setMemberRole(vaultId: string, userId: string, role: Exclude<Role, "owner">): Promise<void> {
    const row = await this.one("UPDATE vault_members SET role = ?, updated = ? WHERE vault_id = ? AND user_id = ? AND role != 'owner' RETURNING user_id", [role, this.stamp(), vaultId, userId]);
    if (!row) throw new HttpError(404, "No such member.", "NOT_FOUND");
  }

  /** Take someone out of a vault, with the keys they made for it. Returns their membership, for unlinking their human. */
  async removeMember(vaultId: string, userId: string): Promise<{ human?: string } | undefined> {
    const row = await this.one<{ human: string | null; role: Role }>("SELECT human, role FROM vault_members WHERE vault_id = ? AND user_id = ?", [vaultId, userId]);
    if (!row || row.role === "owner") return undefined;
    await this.db.batch([
      { sql: "DELETE FROM keys WHERE vault_id = ? AND created_by = ?", params: [vaultId, userId] },
      { sql: "DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?", params: [vaultId, userId] },
    ]);
    return row.human ? { human: row.human } : {};
  }

  // ── Invites ────────────────────────────────────────────────────────────────

  /**
   * A new invite. Returns its token (shown once, as a link) and the invite. A vault has at most
   * MAX_PENDING_VAULT_INVITES open; a person at most MAX_PENDING_APP_INVITES to the app (`admin`: no cap).
   */
  async createInvite(n: NewInvite, opts: { admin?: boolean } = {}): Promise<{ token: string; invite: Invite }> {
    const token = `hinv_${newToken().slice("hippo_".length)}`;
    const id = await hashToken(token);
    const at = this.stamp();
    const open = "accepted IS NULL AND revoked IS NULL AND expires > ?";
    const [count] = n.vaultId
      ? await this.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM invites WHERE vault_id = ? AND ${open}`, [n.vaultId, at])
      : await this.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM invites WHERE vault_id IS NULL AND created_by = ? AND ${open}`, [n.createdBy, at]);
    if (n.vaultId && count!.n >= MAX_PENDING_VAULT_INVITES) throw new HttpError(409, `A vault can have ${MAX_PENDING_VAULT_INVITES} open invites; revoke some first.`, "TOO_MANY_INVITES");
    if (!n.vaultId && !opts.admin && count!.n >= MAX_PENDING_APP_INVITES) throw new HttpError(409, `You can have ${MAX_PENDING_APP_INVITES} open invites; revoke some, or wait for them to be used.`, "TOO_MANY_INVITES");
    const row = await this.one<InviteRow>(
      `INSERT INTO invites (id, vault_id, role, human, domains, provider, login, created_by, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [id, n.vaultId ?? null, n.role ?? null, n.human ?? null, n.domains?.length ? JSON.stringify(n.domains) : null, n.login?.provider ?? null, n.login?.login ?? null, n.createdBy, at, this.stamp(INVITE_TTL_MS)],
    );
    return { token, invite: toInvite(row!) };
  }

  async invite(id: string): Promise<Invite | undefined> {
    const row = await this.one<InviteRow>("SELECT * FROM invites WHERE id = ?", [id]);
    return row && toInvite(row);
  }

  async inviteForToken(token: string): Promise<Invite | undefined> {
    return token.startsWith("hinv_") ? this.invite(await hashToken(token)) : undefined;
  }

  /** Whether an invite can still be accepted. */
  isOpen(i: Invite): boolean {
    return !i.accepted && !i.revoked && i.expires > this.stamp();
  }

  /** Open invites: a vault's (`vaultId`), or a person's to the app (`createdBy`). */
  async openInvites(where: { vaultId: string } | { createdBy: string }): Promise<Invite[]> {
    const rows =
      "vaultId" in where
        ? await this.db.all<InviteRow>("SELECT * FROM invites WHERE vault_id = ? AND accepted IS NULL AND revoked IS NULL AND expires > ? ORDER BY created DESC", [where.vaultId, this.stamp()])
        : await this.db.all<InviteRow>("SELECT * FROM invites WHERE vault_id IS NULL AND created_by = ? AND accepted IS NULL AND revoked IS NULL AND expires > ? ORDER BY created DESC", [where.createdBy, this.stamp()]);
    return rows.map(toInvite);
  }

  /** Open invites addressed to one of these logins, for showing to the person they're for. */
  async invitesFor(logins: { provider: Provider; login: string }[]): Promise<Invite[]> {
    const out: Invite[] = [];
    for (const l of logins) {
      const rows = await this.db.all<InviteRow>(
        "SELECT * FROM invites WHERE provider = ? AND login = ? COLLATE NOCASE AND accepted IS NULL AND revoked IS NULL AND expires > ? ORDER BY created",
        [l.provider, l.login, this.stamp()],
      );
      out.push(...rows.map(toInvite));
    }
    return out;
  }

  /** How many app invites the person sent were accepted. */
  async acceptedInvites(createdBy: string): Promise<number> {
    const [row] = await this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND accepted IS NOT NULL", [createdBy]);
    return row?.n ?? 0;
  }

  async revokeInvite(id: string): Promise<void> {
    const row = await this.one("UPDATE invites SET revoked = ? WHERE id = ? AND accepted IS NULL AND revoked IS NULL RETURNING id", [this.stamp(), id]);
    if (!row) throw new HttpError(404, "No such invite: it may be used or revoked already.", "NOT_FOUND");
  }

  /**
   * Accept an invite as `account`: once only, while open, and only by the login it names. It approves
   * the account (a denied one stays denied), records who invited them, and for a vault invite seats
   * them with the invite's role and human. The caller links their login to that human in the vault.
   */
  async acceptInvite(invite: Invite, account: Account, logins: { provider: Provider; login: string }[]): Promise<Invite> {
    if (account.status === "denied" || account.status === "deleted") throw new HttpError(403, "Access to this Hippocampus wasn't granted.", "DENIED");
    if (invite.login && !logins.some((l) => l.provider === invite.login!.provider && l.login.toLowerCase() === invite.login!.login.toLowerCase()))
      throw new HttpError(403, `This invite is for @${invite.login.login}. Sign in as them to accept it.`, "WRONG_ACCOUNT");
    if (invite.createdBy === account.user) throw new HttpError(400, "That's your own invite.", "OWN_INVITE");
    if (invite.vaultId) {
      const vault = await this.vault(invite.vaultId);
      if (!vault || vault.status !== "ready") throw new HttpError(409, "That vault isn't available right now. Ask whoever invited you.", "NOT_READY");
      if (vault.owner === account.user || (await this.vaultsOf(account)).some((v) => v.id === vault.id)) throw new HttpError(409, "You're in this vault already.", "ALREADY_MEMBER");
    }
    const at = this.stamp();
    const taken = await this.one<InviteRow>("UPDATE invites SET accepted = ?, accepted_by = ? WHERE id = ? AND accepted IS NULL AND revoked IS NULL AND expires > ? RETURNING *", [at, account.user, invite.id, at]);
    if (!taken) throw new HttpError(410, "This invite was used, revoked, or has expired. Ask for a new one.", "INVITE_GONE");
    try {
      if (invite.vaultId) await this.addMember(invite.vaultId, account.user, invite.role ?? "member", invite.human, invite.createdBy);
    } catch (err) {
      // Not seated after all (the vault is full): the invite stays usable.
      await this.db.all("UPDATE invites SET accepted = NULL, accepted_by = NULL WHERE id = ?", [invite.id]);
      throw err;
    }
    await this.db.batch([
      { sql: "UPDATE users SET invited_by = ? WHERE id = ? AND invited_by IS NULL", params: [invite.createdBy, account.user] },
      ...(account.status === "waitlisted" ? [{ sql: "UPDATE accounts SET status = 'approved', updated = ? WHERE id = ? AND status = 'waitlisted'", params: [at, account.id] }, { sql: SYNC_USER, params: [account.id] }] : []),
    ]);
    return toInvite(taken);
  }

  /** The referral graph: every accepted invite, oldest first. */
  async referrals(): Promise<Referral[]> {
    const rows = await this.db.all<{ from: string; to: string; at: string; vault: string | null }>(
      `SELECT created_by AS "from", accepted_by AS "to", accepted AS at, vault_id AS vault FROM invites WHERE accepted IS NOT NULL ORDER BY accepted, id`,
    );
    return rows.map((r) => ({ from: r.from, to: r.to, at: r.at, ...(r.vault ? { vault: r.vault } : {}) }));
  }

  /** Every user, for the referral graph: their id, GitHub login, status and who invited them. */
  async people(): Promise<{ user: string; login: string; status: AccountStatus; invitedBy?: string; canInvite: boolean }[]> {
    const rows = await this.db.all<AccountRow>(`${ACCOUNT_SELECT} ORDER BY u.created, u.id`);
    return rows.map((r) => ({ user: r.user, login: r.login, status: r.status, ...(r.invited_by ? { invitedBy: r.invited_by } : {}), canInvite: r.can_invite !== 0 }));
  }

  /** Let a user invite people to the app, or stop them. */
  async setCanInvite(userId: string, allow: boolean): Promise<void> {
    const row = await this.one("UPDATE users SET can_invite = ? WHERE id = ? RETURNING id", [allow ? 1 : 0, userId]);
    if (!row) throw new HttpError(404, "No such user", "NOT_FOUND");
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
