import { AGE_RECIPIENT, SLUG, presetCatalog, validTimezone, type HumanSetting, type VaultSettings } from "@hippocampus/core";
import { HttpError, byRecentPush, type HostedGitLab, type HostedInitResult, type HostedKeyInfo, type HostedMintedKey, type HostedOrg, type HostedRepo, type HostedSetupPort, type HostedSetupStatus, type HostedVault, type SetupItem } from "@hippocampus/dashboard";
import { isConnectApp, keySnippets } from "@hippocampus/dashboard/connect";
import { EmptyRepositoryError, GitHubStore } from "@hippocampus/store-github";
import { GitLabStore } from "@hippocampus/store-gitlab";
import { PRESETS, SEEDS } from "@hippocampus/template";
import { TOKEN_ID } from "../auth.ts";
import { keyCredential } from "../oauth.ts";
import { bootstrapVault, plan } from "./bootstrap.ts";
import { ACTIONS_CURATOR_APP, ACTIONS_DISPATCH, ACTIONS_WRITE_SECRETS, ActionsApi, credential, curatorActionsEnabled, curatorActionsState, setCuratorActions } from "./curator-actions.ts";
import type { GitHubApp, InstallationRepo } from "./github-app.ts";
import { GitLabAuthError, type GitLabAccess, type GitLabProject } from "./gitlab.ts";
import type { AgentClaim } from "./agent-claims.ts";
import { KIND_SCOPES, MAX_VAULTS_PER_USER, keyRequest, type DisconnectReason, type MemberVault, type Org, type Provider, type KeyRecord, type Registry, type VaultRecord } from "./registry.ts";
import { RESUME_INSTALL_PATH, clearPendingInstallation, pendingInstallation, type SessionKV } from "./session.ts";
import { GITLAB_CONNECT_PATH } from "./gitlab.ts";
import type { Caller } from "./routes.ts";
import { hostedCurationAvailable, installUrl, installationSettingsUrl, newRepoUrl, oauthUrlOf, type HostedSettings } from "./settings.ts";
import { PRICES, RECOMMENDED, STEPS, priceOf, type HostedProvider, type StepMix } from "@hippocampus/curator";
import { ACTIONS_MODELS, type HostedActionsModel, type HostedActionsRunResult, type HostedActionsSecret, type HostedActionsSecretsResult, type HostedCuratorStatus, type HostedVaultCurator } from "@hippocampus/dashboard";
import type { StartResult } from "./hosted-curator.ts";
import { HOSTED_PROVIDERS, checkKey, type LlmAccess, type LlmSettings } from "./llm-access.ts";

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
  /** The account's model key for hosted curation; set when the instance can seal it (`HIPPO_TOKEN_KEY`). */
  llm?: LlmAccess;
  /** For checking a model key against its provider. */
  fetch?: typeof fetch;
  /** Hosted curation for one vault, from its object. */
  hostedCurator?: (vault: MemberVault) => Promise<HostedVaultCurator>;
  /** The vault's nightly hour changed in the registry: its object re-arms. */
  setHostedSchedule?: (vault: MemberVault, hourUtc: number | null) => Promise<HostedVaultCurator>;
  /** The owner's Run now. */
  runHostedCurator?: (vault: MemberVault) => Promise<StartResult>;
}

/** An installation to set a vault up from; on an org's, the repos the person may use there. */
interface Picked {
  id: number;
  repoIds?: number[];
  org?: string;
}

/** An org the person tried to set a vault up in, for their setup page. */
const hostedOrg = (o: Org): HostedOrg => ({
  login: o.login,
  status: o.status,
  ...(o.status === "approved" && o.installationId ? { continueUrl: `${RESUME_INSTALL_PATH}?installation_id=${o.installationId}` } : {}),
});

