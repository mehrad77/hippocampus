import { AuditError, CONFIG_PATH, CURRENT_VAULT_VERSION, HippoService, humanByLogin, StoreConflictError, Vault, displayName, migrate, parseConfig, vaultVersionStatus, type HippoConfig, type SearcherFactory } from "@hippocampus/core";
import { SleepRelay, type RunStore } from "@hippocampus/curator/relay";
import { HttpError, createDashboardApi, errorResponse, json, serviceSource, type DashboardSource, type ErrorReport, type SourceInfo, type VaultUpgrade } from "@hippocampus/dashboard";
import { HippoIndex, doSql, type DurableSqlLike, type SqlStorageLike } from "@hippocampus/index";
import { createHippoServer, type Scope } from "@hippocampus/mcp";
import { GitHubStore, SnapshotCache, SqliteBlobCache, type BlobCache } from "@hippocampus/store-github";
import { GitLabStore } from "@hippocampus/store-gitlab";
import { TEMPLATE } from "@hippocampus/template";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { ScribeQueue } from "../scribe.ts";
import { AuditedStore, type Principal } from "./audited-store.ts";
import { VAULT_PERMISSIONS, migrationCommit } from "./bootstrap.ts";
import { cappedEmbedder, type HostedEmbedding } from "./embed-cap.ts";
import type { InstallationToken, Narrowing, Permissions } from "./github-app.ts";
import { logEvent } from "./limits.ts";
import { DailyCounter, QUOTAS, limitRuns, quotaOverrides, sizeGuard, type Quotas, type SizeGuarded } from "./quotas.ts";
import { SqlRunStore, onPut } from "./run-store.ts";

// One hosted vault, served from its own Durable Object. Everything here is plain TypeScript over
// ports (the object's storage, a token minter, fetch), so it runs under Node in tests; vault-host.ts
// is the thin Workers shell around it. Nothing lives in module scope: several objects share an isolate.

export interface VaultMeta {
  /** The registry's vault id (also the Durable Object's name). */
  vaultId: string;
  fullName: string;
  branch: string;
  repoId: number;
  /** The GitHub App installation; 0 (or absent) for GitLab vaults. */
  installationId: number;
  /** Where the repo lives; absent means GitHub. */
  provider?: "github" | "gitlab";
  /** The account whose GitLab connection the vault uses. GitLab vaults only. */
  accountId?: number;
  /** An admin's overrides of the hosted limits for this vault; absent means the defaults. */
  quotas?: Partial<Quotas>;
}

/** What an authenticated MCP caller may do, from its key or OAuth grant. */
export interface VaultGrant {
  /** The bound agent; absent for `agent` keys (the agent names itself per call) and curator keys. */
  agent?: string;
  scopes: Scope[];
  via: "key" | "oauth";
  keyKind?: "agent" | "curator" | "bound";
}

/** The signed-in owner on the dashboard. */
export interface DashboardUser {
  /** The GitHub login the person signed in with. */
  login: string;
  /** Their connected GitLab username, for a vault on GitLab. */
  gitlab?: string;
  account: { status: "waitlisted" | "approved"; admin: boolean };
}

/** `ctx.storage` of a SQLite-backed Durable Object, as far as a vault uses it. */
export interface RuntimeStorage extends DurableSqlLike {
  deleteAll?(): Promise<void>;
  deleteAlarm?(): Promise<void>;
  setAlarm?(scheduledTime: number): Promise<void>;
  getAlarm?(): Promise<number | null>;
}

/** The GitHub App, as far as a vault needs it (`GitHubApp` fits). */
export interface TokenMinter {
  installationToken(installationId: number, narrow?: Narrowing): Promise<InstallationToken>;
}

/** GitLab, as far as a vault needs it. */
export interface GitLabDeps {
  /** The REST root, `https://gitlab.com/api/v4`. */
  apiUrl: string;
  /** GitLab's web origin, for links to the project. */
  webUrl: string;
  /** A token function for the account's connection; it refreshes itself. */
  tokenFor(accountId: number): (opts?: { refresh?: boolean }) => Promise<string>;
}

