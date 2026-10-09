import { SLUG, validTimezone, type VaultSettings } from "@hippocampus/core";
import { HttpError, type HostedInitResult, type HostedKeyInfo, type HostedMintedKey, type HostedRepo, type HostedSetupPort, type HostedSetupStatus, type HostedVault, type SetupItem, type Snippet } from "@hippocampus/dashboard";
import { GitHubStore } from "@hippocampus/store-github";
import { SEEDS } from "@hippocampus/template";
import { TOKEN_ID } from "../auth.ts";
import { bootstrapVault } from "./bootstrap.ts";
import { curatorActionsEnabled, setCuratorActions } from "./curator-actions.ts";
import type { GitHubApp, InstallationRepo } from "./github-app.ts";
import { keyRequest, type Account, type DisconnectReason, type KeyKind, type KeyRecord, type Registry, type VaultRecord } from "./registry.ts";
import { clearPendingInstallation, pendingInstallation, type SessionKV } from "./session.ts";
import { installUrl, newRepoUrl, type HostedSettings } from "./settings.ts";

// Session Zero on the hosted app, for one signed-in account: from the waitlist, through installing
// the GitHub App on a private repo, to a vault in that repo and keys for its agents.

export interface HostedSetupDeps {
  account: Account;
  settings: HostedSettings;
  registry: Registry;
  app: GitHubApp;
  kv: SessionKV;
  now?: () => Date;
  /** Something about a vault changed (created, replaced, a key revoked): drop whatever is cached for it. */
  onVaultChanged?: (vaultId: string) => void | Promise<void>;
}

/** Checking emptiness costs a few requests per repo, so only this many get checked. */
const MAX_CHECKED = 8;
const READ_ONLY = { metadata: "read", contents: "read" } as const;

const REASONS: Record<DisconnectReason, string> = {
  uninstalled: "the GitHub App was uninstalled; install it again on the repo",
  suspended: "the GitHub App is suspended; unsuspend it on GitHub",
  repo_removed: "the repo was removed from the app's installation; add it back on GitHub",
  repo_deleted: "the repo was deleted",
  public: "the repo was made public; make it private again",
  bootstrap_failed: "setting it up didn't finish; try again",
};

