import { AGE_RECIPIENT, SLUG, presetCatalog, validTimezone, type HumanSetting, type VaultSettings } from "@hippocampus/core";
import { HttpError, type HostedGitLab, type HostedInitResult, type HostedKeyInfo, type HostedMintedKey, type HostedRepo, type HostedSetupPort, type HostedSetupStatus, type HostedVault, type SetupItem } from "@hippocampus/dashboard";
import { isConnectApp, keySnippets } from "@hippocampus/dashboard/connect";
import { GitHubStore } from "@hippocampus/store-github";
import { PRESETS, SEEDS } from "@hippocampus/template";
import { TOKEN_ID } from "../auth.ts";
import { keyCredential } from "../oauth.ts";
import { bootstrapVault, plan } from "./bootstrap.ts";
import { curatorActionsEnabled, setCuratorActions } from "./curator-actions.ts";
import type { GitHubApp, InstallationRepo } from "./github-app.ts";
import { GitLabAuthError, type GitLabAccess, type GitLabProject } from "./gitlab.ts";
import type { AgentClaim } from "./agent-claims.ts";
import { MAX_VAULTS_PER_USER, keyRequest, type DisconnectReason, type MemberVault, type Provider, type KeyRecord, type Registry, type VaultRecord } from "./registry.ts";
import { clearPendingInstallation, pendingInstallation, type SessionKV } from "./session.ts";
import { GITLAB_CONNECT_PATH } from "./gitlab.ts";
import type { Caller } from "./routes.ts";
import { installUrl, newRepoUrl, oauthUrlOf, type HostedSettings } from "./settings.ts";

// Session Zero on the hosted app, for one signed-in account: from the waitlist, through installing
// the GitHub App on a private repo, to a vault in that repo and keys for its agents. A person can
// have several vaults; keys and the rest act on the one the request picked (`caller.vault`).

export interface HostedSetupDeps {
  /** The signed-in person, their vaults, and the one this request is about. */
  caller: Caller;
  settings: HostedSettings;
  registry: Registry;
  app: GitHubApp;
  /** Set when the instance has GitLab set up. */
  gitlab?: GitLabAccess;
  kv: SessionKV;
  now?: () => Date;
  /** Something about a vault changed (created, a key revoked): drop whatever is cached for it. */
  onVaultChanged?: (vaultId: string) => void | Promise<void>;
  /** Wipe a removed vault's Durable Object. */
  destroyVault?: (vaultId: string) => Promise<void>;
  /** Revoke the account's connector grants for a removed vault. */
  revokeVaultGrants?: (accountId: number, vaultId: string) => Promise<void>;
  /** Connections to a vault were revoked: free the agent names they held. */
  releaseCredentials?: (vaultId: string, credentials: string[]) => Promise<void>;
  /** Seat a new agent in the vault's party (`seat: true` on a new key). */
  seatAgent?: (vault: MemberVault, agent: { id: string; title: string }, via: string) => Promise<void>;
  /** Which connection holds which agent name in the vault, for the Connections panel. */
  claims?: (vault: MemberVault) => Promise<AgentClaim[]>;
}

/** Checking emptiness costs a few requests per repo, so only this many get checked. */
const MAX_CHECKED = 8;

/** Most recently pushed first; repos GitHub gave no time for last, then by name. ISO times sort as text. */
const byRecentPush = (a: { pushedAt?: string; fullName: string }, b: { pushedAt?: string; fullName: string }) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "") || a.fullName.localeCompare(b.fullName);
/** GitHub's login rule: alphanumerics and single inner dashes, up to 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** A GitLab username: letters, digits, `_`, `-` and `.`, starting and ending with a letter, digit or `_`. */
const GITLAB_LOGIN = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,253}[A-Za-z0-9_])?$/;
const READ_ONLY = { metadata: "read", contents: "read" } as const;