export interface VaultRuntimeDeps {
  storage: RuntimeStorage;
  meta: VaultMeta;
  app: TokenMinter;
  /** Present when the instance has GitLab set up; GitLab vaults can't be served without it. */
  gitlab?: GitLabDeps;
  apiUrl?: string;
  /** GitHub's web origin, for links to the repo. */
  webUrl?: string;
  fetch?: typeof fetch;
  clock?: () => Date;
  /** Semantic recall; the runtime caps it per day. */
  embedding?: HostedEmbedding;
  /** Workers need one that doesn't compile code at runtime. */
  jsonSchemaValidator?: jsonSchemaValidator;
  quotas?: Partial<Quotas>;
  log?: (line: string) => void;
  /** The format migration; tests swap it to make it misbehave. */
  migrate?: typeof migrate;
}

export const DASHBOARD_API = "/dashboard/api";
/** Installation tokens last an hour; one this close to expiring is replaced. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Blobs nobody read for this long leave the object's SQLite. */
const BLOB_TTL_MS = 14 * 24 * 3600_000;
const GC_EVERY_MS = 24 * 3600_000;
/** Inbox blobs, held in memory only. */
const TRANSIENT_BYTES = 8 * 1024 * 1024;

/** What the runtime's token may do: the bootstrap's permissions without `workflows`, since only the bootstrap installs the vault's CI. */
export const RUNTIME_PERMISSIONS: Permissions = Object.fromEntries(Object.entries(VAULT_PERMISSIONS).filter(([name]) => name !== "workflows"));

const HUMAN: Principal = { kind: "human" };
const CURATOR: Principal = { kind: "curator" };
const MIGRATION: Principal = { kind: "migration" };

/**
 * The vault is older than this Worker's format. Nothing here migrates it until its owner clicks
 * Upgrade on the dashboard, so a Worker rolled back right after a deploy never meets a vault it can't read.
 * Says nothing about the vault's content.
 */
export const upgradeNeeded = () =>
  new HttpError(409, "This vault uses an older format. Its owner can upgrade it on the Hippocampus dashboard.", "VAULT_UPGRADE_NEEDED");
/** Someone pushed while the upgrade was computed: clicking again redoes it against the new head. */
const upgradeRaced = () => new HttpError(409, "The vault changed while it was being upgraded. Try again.", "CONFLICT");
/** The upgrade can't be done here (the audit refused it): only the owner, locally, can. Says nothing about the vault's content. */
const upgradeRefused = () =>
  new HttpError(409, "This vault's upgrade can't be applied here. The owner can run `hippo migrate` in a local clone and push.", "VAULT_UPGRADE_REFUSED");

export const grantPrincipal = (grant: VaultGrant): Principal => ({ kind: "agent", agent: grant.agent, scopes: grant.scopes });

const TOKENS_TABLE = "CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, expires_at INTEGER NOT NULL)";

/** Drop the stored installation token (the vault moved to another repo or installation). */
export function forgetToken(sql: SqlStorageLike): void {
  sql.exec(TOKENS_TABLE).toArray();
  sql.exec("DELETE FROM tokens").toArray();
}

/**
 * A token function for `GitHubStore`, backed by the object's SQLite so a restarted object reuses
 * its installation token instead of minting one per wake-up. `refresh` (after a 401) mints anew.
 */
export function storedToken(sql: SqlStorageLike, mint: () => Promise<InstallationToken>, now: () => number): (opts?: { refresh?: boolean }) => Promise<string> {
  sql.exec(TOKENS_TABLE).toArray();
  let minting: Promise<string> | undefined;
  return async (opts) => {
    if (!opts?.refresh) {
      const [row] = sql.exec("SELECT token, expires_at FROM tokens WHERE id = 1").toArray() as { token: string; expires_at: number }[];
      if (row && row.expires_at - TOKEN_MARGIN_MS > now()) return row.token;
    }
    minting ??= mint()
      .then((t) => {
        sql
          .exec("INSERT INTO tokens (id, token, expires_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at", t.token, t.expiresAt.getTime())
          .toArray();
        return t.token;
      })
      .finally(() => {
        minting = undefined;
      });
    return minting;
  };
}

/** In-memory LRU bounded by size (string length), for blobs that mustn't be stored at rest. */
export class ByteLru implements BlobCache {
  private readonly entries = new Map<string, string>();
  private size = 0;

  constructor(private readonly maxSize: number) {}

  async get(sha: string): Promise<string | undefined> {
    const hit = this.entries.get(sha);
    if (hit !== undefined) {
      this.entries.delete(sha);
      this.entries.set(sha, hit);
    }
    return hit;
  }