export function hostedSetup(deps: HostedSetupDeps): HostedSetupPort {
  const { account, settings, registry, app, kv } = deps;
  const now = deps.now ?? (() => new Date());
  const publicUrl = settings.publicUrl;
  const mcpUrl = `${publicUrl}/mcp`;
  const changed = async (id: string | undefined) => {
    if (id) await deps.onVaultChanged?.(id);
  };

  /** The installation's repos, through a read-only token; with `check`, whether each private one is empty. */
  async function listRepos(installationId: number, check: boolean): Promise<HostedRepo[]> {
    const { token } = await app.installationToken(installationId, { permissions: { ...READ_ONLY } });
    const repos = await app.installationRepositories(token);
    let checked = 0;
    return Promise.all(
      repos.map(async (r): Promise<HostedRepo> => {
        const base = { id: r.id, fullName: r.fullName, private: r.private };
        // Public repos are refused anyway, so they aren't worth the requests.
        if (!check || !r.private || checked++ >= MAX_CHECKED) return base;
        const info = await new GitHubStore({ repo: r.fullName, branch: r.defaultBranch, token, fetch: app.fetch, apiUrl: app.apiUrl }).info().catch(() => undefined);
        return info ? { ...base, empty: info.empty } : base;
      }),
    );
  }

  async function findRepo(installationId: number, repoId: number): Promise<InstallationRepo> {
    // Narrowed to the one repo: GitHub refuses (422) if it isn't part of the installation.
    const minted = await app.installationToken(installationId, { repositoryIds: [repoId], permissions: { metadata: "read" } }).catch(() => undefined);
    const repo = minted && (await app.installationRepositories(minted.token)).find((r) => r.id === repoId);
    if (!repo) throw new HttpError(404, "That repo isn't one the app was installed on. Add it to the installation on GitHub, or pick another.", "NOT_FOUND");
    return repo;
  }

  async function status(): Promise<HostedSetupStatus> {
    const vault = await registry.vaultOf(account.id);
    const pending = account.status === "approved" && vault?.status !== "ready" ? await pendingInstallation(kv, account.id) : undefined;
    const [installation, keys, curatorActions] = await Promise.all([
      pending
        ? listRepos(pending.installationId, false).then(
            (repos) => ({ id: pending.installationId, repos }),
            (err: unknown) => ({ id: pending.installationId, repos: [], error: (err as Error).message }),
          )
        : undefined,
      vault ? registry.keys(vault.id) : undefined,
      // Read from the repo itself, so a workflow removed on GitHub reads as off.
      vault?.status === "ready" && account.status === "approved" ? curatorActionsEnabled(app, vault).catch(() => undefined) : undefined,
    ]);
    const s: HostedSetupStatus = {
      kind: "hosted",
      account: { login: account.login, status: account.status === "deleted" ? "denied" : account.status, requested: account.note !== undefined, admin: settings.admins.has(account.id) },
      installUrl: installUrl(settings),
      newRepoUrl: newRepoUrl(settings),
      ...(installation ? { installation } : {}),
      ...(vault ? { vault: vaultInfo(vault) } : {}),
      ...(keys ? { keys: keys.map(keyInfo) } : {}),
      ...(curatorActions === undefined ? {} : { curatorActions }),
      publicUrl,
      mcpUrl,
      items: [],
    };
    s.items = items(s);
    return s;
  }

  async function init(body: unknown): Promise<HostedInitResult> {
    const req = initRequest(body);
    const existing = await registry.vaultOf(account.id);
    if (existing?.status === "ready") throw new HttpError(409, `You already have a vault: ${existing.fullName}.`, "HAS_VAULT");
    // A retry on the same repo can go on with the vault's own installation once the pending one has expired.
    const installationId = (await pendingInstallation(kv, account.id))?.installationId ?? (existing?.repoId === req.repoId ? existing.installationId : undefined);
    if (installationId === undefined) throw new HttpError(409, "Install the GitHub App on your vault repo first.", "NO_INSTALLATION");
    const repo = await findRepo(installationId, req.repoId);
    const result = await bootstrapVault({
      app,
      registry,
      accountId: account.id,
      installationId,
      repo: { id: repo.id, fullName: repo.fullName, branch: repo.defaultBranch },
      settings: { campaign: req.campaign, human: req.human, timezone: req.timezone, domains: req.domains, recipient: req.recipient },
      seed: req.seed,
      now: now(),
    });
    await clearPendingInstallation(kv, account.id);
    await changed(result.replaced);
    await changed(result.vault.id);
    return { vault: vaultInfo(result.vault), mode: result.mode };
  }

  async function ownVault(): Promise<VaultRecord> {
    const vault = await registry.vaultOf(account.id);
    if (!vault) throw new HttpError(409, "No vault yet: set one up first.", "NO_VAULT");
    return vault;
  }

  return {
    kind: "hosted",
    status,
    async handle(method, path, body) {
      if (path === "access" && method === "POST") {
        const note = (body as { note?: unknown } | undefined)?.note ?? "";
        if (typeof note !== "string" || note.length > 500) throw new HttpError(400, "note: up to 500 characters of text", "INVALID");
        await registry.requestAccess(account.id, note.trim());
        return { ok: true };
      }
      if (account.status !== "approved") throw new HttpError(403, "Your account is waiting for an admin's approval.", "NOT_APPROVED");
      if (path === "repos" && method === "GET") {
        const pending = await pendingInstallation(kv, account.id);
        if (!pending) throw new HttpError(409, "Install the GitHub App on your vault repo first.", "NO_INSTALLATION");
        return { installation: { id: pending.installationId }, repos: await listRepos(pending.installationId, true) };
      }
      if (path === "init" && method === "POST") return init(body);
      if (path === "keys" && method === "GET") return { keys: (await registry.keys((await ownVault()).id)).map(keyInfo) };
      if (path === "keys" && method === "POST") {
        const vault = await ownVault();
        if (vault.status !== "ready") throw new HttpError(409, "Your vault isn't ready, so it can't take new keys.", "NOT_READY");
        const { token, key } = await registry.mintKey(vault.id, keyRequest(body));
        const minted: HostedMintedKey = { ...keyInfo(key), token, snippets: keySnippets(publicUrl, token, key.kind) };
        return minted;
      }
      if (path === "curator-actions" && method === "POST") {
        const enable = (body as { enable?: unknown } | undefined)?.enable;
        if (typeof enable !== "boolean") throw new HttpError(400, "enable: true or false", "INVALID");
        const vault = await ownVault();
        if (vault.status !== "ready") throw new HttpError(409, "Your vault isn't ready.", "NOT_READY");
        return setCuratorActions(app, vault, enable);
      }
      if (path === "keys/revoke" && method === "POST") {
        const id = (body as { id?: unknown } | undefined)?.id;
        if (typeof id !== "string" || !TOKEN_ID.test(id)) throw new HttpError(400, "id: expected a key id (64 hex characters)", "INVALID");
        const vault = await ownVault();
        await registry.revokeKey(vault.id, id);
        await changed(vault.id);
        return { ok: true };
      }
      throw new HttpError(404, `No such setup route: ${method} ${path}`, "NOT_FOUND");
    },
  };
}