/** Checking emptiness costs a few requests per repo, so only this many get checked. */
const MAX_CHECKED = 8;
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
  async function listRepos(picked: Picked, check: boolean): Promise<HostedRepo[]> {
    // On an org's install, only the repos the person administers or maintains: the token reaches no others.
    if (picked.repoIds && !picked.repoIds.length) return [];
    const { token } = await app.installationToken(picked.id, { ...(picked.repoIds ? { repositoryIds: picked.repoIds } : {}), permissions: { ...READ_ONLY } });
    const repos = (await app.installationRepositories(token)).sort(byRecentPush);
    // The person's disconnected vaults are always checked: they get no pushes, so they would sink below the cap.
    const lost = new Set(vaults.filter((v) => v.provider === "github" && v.status === "disconnected").map((v) => v.repoId));
    let checked = 0;
    return Promise.all(
      repos.map(async (r): Promise<HostedRepo> => {
        const base = { id: r.id, fullName: r.fullName, private: r.private, ...(r.pushedAt ? { pushedAt: r.pushedAt } : {}) };
        // Public repos are refused anyway, so they aren't worth the requests.
        if (!check || !r.private || (!lost.has(r.id) && checked++ >= MAX_CHECKED)) return base;
        const store = new GitHubStore({ repo: r.fullName, branch: r.defaultBranch, token, fetch: app.fetch, apiUrl: app.apiUrl });
        // The same plan `bootstrapVault` makes, so what's offered here is what setup will do with it. The listing
        // also tells an empty repo, so the repo itself needn't be fetched (the installation's list already has it).
        const paths = await store.list().catch((err: unknown) => (err instanceof EmptyRepositoryError ? [] : undefined));
        if (!paths) return base;
        const p = plan(paths);
        return p.mode === "adopt" ? { ...base, empty: false, adoptable: true } : p.mode === "initialize" ? { ...base, empty: true } : { ...base, empty: false, adoptable: false };
      }),
    );
  }

  /**
   * The installation to set a vault up from: the one GitHub just sent the person back with, or else the
   * app's install on their own account. The pending one lasts an hour and goes once a vault is made, while
   * an install made earlier (another vault, a closed tab, GitHub not redirecting) still reaches the repos.
   */
  async function installationId(): Promise<Picked | undefined> {
    return (await pendingPick()) ?? ownInstallation();
  }

  async function pendingPick(): Promise<Picked | undefined> {
    const p = await pendingInstallation(kv, account.id);
    return p && { id: p.installationId, ...(p.repoIds ? { repoIds: p.repoIds } : {}), ...(p.org ? { org: p.org } : {}) };
  }

  /** The app's install on the person's own account. GitHub failing throws: it isn't "not installed". */
  async function ownInstallation(): Promise<Picked | undefined> {
    const own = await app.accountInstallation(account.login).catch((err: unknown) => {
      throw new HttpError(502, `GitHub didn't say whether the app is installed on your account: ${(err as Error).message}`, "GITHUB");
    });
    // The same rule as adopting an install after GitHub's redirect: the person's own personal account.
    return own && own.account.type === "User" && own.account.id === account.id ? { id: own.id } : undefined;
  }

  async function findRepo(picked: Picked, repoId: number): Promise<InstallationRepo> {
    if (picked.repoIds && !picked.repoIds.includes(repoId))
      throw new HttpError(404, `That repo isn't one you're an admin or maintainer of in @${picked.org ?? "the organization"}. Pick another.`, "NOT_FOUND");
    // Narrowed to the one repo: GitHub refuses (422) if it isn't part of the installation.
    const minted = await app.installationToken(picked.id, { repositoryIds: [repoId], permissions: { metadata: "read" } }).catch(() => undefined);
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

  /**
   * The person's GitLab projects, each private one that has files (the first few, and always their
   * disconnected GitLab vaults) saying whether it already holds a vault, so picking it adopts or
   * reconnects it as it is: the plan `bootstrapVault` makes, as for GitHub's `listRepos`.
   */
  async function checkedGitLabRepos(projects: readonly GitLabProject[]): Promise<HostedRepo[]> {
    const g = needGitLab();
    const token = g.tokenFor(account.id);
    const lost = new Set(vaults.filter((v) => v.provider === "gitlab" && v.status === "disconnected").map((v) => v.repoId));
    let checked = 0;
    return Promise.all(
      projects.map(async (p): Promise<HostedRepo> => {
        const base = gitlabRepo(p);
        if (p.visibility !== "private" || p.empty || (!lost.has(p.id) && checked++ >= MAX_CHECKED)) return base;
        const store = new GitLabStore({ project: p.id, branch: p.defaultBranch, token, fetch: g.fetch, apiUrl: g.client.apiUrl });
        const paths = await store.list().catch(() => undefined);
        if (!paths) return base;
        const found = plan(paths);
        return found.mode === "adopt" ? { ...base, adoptable: true } : found.mode === "initialize" ? { ...base, empty: true } : { ...base, adoptable: false };
      }),
    );
  }

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

  /** The account a hosted run of the picked vault draws on: the vault's own (`vaults.account_id`), which its object reads too. */
  const payer = () => (vault?.role === "owner" ? vault.accountId : account.id);

  /** Hosted curation for the account, and for the picked vault when they own it. Only on an instance that can seal a key. */
  async function hostedCuratorStatus(): Promise<HostedCuratorStatus | undefined> {
    const llm = deps.llm;
    if (!llm || account.status !== "approved") return undefined;
    const [saved, spent, own] = await Promise.all([
      llm.settings(payer()),
      llm.spentThisMonth(payer()),
      vault?.role === "owner" && vault.status === "ready" && deps.hostedCurator ? deps.hostedCurator(vault).catch(() => undefined) : undefined,
    ]);
    return {
      available: hostedCurationAvailable(settings),
      ...(saved ? llmView(saved) : {}),
      spentThisMonthUsd: usd(spent),
      recommended: Object.fromEntries(Object.entries(RECOMMENDED).map(([p, r]) => [p, r!.mix])),
      models: PRICES.map((p) => ({ provider: p.provider, model: p.model, inputUsdPerMTok: p.input, outputUsdPerMTok: p.output })),
      ...(own ? { vault: own } : {}),
    };
  }

  /** `POST curator-llm`: the provider, a model per step, the caps, and the key (checked with the provider, never echoed). */
  async function saveLlm(llm: LlmAccess, body: unknown): Promise<HostedCuratorStatus> {
    const b = (body ?? {}) as Record<string, unknown>;
    const provider = b.provider as HostedProvider;
    if (!HOSTED_PROVIDERS.includes(provider)) throw new HttpError(400, "provider: anthropic or mistral", "INVALID");
    const steps = stepsOf(b, provider);
    // A model without a price can't be metered: refused before the provider is asked anything.
    const unpriced = [...new Set(STEPS.map((s) => steps[s]))].filter((m) => !priceOf(provider, m));
    if (unpriced.length) throw new HttpError(400, `${unpriced.join(", ")}: no price for ${unpriced.length === 1 ? "this model" : "these models"}, pick a listed one`, "INVALID");
    const monthCapMicros = capMicros(b.monthCapUsd, "monthCapUsd");
    const runCapMicros = capMicros(b.runCapUsd, "runCapUsd");
    if (b.key !== undefined && typeof b.key !== "string") throw new HttpError(400, "key: the provider's API key, as text", "INVALID");
    const key = typeof b.key === "string" && b.key.trim() ? b.key.trim() : undefined;
    try {
      const prior = await llm.settings(payer());
      // A new key, or the saved one for the same provider: either way the models are checked against it.
      const checkWith = key ?? (prior?.provider === provider ? await llm.keyFor(payer()).catch(() => undefined) : undefined);
      if (checkWith) {
        const checked = await checkKey(provider, checkWith, steps, { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(settings.llmUrls?.[provider] ? { baseURL: settings.llmUrls[provider] } : {}) });
        if (!checked.ok) throw new HttpError(400, KEY_REFUSED[checked.code](checked.missing ?? []), `KEY_${checked.code.toUpperCase()}`, checked.missing ? { missing: checked.missing } : {});
      }
      await llm.save(payer(), { provider, steps, ...(key ? { key } : {}), monthCapMicros, runCapMicros });
    } catch (err) {
      throw scrubbed(err, key);
    }
    return (await hostedCuratorStatus())!;
  }

  /** With `adding`, the person is setting up another vault, so the GitLab projects are listed even beside a ready one. */
  async function status(url?: URL): Promise<HostedSetupStatus> {
    const adding = url?.searchParams.has("add") ?? false;
    // Only while there's a GitHub repo to pick: a ready vault's status doesn't need the app's repos.
    const picking = account.status === "approved" && (adding || vault?.status !== "ready");
    let picked = picking ? await pendingPick() : undefined;
    let installationError: string | undefined;
    // Connected to GitLab, the person is setting up there unless they just installed the app on GitHub (the
    // pending one): an old install from a removed vault mustn't switch them over. Picking GitHub and
    // installing again brings GitHub's redirect, so the picker still opens.
    if (picking && picked === undefined && !(gitlab && (await gitlab.login(account.id))))
      picked = await ownInstallation().catch((err: unknown) => void (installationError = (err as Error).message));
    const p = picked;
    const [installation, keys, curatorActions, hostedCurator, orgs] = await Promise.all([
      p
        ? listRepos(p, false).then(
            (repos) => ({ id: p.id, repos, ...(p.org ? { org: p.org } : {}) }),
            (err: unknown) => ({ id: p.id, repos: [], ...(p.org ? { org: p.org } : {}), error: (err as Error).message }),
          )
        : undefined,
      // A viewer manages no keys; a member sees the ones they made.
      vault && vault.role !== "viewer" ? registry.keys(vault.id, vault.role === "owner" ? undefined : account.user) : undefined,
      // Read from the repo itself, so a workflow removed on GitHub reads as off.
      // GitHub Actions only: a GitLab vault has no workflow to read.
      vault?.status === "ready" && vault.role === "owner" && vault.provider === "github" && account.status === "approved" ? curatorActionsEnabled(app, vault).catch(() => undefined) : undefined,
      hostedCuratorStatus().catch(() => undefined),
      // The orgs the person tried, so one approved since (or whose pending install expired) can be picked up again.
      picking ? registry.orgsRequestedBy(account.user) : undefined,
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
      ...(installationError ? { installationError } : {}),
      ...(orgs?.length ? { orgs: orgs.map((o) => hostedOrg(o)) } : {}),
      ...(vault ? { vault: hostedVault(vault, settings) } : {}),
      vaults: vaults.map((v) => hostedVault(v, settings)),
      vaultLimit: MAX_VAULTS_PER_USER,
      ...(keys ? { keys: keys.map(keyInfo) } : {}),
      ...(curatorActions === undefined ? {} : { curatorActions }),
      ...(hostedCurator ? { hostedCurator } : {}),
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
    // What to build from: a new vault's settings, or for an existing vault only a secrets key made at setup.
    const from = (gitlabLogin?: string) => {
      if (req.adopt) return { adoptOnly: true, settings: req.recipient ? { recipient: req.recipient } : {} };
      // On GitLab the person setting the vault up is its primary human by their GitLab username too, unless the request links one.
      const humans = gitlabLogin && req.humans && !req.humans.some((h) => h.gitlab) ? [{ ...req.humans[0]!, gitlab: gitlabLogin }, ...req.humans.slice(1)] : req.humans;
      return { settings: { campaign: req.campaign, humans, timezone: req.timezone, domains: req.domains, recipient: req.recipient }, seed: req.seed, presets: req.presets };
    };
    if (req.provider === "gitlab") {
      const g = needGitLab();
      const found = await gitlabProjects();
      if (!found) throw new HttpError(409, "Connect your GitLab account first.", "NO_GITLAB_CONNECTION");
      const project = found.projects.find((p) => p.id === req.repoId);
      if (!project) throw new HttpError(404, "That isn't one of your GitLab projects with write access (Developer or better), in your personal namespace. Pick another.", "NOT_FOUND");
      const result = await bootstrapVault({
        gitlab: g,
        registry,
        accountId: account.id,
        owner: account.user,
        repo: { id: project.id, fullName: project.fullName, branch: project.defaultBranch },
        ...from(found.login),
        now: now(),
      });
      await changed(result.vault.id);
      return { vault: hostedVault(result.vault, settings), mode: result.mode, ...(result.recipientKept ? { recipientKept: true } : {}) };
    }
    // A retry on the same repo can go on with the vault's own installation once the pending one has expired.
    const existing = vaults.find((v) => v.repoId === req.repoId && v.provider === "github");
    const picked = await installationId();
    // The person's own vault on this repo reconnects through its own installation, even if a newer pick doesn't cover it.
    const found = picked && (!picked.repoIds || picked.repoIds.includes(req.repoId)) ? picked : existing ? { id: existing.installationId } : picked;
    if (found === undefined) throw new HttpError(409, "Install the GitHub App on your vault repo first.", "NO_INSTALLATION");
    const repo = await findRepo(found, req.repoId);
    const result = await bootstrapVault({
      app,
      registry,
      accountId: account.id,
      owner: account.user,
      installationId: found.id,
      repo: { id: repo.id, fullName: repo.fullName, branch: repo.defaultBranch },
      ...from(),
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

  /** The picked vault, for the GitHub Actions curator: the owner's, ready, on GitHub. */
  function actionsVault(): MemberVault {
    const v = pickedVault(["owner"], "set up its curator");
    if (v.status !== "ready") throw new HttpError(409, "This vault isn't ready.", "NOT_READY");
    if (v.provider !== "github") throw new HttpError(409, "Nightly sleep on a schedule runs on GitHub Actions; for a GitLab vault, run sleep with your own curator agent.", "GITHUB_ONLY");
    return v;
  }

  /**
   * `POST curator-actions/secrets`: the owner's Claude credential (one kind, deleting the other), a new
   * curator key for Actions (revoking the one it replaces), written through the GitHub App, and the
   * model, into the workflow file. The credential passes through once, sealed for GitHub; nothing here
   * keeps or echoes it.
   */
  async function saveActionsSecrets(body: unknown): Promise<HostedActionsSecretsResult> {
    const b = (body ?? {}) as { claudeToken?: unknown; apiKey?: unknown; model?: unknown };
    if (b.claudeToken !== undefined && b.apiKey !== undefined) throw new HttpError(400, "Send claudeToken or apiKey, not both: the workflow uses one.", "INVALID");
    if (b.model !== undefined && !ACTIONS_MODELS.includes(b.model as HostedActionsModel)) throw new HttpError(400, `model: ${ACTIONS_MODELS.join(" or ")}`, "INVALID");
    const model = b.model as HostedActionsModel | undefined;
    const kind: HostedActionsSecret | undefined = b.claudeToken !== undefined ? "CLAUDE_CODE_OAUTH_TOKEN" : b.apiKey !== undefined ? "ANTHROPIC_API_KEY" : undefined;
    const value = kind === "CLAUDE_CODE_OAUTH_TOKEN" ? credential(b.claudeToken, "claudeToken") : kind ? credential(b.apiKey, "apiKey") : undefined;
    const vault = actionsVault();
    const api = new ActionsApi(app, vault, ACTIONS_WRITE_SECRETS, installationSettingsUrl(settings, vault.installationId));
    await api.ready();
    // The keys the app made for Actions before: tagged with its app, since a curator key names no agent.
    const previous = (await registry.keys(vault.id)).filter((k) => k.kind === "curator" && k.app === ACTIONS_CURATOR_APP);
    // A model-only change keeps the key, unless there isn't one anymore (revoked under Connected apps).
    const rotate = value !== undefined || !previous.length;
    const saved: HostedActionsSecret[] = [];
    const removed: HostedActionsSecret[] = [];
    // Minted first, so a vault at its key limit fails before anything on GitHub changes.
    const minted = rotate ? await registry.mintKey(vault.id, { kind: "curator", label: "GitHub Actions", scopes: [...KIND_SCOPES.curator], app: ACTIONS_CURATOR_APP }, account.user) : undefined;
    try {
      const repoKey = await api.publicKey();
      if (kind && value !== undefined) {
        await api.putSecret(kind, value, repoKey);
        saved.push(kind);
        // Only one kind is ever set: with both, Claude Code would pick the API key over a subscription.
        const other: HostedActionsSecret = kind === "CLAUDE_CODE_OAUTH_TOKEN" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN";
        if (await api.deleteSecret(other)) removed.push(other);
      }
      if (minted) {
        await api.putSecret("HIPPO_CURATOR_KEY", minted.token, repoKey);
        saved.push("HIPPO_CURATOR_KEY");
      }
    } catch (err) {
      if (minted) await registry.revokeKey(vault.id, minted.key.id).catch(() => undefined);
      throw err;
    }
    if (minted && previous.length) {
      for (const k of previous) await registry.revokeKey(vault.id, k.id).catch(() => undefined);
      await deps.releaseCredentials?.(vault.id, previous.map((k) => keyCredential(k.id)));
      await changed(vault.id);
    }
    // The model lives in the workflow file: rewritten (one commit) only if it's on and the text changes.
    const on = model ? await curatorActionsEnabled(app, vault) : false;
    const now = on ? (await setCuratorActions(app, vault, true, { mcpUrl, model })).model : undefined;
    return { saved, removed, curatorKey: minted ? "replaced" : "kept", ...(now ? { model: now } : {}) };
  }

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
        return { gitlab: { login: found.login }, repos: await checkedGitLabRepos(found.projects) };
      }
      if (path === "gitlab/disconnect" && method === "POST") {
        const onGitLab = vaults.find((v) => v.provider === "gitlab" && v.status === "ready");
        if (onGitLab) throw new HttpError(409, `${onGitLab.fullName} is on GitLab: disconnecting would cut it off. Remove that vault first.`, "HAS_VAULT");
        await needGitLab().disconnect(account.id);
        return { ok: true };
      }
      if (path === "repos" && method === "GET") {
        const picked = await installationId();
        if (picked === undefined) throw new HttpError(409, "Install the GitHub App on your vault repo first.", "NO_INSTALLATION");
        return { installation: { id: picked.id, ...(picked.org ? { org: picked.org } : {}) }, repos: await listRepos(picked, true) };
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
        const { enable, model } = (body ?? {}) as { enable?: unknown; model?: unknown };
        if (typeof enable !== "boolean") throw new HttpError(400, "enable: true or false", "INVALID");
        if (model !== undefined && !ACTIONS_MODELS.includes(model as HostedActionsModel)) throw new HttpError(400, `model: ${ACTIONS_MODELS.join(" or ")}`, "INVALID");
        return setCuratorActions(app, actionsVault(), enable, { mcpUrl, ...(model ? { model: model as string } : {}) });
      }
      if (path === "curator-actions/state" && method === "GET") {
        const vault = actionsVault();
        return curatorActionsState(app, vault, { mcpUrl, settingsUrl: installationSettingsUrl(settings, vault.installationId) });
      }
      if (path === "curator-actions/secrets" && method === "POST") return saveActionsSecrets(body);
      if (path === "curator-actions/run" && method === "POST") {
        const vault = actionsVault();
        const api = new ActionsApi(app, vault, ACTIONS_DISPATCH, installationSettingsUrl(settings, vault.installationId));
        await api.ready();
        await api.dispatch();
        const queued: HostedActionsRunResult = { queued: true };
        return queued;
      }
      if ((path === "curator-llm" || path.startsWith("curator-llm/")) && method === "POST") {
        // The owner's key pays for the vault's curation: only the owner sets it up.
        const vault = pickedVault(["owner"], "set up hosted curation");
        const llm = deps.llm;
        if (!llm || !hostedCurationAvailable(settings)) throw new HttpError(409, "This Hippocampus doesn't run curation with your own model key.", "UNAVAILABLE");
        if (path === "curator-llm") return saveLlm(llm, body);
        if (vault.status !== "ready") throw new HttpError(409, "This vault isn't ready.", "NOT_READY");
        if (path === "curator-llm/vault") {
          const raw = (body as { hourUtc?: unknown } | undefined)?.hourUtc;
          if (raw !== null && !(typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 24)) throw new HttpError(400, "hourUtc: 0 to 23 (UTC), or null to turn it off", "INVALID");
          const hourUtc = raw as number | null;
          if (hourUtc !== null && !(await llm.settings(payer()))) throw new HttpError(409, "Save a model key first.", "NO_KEY");
          await llm.setSchedule(vault.id, hourUtc);
          const after: HostedVaultCurator = (await deps.setHostedSchedule?.(vault, hourUtc)) ?? { enabled: hourUtc !== null, ...(hourUtc === null ? {} : { hourUtc }) };
          return after;
        }
        if (path === "curator-llm/run") {
          if (!deps.runHostedCurator) throw new HttpError(409, "This Hippocampus can't run curation now.", "UNAVAILABLE");
          const started = await deps.runHostedCurator(vault);
          if ("code" in started) throw new HttpError(409, started.message, started.code);
          return { run: started.run };
        }
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

/** A checked `init` request: a new vault's settings, or (`adopt`) just the repo of a vault that exists. */
export type InitRequest =
  | (VaultSettings & { repoId: number; provider: Provider; seed?: string; presets?: string[]; adopt?: undefined })
  | { repoId: number; provider: Provider; adopt: true; recipient?: string };

/**
 * The vault's settings and the repo for `init`, checked before anything touches GitHub. Takes
 * `name` (or the older `campaign`) and `humans` (or one `human`); the signed-in `login` becomes the
 * first human's `github:` unless the request links someone already.
 */
export function initRequest(body: unknown, login?: string): InitRequest {
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
    // Reconnecting a vault that exists: its own config has the name, humans, zone and domains.
    if (b.seed !== undefined || slugs(b.presets, "presets").length) bad("adopt: an existing vault takes no seed or presets; they shape new vaults");
    return {
      repoId: b.repoId as number,
      provider: (b.provider as Provider | undefined) ?? "github",
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
    // The curator's keys aren't agents' connections: they count under curation.
    const n = (s.keys ?? []).filter((k) => k.kind !== "curator").length;
    out.push({ id: "keys", title: "Connected apps", state: n ? "done" : "todo", detail: n ? `${n} ${n === 1 ? "app" : "apps"} connected with a key` : "Add your first agent: paste the setup prompt into it (or connect Claude.ai or ChatGPT with the connector address)", how: "performed" });
    if (s.curatorActions !== undefined)
      out.push(
        s.curatorActions
          ? { id: "curator", title: "Nightly sleep", state: "done", detail: "GitHub Actions runs sleep every night with Claude, with the token or key you saved under Nightly curation", how: "performed" }
          : { id: "curator", title: "Nightly sleep", state: "optional", detail: "Run sleep with your own curator agent, or have GitHub Actions run it nightly with Claude", how: "performed" },
      );
  }
  return out;
}

// ── Hosted curation ─────────────────────────────────────────────────────────────

/** The most a cap may be, in USD: a typo of a few zeros shouldn't become a bill. */
const MAX_CAP_USD = 10_000;

const usd = (micros: number) => micros / 1e6;

/** The saved settings as the dashboard sees them: the key's hint, never the key. */
function llmView(s: LlmSettings): Pick<HostedCuratorStatus, "provider" | "steps" | "keyHint" | "monthCapUsd" | "runCapUsd" | "paused"> {
  const budget = /^budget:(\d{4}-\d{2})$/.exec(s.paused ?? "");
  const paused: HostedCuratorStatus["paused"] = budget ? { reason: "budget", until: budget[1]! } : s.paused === "auth" || s.paused === "credit" ? { reason: s.paused } : undefined;
  return { provider: s.provider, steps: s.steps, keyHint: s.keyHint, monthCapUsd: usd(s.monthCapMicros), runCapUsd: usd(s.runCapMicros), ...(paused ? { paused } : {}) };
}

/** The step mix a save asks for: one per step, one model for all, or the provider's recommended mix. */
function stepsOf(b: Record<string, unknown>, provider: HostedProvider): StepMix {
  if (b.steps !== undefined) {
    const s = (b.steps ?? {}) as Record<string, unknown>;
    for (const step of STEPS) if (typeof s[step] !== "string" || !(s[step] as string).trim()) throw new HttpError(400, `steps.${step}: a model id`, "INVALID");
    return Object.fromEntries(STEPS.map((step) => [step, (s[step] as string).trim()])) as StepMix;
  }
  if (typeof b.model === "string" && b.model.trim()) return Object.fromEntries(STEPS.map((step) => [step, (b.model as string).trim()])) as StepMix;
  const mix = RECOMMENDED[provider]?.mix;
  if (!mix) throw new HttpError(400, "steps: pick a model for each step, or one model for all (there's no recommended mix for this provider yet)", "INVALID");
  return mix;
}

function capMicros(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_CAP_USD) throw new HttpError(400, `${field}: US dollars, 0 to ${MAX_CAP_USD}`, "INVALID");
  return Math.round(v * 1e6);
}

const KEY_REFUSED: Record<"auth" | "unreachable" | "models_missing", (missing: string[]) => string> = {
  auth: () => "The provider refused that key. Check it and paste it again.",
  unreachable: () => "The provider couldn't be reached to check the key. Try again in a minute.",
  models_missing: (missing) => `This key can't use ${missing.join(", ")}. Pick other models, or a key that has them.`,
};

/** An error on its way to a response or a log, with the key taken out of it should it be quoted. */
function scrubbed(err: unknown, key: string | undefined): unknown {
  if (!key || !(err instanceof Error) || !`${err.message}${err instanceof HttpError ? JSON.stringify(err.extra) : ""}`.includes(key)) return err;
  return err instanceof HttpError ? new HttpError(err.status, err.message.split(key).join("…"), err.code) : new HttpError(500, "Saving the model key failed.", "INTERNAL");
}

/** The vault's own MCP address: a key used at another vault's address is refused, so a mixed-up config fails loudly. */
export const vaultMcpUrl = (publicUrl: string, vaultId: string) => `${publicUrl}/mcp/${vaultId}`;