  async put(sha: string, content: string): Promise<void> {
    if (content.length > this.maxSize) return;
    const old = this.entries.get(sha);
    if (old !== undefined) {
      this.entries.delete(sha);
      this.size -= old.length;
    }
    this.entries.set(sha, content);
    this.size += content.length;
    for (const [key, value] of this.entries) {
      if (this.size <= this.maxSize) break;
      this.entries.delete(key);
      this.size -= value.length;
    }
  }
}

/**
 * One configured vault: per-request stores over shared caches, the audited single writer, the
 * index, the sleep relay, and the MCP and dashboard handlers.
 */
export class VaultRuntime {
  readonly meta: VaultMeta;
  readonly relay: SleepRelay;
  readonly blobs: SqliteBlobCache;
  private readonly transient = new ByteLru(TRANSIENT_BYTES);
  private readonly snapshots = new SnapshotCache(4);
  private readonly token: (opts?: { refresh?: boolean }) => Promise<string>;
  private readonly writer: ScribeQueue;
  private readonly counter: DailyCounter;
  private readonly quotas: Quotas;
  private readonly clock: () => Date;
  private index?: Promise<HippoIndex>;
  private gcScheduled = false;
  /** Where the vault keeps unconsolidated episodes (`folders.inbox`); they stay out of storage at rest. */
  private inboxPrefix = "inbox/";
  private inboxKnown?: Promise<void>;
  /** The vault is known to be in the current format (see `format`). */
  private current = false;
  private upgrading?: Promise<VaultUpgrade>;
  private readonly runs: RunStore;

  constructor(private readonly d: VaultRuntimeDeps) {
    this.meta = d.meta;
    this.clock = d.clock ?? (() => new Date());
    const now = () => this.clock().getTime();
    // The vault's own overrides win over the test-only deps, which win over the defaults.
    this.quotas = { ...QUOTAS, ...d.quotas, ...d.meta.quotas };
    this.blobs = new SqliteBlobCache(d.storage.sql, { now });
    this.counter = new DailyCounter(d.storage.sql, this.clock);
    const { installationId, repoId } = d.meta;
    if (d.meta.provider === "gitlab") {
      if (!d.gitlab || !d.meta.accountId) throw new Error("This vault is on GitLab, but GitLab isn't set up on this instance");
      this.token = d.gitlab.tokenFor(d.meta.accountId);
    } else this.token = storedToken(d.storage.sql, () => d.app.installationToken(installationId, { repositoryIds: [repoId], permissions: RUNTIME_PERMISSIONS }), now);
    this.writer = new ScribeQueue(this.reads());
    this.runs = this.leased(limitRuns(new SqlRunStore(d.storage.sql), this.counter, this.quotas.sleepRunsPerDay));
    this.relay = new SleepRelay({
      open: async (at) => {
        await this.ready();
        const store = this.store(CURATOR);
        return { vault: await Vault.load(store, { now: () => at }), store };
      },
      runs: this.runs,
      clock: this.clock,
    });
  }

  /** Reads pinned to the branch head when first used; caches shared with every other store of this vault. */
  private reads(): GitHubStore | GitLabStore {
    const shared = {
      branch: this.meta.branch,
      token: this.token,
      fetch: this.d.fetch,
      cache: this.blobs,
      // Episodes can hold secrets in plain text until sleep encrypts them: they stay out of storage at rest.
      persist: (path: string) => !path.startsWith(this.inboxPrefix),
      transientCache: this.transient,
      snapshots: this.snapshots,
    };
    if (this.meta.provider === "gitlab") {
      // By id, not path: the id survives renames and transfers.
      return new GitLabStore({ ...shared, project: this.meta.repoId, apiUrl: this.d.gitlab!.apiUrl, hint: { auth: "Connect GitLab again from the setup page." } });
    }
    return new GitHubStore({ ...shared, repo: this.meta.fullName, apiUrl: this.d.apiUrl });
  }

  /** A store for one request or relay step: its writes are audited as `principal` and committed one at a time. */
  store(principal: Principal): SizeGuarded {
    return sizeGuard(new AuditedStore({ reads: this.reads(), writer: this.writer, principal, quotas: this.quotas }), this.quotas);
  }

  private readonly searcher: SearcherFactory = async (vault) => (await this.openIndex()).searcher(vault);