/** The campaign settings and the repo for `init`, checked before anything touches GitHub. */
export function initRequest(body: unknown): VaultSettings & { repoId: number; seed?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const bad = (msg: string): never => {
    throw new HttpError(400, msg, "INVALID");
  };
  if (typeof b.repoId !== "number" || !Number.isSafeInteger(b.repoId) || b.repoId <= 0) bad("repoId: pick one of the installation's repos");
  const campaign = typeof b.campaign === "string" ? b.campaign.trim() : "";
  if (!campaign || campaign.length > 120) bad("campaign: a name, up to 120 characters");
  const human = typeof b.human === "string" ? b.human.trim().toLowerCase() : "";
  if (!SLUG.test(human)) bad("human: your id in the vault, lowercase letters, digits and dashes (like player)");
  if (typeof b.timezone !== "string" || !validTimezone(b.timezone)) bad("timezone: an IANA name like Europe/Lisbon");
  if (!Array.isArray(b.domains) || b.domains.length > 30) bad("domains: a list of up to 30 ids");
  const domains = [...new Set((b.domains as unknown[]).map((d) => (typeof d === "string" ? d.trim().toLowerCase() : "")))];
  for (const d of domains) if (!SLUG.test(d)) bad(`domains: "${d}" must be lowercase letters, digits and dashes`);
  if (b.seed !== undefined && (typeof b.seed !== "string" || !SEEDS[b.seed])) bad(`seed: choose from ${Object.keys(SEEDS).join(", ")}`);
  // An age X25519 recipient: `age1` and 58 bech32 characters.
  if (b.recipient !== undefined && (typeof b.recipient !== "string" || !/^age1[02-9ac-hj-np-z]{58}$/.test(b.recipient))) bad("recipient: an age public key (age1…)");
  return {
    repoId: b.repoId as number,
    campaign,
    human,
    timezone: b.timezone as string,
    domains,
    ...(b.seed === undefined ? {} : { seed: b.seed as string }),
    ...(b.recipient === undefined ? {} : { recipient: b.recipient as string }),
  };
}

const vaultInfo = (v: VaultRecord): HostedVault => ({ id: v.id, fullName: v.fullName, branch: v.branch, status: v.status, ...(v.reason ? { reason: v.reason } : {}) });

const keyInfo = (k: KeyRecord): HostedKeyInfo => ({
  id: k.id,
  kind: k.kind,
  ...(k.agent ? { agent: k.agent } : {}),
  scopes: k.scopes,
  label: k.label,
  created: k.created,
  ...(k.lastUsed ? { lastUsed: k.lastUsed } : {}),
});