const REASONS: Record<DisconnectReason, string> = {
  uninstalled: "the GitHub App was uninstalled; install it again on the repo",
  suspended: "the GitHub App is suspended; unsuspend it on GitHub",
  repo_removed: "the repo was removed from the app's installation; add it back on GitHub",
  repo_deleted: "the repo was deleted",
  public: "the repo was made public; make it private again",
  bootstrap_failed: "setting it up didn't finish; try again",
  token_revoked: "GitLab no longer accepts the connection; connect GitLab again",
};

export function hostedSetup(deps: HostedSetupDeps): HostedSetupPort {
  const { settings, registry, app, kv, gitlab } = deps;
  const { account, vaults } = deps.caller;
  const vault = deps.caller.vault;
  const now = deps.now ?? (() => new Date());
  const publicUrl = settings.publicUrl;
  // The picked vault's own address; the plain one (whichever vault the key opens) before there is one.
  const mcpUrl = vault ? vaultMcpUrl(publicUrl, vault.id) : `${publicUrl}/mcp`;
  const changed = async (id: string | undefined) => {
    if (id) await deps.onVaultChanged?.(id);
  };

  /**
   * The installation's repos, newest push first, through a read-only token. With `check`, each private
   * one (the first few, so the most recently pushed) says whether it's empty or already holds a vault.
   */
  async function listRepos(installationId: number, check: boolean): Promise<HostedRepo[]> {
    const { token } = await app.installationToken(installationId, { permissions: { ...READ_ONLY } });
    const repos = (await app.installationRepositories(token)).sort(byRecentPush);
    let checked = 0;
    return Promise.all(
      repos.map(async (r): Promise<HostedRepo> => {
        const base = { id: r.id, fullName: r.fullName, private: r.private, ...(r.pushedAt ? { pushedAt: r.pushedAt } : {}) };
        // Public repos are refused anyway, so they aren't worth the requests.
        if (!check || !r.private || checked++ >= MAX_CHECKED) return base;
        const store = new GitHubStore({ repo: r.fullName, branch: r.defaultBranch, token, fetch: app.fetch, apiUrl: app.apiUrl });
        const info = await store.info().catch(() => undefined);
        if (!info) return base;
        if (info.empty) return { ...base, empty: true };
        // The same call `bootstrapVault` makes, so what's offered here is what setup will do with it.
        const paths = await store.list().catch(() => undefined);
        if (!paths) return { ...base, empty: false };
        const p = plan(paths);
        return p.mode === "adopt" ? { ...base, empty: false, adoptable: true } : p.mode === "initialize" ? { ...base, empty: true } : { ...base, empty: false, adoptable: false };
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

  const needGitLab = (): GitLabAccess => {
    if (!gitlab) throw new HttpError(404, "This Hippocampus isn't set up for GitLab.", "NO_GITLAB");
    return gitlab;
  };

  /** The person's GitLab projects they could use; undefined when GitLab isn't connected. */
  async function gitlabProjects(): Promise<{ login: string; projects: GitLabProject[] } | undefined> {
    const g = needGitLab();
    if (!(await g.login(account.id))) return undefined;
    try {
      const token = await g.tokenFor(account.id)();
      const user = await g.client.user(token);
      return { login: user.username, projects: await g.client.projects(token, user) };
    } catch (err) {
      if (err instanceof GitLabAuthError) return undefined;
      throw err;
    }
  }

  const gitlabRepo = (p: GitLabProject): HostedRepo => ({ id: p.id, fullName: p.fullName, private: p.visibility === "private", ...(p.visibility === "private" ? { empty: p.empty } : {}) });

  async function gitlabStatus(): Promise<HostedGitLab> {
    const base = { connectUrl: GITLAB_CONNECT_PATH, newRepoUrl: `${settings.gitlab!.url}/projects/new` };
    const login = await gitlab!.login(account.id);
    if (!login) return { ...base, connected: false };
    try {
      const found = await gitlabProjects();
      return found ? { ...base, connected: true, login: found.login, repos: found.projects.map(gitlabRepo) } : { ...base, connected: false, login, error: "GitLab no longer accepts the connection; connect it again." };
    } catch (err) {
      return { ...base, connected: true, login, repos: [], error: (err as Error).message };
    }
  }

  /** With `adding`, the person is setting up another vault, so the GitLab projects are listed even beside a ready one. */
  async function status(url?: URL): Promise<HostedSetupStatus> {
    const adding = url?.searchParams.has("add") ?? false;
    const pending = account.status === "approved" ? await pendingInstallation(kv, account.id) : undefined;
    const [installation, keys, curatorActions] = await Promise.all([
      pending
        ? listRepos(pending.installationId, false).then(
            (repos) => ({ id: pending.installationId, repos }),
            (err: unknown) => ({ id: pending.installationId, repos: [], error: (err as Error).message }),
          )
        : undefined,
      // A viewer manages no keys; a member sees the ones they made.
      vault && vault.role !== "viewer" ? registry.keys(vault.id, vault.role === "owner" ? undefined : account.user) : undefined,
      // Read from the repo itself, so a workflow removed on GitHub reads as off.
      // GitHub Actions only: a GitLab vault has no workflow to read.
      vault?.status === "ready" && vault.role === "owner" && vault.provider === "github" && account.status === "approved" ? curatorActionsEnabled(app, vault).catch(() => undefined) : undefined,
    ]);
    const gitlabInfo = gitlab && account.status === "approved" && (adding || vault?.status !== "ready") ? await gitlabStatus() : undefined;
    const s: HostedSetupStatus = {
      kind: "hosted",
      account: { login: account.login, status: account.status === "deleted" ? "denied" : account.status, requested: account.note !== undefined, admin: settings.admins.has(account.id) },
      installUrl: installUrl(settings),
      newRepoUrl: newRepoUrl(settings),
      providers: gitlab ? ["github", "gitlab"] : ["github"],
      ...(gitlabInfo ? { gitlab: gitlabInfo } : {}),
      ...(installation ? { installation } : {}),
      ...(vault ? { vault: hostedVault(vault, settings) } : {}),
      vaults: vaults.map((v) => hostedVault(v, settings)),
      vaultLimit: MAX_VAULTS_PER_USER,
      ...(keys ? { keys: keys.map(keyInfo) } : {}),
      ...(curatorActions === undefined ? {} : { curatorActions }),
      publicUrl,
      mcpUrl,
      presets: presetCatalog(PRESETS).map(({ name, description }) => ({ name, description })),
      items: [],
    };
    s.items = items(s);
    return s;
  }

  async function init(body: unknown): Promise<HostedInitResult> {
    const req = initRequest(body, account.login);
    const settingsOf = { campaign: req.campaign, humans: req.humans, timezone: req.timezone, domains: req.domains, recipient: req.recipient };
    if (req.provider === "gitlab") {
      const g = needGitLab();
      const found = await gitlabProjects();
      if (!found) throw new HttpError(409, "Connect your GitLab account first.", "NO_GITLAB_CONNECTION");
      const project = found.projects.find((p) => p.id === req.repoId);
      if (!project) throw new HttpError(404, "That isn't one of your GitLab projects with write access (Developer or better), in your personal namespace. Pick another.", "NOT_FOUND");
      // The person setting the vault up is its primary human by their GitLab username too, unless the request links one.
      const humans = req.humans && !req.humans.some((h) => h.gitlab) ? [{ ...req.humans[0]!, gitlab: found.login }, ...req.humans.slice(1)] : req.humans;
      const result = await bootstrapVault({
        gitlab: g,
        registry,
        accountId: account.id,
        owner: account.user,
        repo: { id: project.id, fullName: project.fullName, branch: project.defaultBranch },
        settings: { ...settingsOf, humans },
        seed: req.seed,
        presets: req.presets,
        adoptOnly: req.adopt,
        now: now(),
      });
      await changed(result.vault.id);
      return { vault: hostedVault(result.vault, settings), mode: result.mode, ...(result.recipientKept ? { recipientKept: true } : {}) };
    }
    // A retry on the same repo can go on with the vault's own installation once the pending one has expired.
    const existing = vaults.find((v) => v.repoId === req.repoId && v.provider === "github");
    const installationId = (await pendingInstallation(kv, account.id))?.installationId ?? existing?.installationId;
    if (installationId === undefined) throw new HttpError(409, "Install the GitHub App on your vault repo first.", "NO_INSTALLATION");
    const repo = await findRepo(installationId, req.repoId);
    const result = await bootstrapVault({
      app,
      registry,
      accountId: account.id,
      owner: account.user,
      installationId,
      repo: { id: repo.id, fullName: repo.fullName, branch: repo.defaultBranch },
      settings: settingsOf,
      seed: req.seed,
      presets: req.presets,
      adoptOnly: req.adopt,
      now: now(),
    });
    await clearPendingInstallation(kv, account.id);
    await changed(result.vault.id);
    return { vault: hostedVault(result.vault, settings), mode: result.mode, ...(result.recipientKept ? { recipientKept: true } : {}) };
  }

  /** The vault the request picked, if the caller's role there allows `what` (viewers manage nothing). */
  function pickedVault(roles: readonly MemberVault["role"][] = ["owner"], what = "do that"): MemberVault {
    if (!vault) throw new HttpError(409, "No vault yet: set one up first.", "NO_VAULT");
    if (!roles.includes(vault.role)) throw new HttpError(403, vault.role === "viewer" ? "You can only read this vault." : `Only the vault's owner can ${what}.`, vault.role === "viewer" ? "READ_ONLY" : "OWNER_ONLY");
    return vault;
  }
  /** Members manage only the keys they made; the owner, all of them. */
  const keyOwner = (v: MemberVault) => (v.role === "owner" ? undefined : account.user);

  /** Forget one of the person's vaults: its keys, connector grants and cache. The repo stays as it is. */
  async function removeVault(body: unknown): Promise<{ ok: true }> {
    const b = (body ?? {}) as { id?: unknown; confirm?: unknown };
    const target = vaults.find((v) => v.id === b.id && v.role === "owner");
    if (!target) throw new HttpError(404, "That vault isn't one of yours, or it was removed already.", "NOT_FOUND");
    const typed = typeof b.confirm === "string" ? b.confirm.trim().toLowerCase() : "";
    if (typed !== target.fullName.toLowerCase()) throw new HttpError(400, `confirm: type ${target.fullName} to remove it`, "CONFIRM");
    await registry.revokeAllKeys(target.id);
    await deps.revokeVaultGrants?.(account.id, target.id);
    await deps.destroyVault?.(target.id);
    await registry.removeVault(target.id);
    return { ok: true };
  }

  return {
    kind: "hosted",
    status,
    async handle(method, path, body, url) {
      if (path === "access" && method === "POST") {
        const note = (body as { note?: unknown } | undefined)?.note ?? "";
        if (typeof note !== "string" || note.length > 500) throw new HttpError(400, "note: up to 500 characters of text", "INVALID");
        await registry.requestAccess(account.id, note.trim());
        return { ok: true };
      }
      if (account.status !== "approved") throw new HttpError(403, "Your account is waiting for an admin's approval.", "NOT_APPROVED");
      if (path === "repos" && method === "GET" && url?.searchParams.get("provider") === "gitlab") {
        const found = await gitlabProjects();
        if (!found) throw new HttpError(409, "Connect your GitLab account first.", "NO_GITLAB_CONNECTION");
        return { gitlab: { login: found.login }, repos: found.projects.map(gitlabRepo) };
      }
      if (path === "gitlab/disconnect" && method === "POST") {
        const onGitLab = vaults.find((v) => v.provider === "gitlab" && v.status === "ready");
        if (onGitLab) throw new HttpError(409, `${onGitLab.fullName} is on GitLab: disconnecting would cut it off. Remove that vault first.`, "HAS_VAULT");
        await needGitLab().disconnect(account.id);
        return { ok: true };
      }
      if (path === "repos" && method === "GET") {
        const pending = await pendingInstallation(kv, account.id);
        if (!pending) throw new HttpError(409, "Install the GitHub App on your vault repo first.", "NO_INSTALLATION");
        return { installation: { id: pending.installationId }, repos: await listRepos(pending.installationId, true) };
      }
      if (path === "init" && method === "POST") return init(body);
      if (path === "vaults/remove" && method === "POST") return removeVault(body);
      if (path === "keys" && method === "GET") {
        const v = pickedVault(["owner", "member"]);
        // With who each connection has spoken as: the vault's name claims, by connection (`key:<hash>`, `oauth:<grant>`).
        const agents = v.status === "ready" ? await deps.claims?.(v).catch(() => undefined) : undefined;
        return { keys: (await registry.keys(v.id, keyOwner(v))).map(keyInfo), ...(agents ? { agents } : {}) };
      }
      if (path === "keys" && method === "POST") {
        const vault = pickedVault(["owner", "member"]);
        if (vault.status !== "ready") throw new HttpError(409, "This vault isn't ready, so it can't take new keys.", "NOT_READY");
        const req = keyRequest(body);
        // The curator sees every secret: only the owner hands that out.
        if (req.kind === "curator" && vault.role !== "owner") throw new HttpError(403, "Only the vault's owner can make a curator key.", "OWNER_ONLY");
        const { token, key } = await registry.mintKey(vault.id, req, account.user);
        // "Seat it in the party": the agent is known from its first call, with no introduction to approve.
        const seat = (body as { seat?: unknown; title?: unknown } | undefined) ?? {};
        if (seat.seat === true && key.agent && deps.seatAgent) {
          const title = typeof seat.title === "string" && seat.title.trim() ? seat.title.trim().slice(0, 80) : key.agent;
          try {
            await deps.seatAgent(vault, { id: key.agent, title }, `@${account.login}`);
          } catch (err) {
            // Not seated (the id is one of the vault's humans, say): no key either.
            await registry.revokeKey(vault.id, key.id);
            throw new HttpError(400, `Couldn't add "${key.agent}" to the party: ${(err as Error).message}`, "INVALID");
          }
        }
        const app = (body as { app?: unknown } | undefined)?.app;
        const minted: HostedMintedKey = { ...keyInfo(key), token, snippets: keySnippets({ publicUrl, token, kind: key.kind, vault, ...(isConnectApp(app) ? { app } : {}) }) };
        return minted;
      }
      if (path === "curator-actions" && method === "POST") {
        const enable = (body as { enable?: unknown } | undefined)?.enable;
        if (typeof enable !== "boolean") throw new HttpError(400, "enable: true or false", "INVALID");
        const vault = pickedVault(["owner"], "set up its curator");
        if (vault.status !== "ready") throw new HttpError(409, "This vault isn't ready.", "NOT_READY");
        if (vault.provider !== "github") throw new HttpError(409, "Nightly sleep on a schedule runs on GitHub Actions; for a GitLab vault, run sleep with your own curator agent.", "GITHUB_ONLY");
        return setCuratorActions(app, vault, enable);
      }
      if (path === "keys/revoke" && method === "POST") {
        const id = (body as { id?: unknown } | undefined)?.id;
        if (typeof id !== "string" || !TOKEN_ID.test(id)) throw new HttpError(400, "id: expected a key id (64 hex characters)", "INVALID");
        const vault = pickedVault(["owner", "member"]);
        await registry.revokeKey(vault.id, id, keyOwner(vault));
        await deps.releaseCredentials?.(vault.id, [keyCredential(id)]);
        await changed(vault.id);
        return { ok: true };
      }
      throw new HttpError(404, `No such setup route: ${method} ${path}`, "NOT_FOUND");
    },
  };
}

/**
 * The vault's settings and the repo for `init`, checked before anything touches GitHub. Takes
 * `name` (or the older `campaign`) and `humans` (or one `human`); the signed-in `login` becomes the
 * first human's `github:` unless the request links someone already.
 */
export function initRequest(body: unknown, login?: string): VaultSettings & { repoId: number; provider: Provider; seed?: string; presets?: string[]; adopt?: boolean } {
  const b = (body ?? {}) as Record<string, unknown>;
  const bad = (msg: string): never => {
    throw new HttpError(400, msg, "INVALID");
  };
  if (b.provider !== undefined && b.provider !== "github" && b.provider !== "gitlab") bad("provider: github or gitlab");
  const slugs = (v: unknown, field: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 30) bad(`${field}: a list of up to 30 ids`);
    const ids = [...new Set((v as unknown[]).map((d) => (typeof d === "string" ? d.trim().toLowerCase() : "")))];
    for (const d of ids) if (!SLUG.test(d)) bad(`${field}: "${d}" must be lowercase letters, digits and dashes`);
    return ids;
  };
  if (typeof b.repoId !== "number" || !Number.isSafeInteger(b.repoId) || b.repoId <= 0) bad("repoId: pick one of the installation's repos");
  // An age X25519 recipient: `age1` and 58 bech32 characters.
  if (b.recipient !== undefined && (typeof b.recipient !== "string" || !AGE_RECIPIENT.test(b.recipient))) bad("recipient: an age public key (age1…)");
  if (b.adopt !== undefined && typeof b.adopt !== "boolean") bad("adopt: true or false");
  if (b.adopt === true) {
    // Reconnecting a vault that exists: its own config has the name, humans, zone and domains, so these are
    // placeholders that `adoptOnly` keeps from ever being written.
    if (b.seed !== undefined || (Array.isArray(b.presets) && b.presets.length)) bad("adopt: an existing vault takes no seed or presets; they shape new vaults");
    return {
      repoId: b.repoId as number,
      provider: (b.provider as Provider | undefined) ?? "github",
      campaign: "vault",
      humans: [{ id: "owner", ...(login ? { github: login } : {}) }],
      timezone: "UTC",
      domains: [],
      adopt: true,
      ...(b.recipient === undefined ? {} : { recipient: b.recipient as string }),
    };
  }
  const rawName = b.name ?? b.campaign;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || name.length > 120) bad("name: what the memory is about, up to 120 characters");

  let humans: HumanSetting[];
  if (b.humans !== undefined) {
    if (!Array.isArray(b.humans) || !b.humans.length || b.humans.length > 10) bad("humans: a list of 1 to 10 people, the primary one first");
    humans = (b.humans as unknown[]).map((h, i) => {
      const o = (typeof h === "string" ? { id: h } : (h ?? {})) as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id.trim().toLowerCase() : "";
      if (!SLUG.test(id)) bad(`humans[${i}].id: an id in the vault, lowercase letters, digits and dashes (like player)`);
      const github = o.github === undefined ? undefined : typeof o.github === "string" && GITHUB_LOGIN.test(o.github.trim()) ? o.github.trim() : bad(`humans[${i}].github: a GitHub login`);
      const gitlab = o.gitlab === undefined ? undefined : typeof o.gitlab === "string" && GITLAB_LOGIN.test(o.gitlab.trim()) ? o.gitlab.trim() : bad(`humans[${i}].gitlab: a GitLab username`);
      const domains = slugs(o.domains, `humans[${i}].domains`);
      return { id, ...(github ? { github } : {}), ...(gitlab ? { gitlab } : {}), ...(domains.length ? { domains } : {}) };
    });
  } else {
    const id = typeof b.human === "string" ? b.human.trim().toLowerCase() : "";
    if (!SLUG.test(id)) bad("human: your id in the vault, lowercase letters, digits and dashes (like player)");
    humans = [{ id }];
  }
  if (new Set(humans.map((h) => h.id)).size !== humans.length) bad("humans: each id once");
  // The person setting the vault up is its primary human, so the dashboard acts as them.
  if (login && !humans.some((h) => h.github)) humans[0] = { ...humans[0]!, github: login };

  if (typeof b.timezone !== "string" || !validTimezone(b.timezone)) bad("timezone: an IANA name like Europe/Lisbon");
  if (!Array.isArray(b.domains)) bad("domains: a list of up to 30 ids");
  const domains = slugs(b.domains, "domains");
  if (b.seed !== undefined && (typeof b.seed !== "string" || !Object.hasOwn(SEEDS, b.seed))) bad(`seed: choose from ${Object.keys(SEEDS).join(", ")}`);
  const presets = b.presets === undefined ? [] : slugs(b.presets, "presets");
  for (const p of presets) if (!Object.hasOwn(PRESETS, p)) bad(`presets: "${p}" isn't one; choose from ${Object.keys(PRESETS).sort().join(", ")}`);
  return {
    repoId: b.repoId as number,
    provider: (b.provider as Provider | undefined) ?? "github",
    campaign: name,
    humans,
    timezone: b.timezone as string,
    domains,
    ...(b.seed === undefined ? {} : { seed: b.seed as string }),
    ...(presets.length ? { presets } : {}),
    ...(b.recipient === undefined ? {} : { recipient: b.recipient as string }),
  };
}

/** A vault as one person sees it: with their role, and for a shared vault their human. */
export const hostedVault = (v: VaultRecord & { role?: MemberVault["role"]; human?: string }, s: HostedSettings): HostedVault => ({
  id: v.id,
  fullName: v.fullName,
  branch: v.branch,
  status: v.status,
  provider: v.provider,
  url: `${v.provider === "gitlab" ? s.gitlab?.url : oauthUrlOf(s)}/${v.fullName}`,
  ...(v.reason ? { reason: v.reason } : {}),
  role: v.role ?? "owner",
  ...(v.human ? { human: v.human } : {}),
});

const keyInfo = (k: KeyRecord): HostedKeyInfo => ({
  id: k.id,
  kind: k.kind,
  ...(k.agent ? { agent: k.agent } : {}),
  scopes: k.scopes,
  label: k.label,
  ...(k.app ? { app: k.app } : {}),
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
  const onGitLab = v?.provider === "gitlab" || (!v && s.gitlab?.connected && !s.installation);
  if (onGitLab)
    out.push(
      ready || s.gitlab?.connected
        ? { id: "install", title: "Connect GitLab", state: "done", detail: ready ? `Connected; ${v.fullName} is the vault` : `Connected as @${s.gitlab?.login}; pick the project next`, how: "guided" }
        : { id: "install", title: "Connect GitLab", state: "todo", detail: "Create an empty private project, then connect your GitLab account", how: "guided" },
    );
  else
    out.push(
      ready || s.installation
        ? { id: "install", title: "Install the GitHub App", state: "done", detail: ready ? `Installed on ${v.fullName}` : "Installed; pick the repo next", how: "guided" }
        : { id: "install", title: "Install the GitHub App", state: "todo", detail: s.gitlab ? "Create an empty private repo, then install the app on it (only that repo), or connect GitLab instead" : "Create an empty private repo, then install the app on it (only that repo)", how: "guided" },
    );
  if (!v) out.push({ id: "vault", title: "Vault", state: "todo", detail: s.installation || s.gitlab?.connected ? "Pick the repo and name the campaign" : "Install the app first", how: "performed" });
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

/** The vault's own MCP address: a key used at another vault's address is refused, so a mixed-up config fails loudly. */
export const vaultMcpUrl = (publicUrl: string, vaultId: string) => `${publicUrl}/mcp/${vaultId}`;