  private openIndex(): Promise<HippoIndex> {
    const e = this.d.embedding;
    const opts = e ? { embedder: cappedEmbedder(e.embedder, this.counter, e.dailyLimit), minSimilarity: e.minSimilarity } : {};
    this.index ??= HippoIndex.open(doSql(this.d.storage), opts).catch((err: unknown) => {
      this.index = undefined;
      throw err;
    });
    return this.index;
  }

  /**
   * Learns the vault's inbox folder before any request reads from it. Memoized; a failed read
   * (a missing or broken config) keeps the default and is retried by the next request.
   */
  private learnInbox(): Promise<void> {
    this.inboxKnown ??= this.reads()
      .read(CONFIG_PATH)
      .then((raw) => {
        this.inboxPrefix = `${parseConfig(raw ?? undefined).folders.inbox.replace(/\/+$/, "")}/`;
      })
      .catch(() => {
        this.inboxKnown = undefined;
      });
    return this.inboxKnown;
  }

  /** What every request waits for: the inbox folder known, and the vault in the current format. */
  private async ready(): Promise<void> {
    await this.learnInbox();
    if ((await this.format()).status === "older") throw upgradeNeeded();
  }

  /**
   * The vault's config and how its format compares to this Worker's. Only "current" is remembered:
   * an older vault is read again on every request, so an upgrade pushed from a local clone counts at once.
   * A missing or broken config isn't decided here: loading the vault explains it.
   */
  private async format(): Promise<{ status: "current" | "older" | "newer" | "unknown"; config?: HippoConfig }> {
    if (this.current) return { status: "current" };
    let config: HippoConfig | undefined;
    try {
      const raw = await this.reads().read(CONFIG_PATH);
      config = raw === undefined ? undefined : parseConfig(raw);
    } catch {
      config = undefined;
    }
    if (!config) return { status: "unknown" };
    const status = vaultVersionStatus(config);
    if (status === "current") this.current = true;
    return { status, config };
  }

  /**
   * The owner's Upgrade button: brings an older vault to the current format as one audited commit by
   * the `migration` actor, and aborts a sleep run that was asked about the old tree. Clicks that
   * arrive together share one upgrade; a click on a current vault changes nothing.
   */
  upgrade(): Promise<VaultUpgrade> {
    this.upgrading ??= this.migrateIfOlder().finally(() => {
      this.upgrading = undefined;
    });
    return this.upgrading;
  }

  private async migrateIfOlder(): Promise<VaultUpgrade> {
    const started = Date.now();
    const { status, config } = await this.format();
    if (status !== "older" || !config) {
      const version = config?.version ?? CURRENT_VAULT_VERSION;
      return { upgraded: false, from: version, to: version, changed: 0, notes: [] };
    }
    const reads = this.reads();
    const result = await (this.d.migrate ?? migrate)(reads, config, { dryRun: true, template: TEMPLATE });
    const done = (code?: string, status = 200) =>
      logEvent({ route: "vault/upgrade", vault: this.meta.vaultId, status, ...(code ? { code } : {}), ms: Date.now() - started }, this.d.log).catch(() => undefined);
    if (result.changes.length) {
      // Audited like any hosted write: as the migration actor, against the commit it was computed from.
      const store = new AuditedStore({ reads, writer: this.writer, principal: MIGRATION, quotas: this.quotas });
      try {
        await store.apply(result.changes, migrationCommit(result.to));
      } catch (err) {
        if (err instanceof AuditError) {
          await done("VAULT_UPGRADE_REFUSED", 409);
          throw upgradeRefused();
        }
        if (err instanceof StoreConflictError) {
          await done("CONFLICT", 409);
          throw upgradeRaced();
        }
        throw err;
      }
    }
    this.current = true;
    await done();
    // A run open across the upgrade asked about the old tree.
    const run = await this.runs.get();
    if (run) await this.relay.abort(run.id).catch(() => undefined);
    return { upgraded: true, from: result.from, to: result.to, changed: result.changed.length, notes: result.notes };
  }

  private serviceOver(store: SizeGuarded): HippoService {
    return new HippoService(store, { searcher: this.searcher, now: this.clock });
  }

  /** The service for one request: the human's (dashboard), or an MCP grant's. */
  service(grant?: VaultGrant): HippoService {
    return this.serviceOver(this.store(grant ? grantPrincipal(grant) : HUMAN));
  }