function items(s: HostedSetupStatus): SetupItem[] {
  const out: SetupItem[] = [];
  const a = s.account;
  out.push(
    a.status === "approved"
      ? { id: "access", title: "Access", state: "done", detail: `@${a.login} is approved`, how: "performed" }
      : a.status === "denied"
        ? { id: "access", title: "Access", state: "error", detail: "Access wasn't granted for this account", how: "guided" }
        : { id: "access", title: "Access", state: a.requested ? "warn" : "todo", detail: a.requested ? "Requested; waiting for an admin to approve it" : "Ask for access", how: "performed" },
  );
  if (a.status !== "approved") return out;
  const v = s.vault;
  const ready = v?.status === "ready";
  out.push(
    ready || s.installation
      ? { id: "install", title: "Install the GitHub App", state: "done", detail: ready ? `Installed on ${v.fullName}` : "Installed; pick the repo next", how: "guided" }
      : { id: "install", title: "Install the GitHub App", state: "todo", detail: "Create an empty private repo, then install the app on it (only that repo)", how: "guided" },
  );
  if (!v) out.push({ id: "vault", title: "Vault", state: "todo", detail: s.installation ? "Pick the repo and name the campaign" : "Install the app first", how: "performed" });
  else if (v.status === "ready") out.push({ id: "vault", title: "Vault", state: "done", detail: `${v.fullName}@${v.branch}`, how: "performed" });
  else if (v.status === "bootstrapping") out.push({ id: "vault", title: "Vault", state: "warn", detail: `Setting up ${v.fullName}…`, how: "performed" });
  else out.push({ id: "vault", title: "Vault", state: "error", detail: `${v.fullName} is disconnected: ${REASONS[v.reason as DisconnectReason] ?? "reconnect it"}`, how: "guided" });
  if (ready) {
    const n = s.keys?.length ?? 0;
    out.push({ id: "keys", title: "Agent keys", state: n ? "done" : "todo", detail: n ? `${n} ${n === 1 ? "key" : "keys"} issued` : "Mint a key for your agents (or connect Claude.ai or ChatGPT with the connector URL)", how: "performed" });
    if (s.curatorActions !== undefined)
      out.push(
        s.curatorActions
          ? { id: "curator", title: "Nightly sleep", state: "done", detail: "GitHub Actions runs sleep every night with Claude; it needs the repo secrets and variables its workflow lists", how: "performed" }
          : { id: "curator", title: "Nightly sleep", state: "optional", detail: "Run sleep with your own curator agent, or have GitHub Actions run it nightly with Claude", how: "performed" },
      );
  }
  return out;
}

/** How to connect with a new key. Every snippet carries the key, so they're shown once, with it. */
export function keySnippets(publicUrl: string, token: string, kind: KeyKind): Snippet[] {
  const mcp = `${publicUrl}/mcp`;
  const auth = `Bearer ${token}`;
  const name = kind === "curator" ? "hippocampus-curator" : "hippocampus";
  const snippets: Snippet[] = [
    { label: "Claude Code", lang: "bash", code: `claude mcp add --transport http ${name} ${mcp} --header "Authorization: ${auth}"` },
    { label: "Any MCP client over HTTP (.mcp.json)", lang: "json", code: JSON.stringify({ mcpServers: { [name]: { type: "http", url: mcp, headers: { Authorization: auth } } } }, null, 2) },
    { label: "Cursor (~/.cursor/mcp.json)", lang: "json", code: JSON.stringify({ mcpServers: { [name]: { url: mcp, headers: { Authorization: auth } } } }, null, 2) },
    { label: "VS Code (.vscode/mcp.json)", lang: "json", code: JSON.stringify({ servers: { [name]: { type: "http", url: mcp, headers: { Authorization: auth } } } }, null, 2) },
  ];
  if (kind !== "curator")
    snippets.push({ label: "Claude.ai or ChatGPT (custom connector)", lang: "text", code: mcp, note: "Connectors sign in with GitHub instead of a key: add a custom connector with this URL." });
  return snippets;
}