  /** Every save of a live run renews its lease, so the alarm follows the lease and finishes a run its curator left. */
  private leased(runs: RunStore): RunStore {
    return onPut(runs, async (s, next) => {
      await next(s);
      const at = Date.parse(s.leaseUntil) + 1000;
      // A lapsed run is saved while it's being finished; it needs no alarm.
      if (at > this.clock().getTime()) await this.d.storage.setAlarm?.(at);
    });
  }

  private readonly curator: NonNullable<DashboardSource["curator"]> = {
    status: () => this.relay.status(),
    abort: (run) => this.relay.abort(run),
  };

  /** Logs that a request failed unexpectedly: its route and code only, never the error's message, which can quote the vault. */
  private report(route: string, started: number): ErrorReport {
    return () => {
      void logEvent({ route, vault: this.meta.vaultId, status: 500, code: "INTERNAL", ms: Date.now() - started }, this.d.log).catch(() => undefined);
    };
  }

  /** An object that's used gets a cache GC within a day; an idle one isn't woken. */
  private async keepAlarm(): Promise<void> {
    if (this.gcScheduled || !this.d.storage.getAlarm || !this.d.storage.setAlarm) return;
    this.gcScheduled = true;
    if ((await this.d.storage.getAlarm()) === null) await this.d.storage.setAlarm(this.clock().getTime() + GC_EVERY_MS);
  }

  /** MCP over HTTP (stateless, JSON responses) for an authenticated grant. */
  async mcp(request: Request, grant: VaultGrant): Promise<Response> {
    const started = Date.now();
    if (request.method !== "POST") return json(405, { error: "Method not allowed", code: "METHOD" }, { allow: "POST" });
    try {
      await this.keepAlarm();
      await this.ready();
      const store = this.store(grantPrincipal(grant));
      const server = createHippoServer({
        service: this.serviceOver(store),
        agent: grant.agent,
        scopes: grant.scopes,
        relay: grant.scopes.includes("curate") ? this.relay : undefined,
        jsonSchemaValidator: this.d.jsonSchemaValidator,
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      const res = await transport.handleRequest(request);
      // An oversized vault fails the request itself, so the client sees the code and not just a tool error.
      if (store.tripped) {
        await res.body?.cancel();
        return errorResponse(store.tripped);
      }
      return res;
    } catch (err) {
      return errorResponse(err, this.report("vault/mcp", started));
    }
  }

  /**
   * The dashboard's API (`/dashboard/api/...`) for the vault's signed-in owner, who acts as the human.
   * An older vault still answers the session and the Upgrade button; everything else says VAULT_UPGRADE_NEEDED.
   */
  async dashboard(request: Request, user: DashboardUser): Promise<Response> {
    const started = Date.now();
    try {
      await this.keepAlarm();
      await this.learnInbox();
      const { status, config } = await this.format();
      const repo = this.meta.fullName;
      const gitlab = this.meta.provider === "gitlab";
      const url = `${(gitlab ? this.d.gitlab!.webUrl : (this.d.webUrl ?? "https://github.com")).replace(/\/$/, "")}/${repo}`;
      const vault = { kind: gitlab ? ("gitlab" as const) : ("github" as const), repo, branch: this.meta.branch, url };
      const human = await this.humanOf(user);
      const upgradeVault = () => this.upgrade();
      const source: DashboardSource =
        status === "older" && config
          ? awaitingUpgrade(config, { mode: "worker", vault }, human, upgradeVault)
          : { ...serviceSource(this.service(), { mode: "worker", vault }, { curator: this.curator, ...(human ? { human } : {}) }), upgradeVault };
      const api = createDashboardApi({
        basePath: DASHBOARD_API,
        source: () => source,
        setupKind: "hosted",
        guard: () => ({ user: { login: user.login }, account: user.account }),
        report: this.report("vault/dashboard", started),
      });
      return await api(request);
    } catch (err) {
      return errorResponse(err, this.report("vault/dashboard", started));
    }
  }

  /**
   * Which human the signed-in person is: on a GitLab vault, the one whose `gitlab:` is their connected
   * GitLab username; else the one whose `github:` is their GitHub login; else the primary human.
   * Undefined when the config doesn't load.
   */
  private async humanOf(user: DashboardUser): Promise<string | undefined> {
    try {
      const { humans } = parseConfig(await this.reads().read(CONFIG_PATH));
      const onGitLab = this.meta.provider === "gitlab" ? humanByLogin(humans, user.gitlab, "gitlab") : undefined;
      return (onGitLab ?? humanByLogin(humans, user.login, "github") ?? humans[0])?.id;
    } catch {
      return undefined;
    }
  }

  /** The party's agents, for the OAuth consent page. */
  async party(): Promise<{ id: string; title: string }[]> {
    await this.ready();
    const vault = await this.service().vault();
    return vault
      .withCapability("actor")
      .map((e) => ({ id: e.slug, title: displayName(e) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Seats an agent, as the human (the consent page's "new agent"). */
  async addParty(input: { id: string; title: string; lane?: string; authority?: string[] }, via: string): Promise<{ slug: string }> {
    await this.ready();
    const { slug } = await this.service().addPartyMember({ id: input.id, title: input.title, lane: input.lane, authority: input.authority }, { via });
    return { slug };
  }

  /** Finishes a run whose lease passed, and drops cached blobs nobody read lately. */
  async alarm(): Promise<void> {
    this.gcScheduled = false;
    try {
      await this.relay.expire(this.clock());
    } finally {
      this.blobs.pruneOlderThan(BLOB_TTL_MS);
    }
    const { run } = await this.relay.status();
    if (run) await this.d.storage.setAlarm?.(Date.parse(run.leaseUntil) + 1000);
  }
}

/**
 * The dashboard over a vault in an older format: who's signed in, read from the config alone, and the
 * Upgrade button. Every read answers VAULT_UPGRADE_NEEDED, which is what the UI's banner looks for.
 */
function awaitingUpgrade(config: HippoConfig, info: Pick<SourceInfo, "mode" | "vault">, human: string | undefined, upgradeVault: () => Promise<VaultUpgrade>): DashboardSource {
  const refuse = async (): Promise<never> => {
    throw upgradeNeeded();
  };
  return {
    info: async () => ({
      ...info,
      name: config.name,
      campaign: config.campaign,
      human: config.human,
      humans: config.humans.map((h) => h.id),
      actor: { kind: "human", id: human ?? config.human },
    }),
    overview: refuse,
    catalog: refuse,
    entity: refuse,
    graph: refuse,
    chronicle: refuse,
    search: refuse,
    upgradeVault,
  };
}

// ── The Durable Object's state ────────────────────────────────────────────────

const META_TABLE = "CREATE TABLE IF NOT EXISTS vault_meta (id INTEGER PRIMARY KEY CHECK (id = 1), meta TEXT NOT NULL, disconnected TEXT)";

/** Where the object stands: never configured, serving `meta`, or disconnected (storage kept until destroyed). */
type HostState = { meta: VaultMeta; disconnected?: string } | undefined;

function checkMeta(m: VaultMeta): VaultMeta {
  const id = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (typeof m?.vaultId !== "string" || !m.vaultId) throw new Error("configure: vaultId is required");
  if (m.provider !== undefined && m.provider !== "github" && m.provider !== "gitlab") throw new Error("configure: provider must be github or gitlab");
  const gitlab = m.provider === "gitlab";
  // GitLab projects can sit in subgroups: group/subgroup/name.
  if (typeof m.fullName !== "string" || !(gitlab ? /^[\w.-]+(\/[\w.-]+)+$/ : /^[\w.-]+\/[\w.-]+$/).test(m.fullName)) throw new Error("configure: fullName must look like owner/name");
  if (typeof m.branch !== "string" || !m.branch.trim()) throw new Error("configure: branch is required");
  if (!id(m.repoId) || (gitlab ? !id(m.accountId) : !id(m.installationId))) throw new Error(gitlab ? "configure: repoId and accountId must be positive integers" : "configure: repoId and installationId must be positive integers");
  const quotas = quotaOverrides(m.quotas);
  return {
    vaultId: m.vaultId,
    fullName: m.fullName,
    branch: m.branch.trim(),
    repoId: m.repoId,
    installationId: gitlab ? 0 : m.installationId,
    ...(gitlab ? { provider: "gitlab" as const, accountId: m.accountId } : {}),
    ...(Object.keys(quotas).length ? { quotas } : {}),
  };
}

const sameMeta = (a: VaultMeta, b: VaultMeta) => JSON.stringify(checkMeta(a)) === JSON.stringify(checkMeta(b));

export type HostDeps = Omit<VaultRuntimeDeps, "storage" | "meta">;

/** The RPC surface's behavior, without the Workers runtime: `VaultHost` delegates every call here. */
export class HostedVault {
  private runtime?: VaultRuntime;

  /** `deps` is a function when building them can fail (missing secrets): that fails the calls that need them, not the object. */
  constructor(
    private readonly storage: RuntimeStorage & { deleteAll(): Promise<void> },
    private readonly deps: HostDeps | (() => HostDeps),
  ) {}

  private state(): HostState {
    // After `destroy` the table is gone; recreating it is how a fresh object starts too.
    this.storage.sql.exec(META_TABLE).toArray();
    const [row] = this.storage.sql.exec("SELECT meta, disconnected FROM vault_meta WHERE id = 1").toArray() as { meta: string; disconnected: string | null }[];
    return row ? { meta: JSON.parse(row.meta) as VaultMeta, disconnected: row.disconnected ?? undefined } : undefined;
  }

  /** The runtime, while configured and connected. */
  private live(): VaultRuntime | undefined {
    const state = this.state();
    if (!state || state.disconnected !== undefined) {
      this.runtime = undefined;
      return undefined;
    }
    this.runtime ??= new VaultRuntime({ ...(typeof this.deps === "function" ? this.deps() : this.deps), storage: this.storage, meta: state.meta });
    return this.runtime;
  }

  private unavailable(): { status: number; body: { error: string; code: string; reason?: string } } {
    const state = this.state();
    if (!state) return { status: 503, body: { error: "This vault isn't set up yet.", code: "VAULT_NOT_CONFIGURED" } };
    return { status: 503, body: { error: `This vault is disconnected from its ${state.meta.provider === "gitlab" ? "GitLab project" : "GitHub repo"}.`, code: "VAULT_DISCONNECTED", reason: state.disconnected } };
  }

  private require(): VaultRuntime {
    const rt = this.live();
    if (rt) return rt;
    const { body } = this.unavailable();
    throw new Error(`${body.code}: ${body.error}`);
  }

  /** Serve `meta`. Idempotent; a different repo or installation forgets the old token, and reconnects a disconnected vault. */
  async configure(meta: VaultMeta): Promise<void> {
    const next = checkMeta(meta);
    const state = this.state();
    if (state && sameMeta(state.meta, next) && state.disconnected === undefined) return;
    if (!state || !sameMeta(state.meta, next)) forgetToken(this.storage.sql);
    this.storage.sql
      .exec("INSERT INTO vault_meta (id, meta, disconnected) VALUES (1, ?, NULL) ON CONFLICT (id) DO UPDATE SET meta = excluded.meta, disconnected = NULL", JSON.stringify(next))
      .toArray();
    this.runtime = undefined;
  }

  async mcp(request: Request, grant: VaultGrant): Promise<Response> {
    return this.serve("vault/mcp", (rt) => rt.mcp(request, grant));
  }

  async dashboard(request: Request, user: DashboardUser): Promise<Response> {
    return this.serve("vault/dashboard", (rt) => rt.dashboard(request, user));
  }

  private async serve(route: string, handle: (rt: VaultRuntime) => Promise<Response>): Promise<Response> {
    let rt: VaultRuntime | undefined;
    try {
      rt = this.live();
    } catch {
      // Misconfigured secrets: the operator's problem, logged by code only.
      void logEvent({ route, status: 500, code: "MISCONFIGURED", ms: 0 }).catch(() => undefined);
      return json(500, { error: "The hosted app is misconfigured; see its log.", code: "MISCONFIGURED" });
    }
    if (rt) return handle(rt);
    const { status, body } = this.unavailable();
    return json(status, body);
  }


  async party(): Promise<{ id: string; title: string }[]> {
    return this.require().party();
  }

  async addParty(input: { id: string; title: string; lane?: string; authority?: string[] }, via: string): Promise<{ slug: string }> {
    return this.require().addParty(input, via);
  }

  /** Stop serving; storage stays until `destroy`, so a reconnect picks up where it left off. */
  async disconnect(reason: string): Promise<void> {
    if (!this.state()) return;
    this.storage.sql.exec("UPDATE vault_meta SET disconnected = ? WHERE id = 1", String(reason).slice(0, 40) || "disconnected").toArray();
    this.runtime = undefined;
  }

  async destroy(): Promise<void> {
    this.runtime = undefined;
    await this.storage.deleteAlarm?.();
    await this.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    await this.live()?.alarm();
  }
}
