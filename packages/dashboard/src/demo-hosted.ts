import { demoPresets } from "./demo-setup.ts";
import { HttpError, errorResponse, json, readJson, securityHeaders } from "./http.ts";
import { VAULT_HEADER, type AdminReferrals, type HostedIncomingInvite, type HostedInvite, type HostedInvites, type HostedMember, type HostedMembers, type HostedNewInvite, type HostedConnectedApp, type HostedCuratorActionsResult, type HostedInitResult, type HostedKeyInfo, type HostedMintedKey, type HostedRepo, type HostedSessionInfo, type HostedSetupStatus, type HostedVault, type HostedVaults, type SetupItem, type Snippet } from "./setup.ts";
import { capabilities, readOnlySource, type CuratorStatus, type DashboardSource, type SessionInfo } from "./source.ts";

// The hosted app for `astro dev` (HIPPO_DEMO_HOSTED=1): an in-memory stand-in for the Worker's
// sign-in, onboarding, admin, account and curator routes, so every onboarding step can be walked
// and screenshotted without GitHub. Once the pretend vault is set up, the demo campaign answers
// everything else. All names are fictional (seeds/example-relocation).
//
//   signed out → waitlisted → (asks; approved a few seconds later) → installed → vault ready → keys
//
// `GET <base>/api/__demo/stage?to=<stage>` jumps straight to a stage: signed-out, waitlisted,
// requested, approved, installed, ready. Add `&provider=gitlab` for the GitLab path: `installed`
// then means GitLab is connected, and `ready` is a vault on GitLab. `ready` gives two vaults (one on
// each host), so the vault switcher has something to switch; both show the same demo campaign.

export type HostedDemoStage = "signed-out" | "waitlisted" | "requested" | "approved" | "installed" | "ready";

export interface HostedDemoOptions {
  /** Where the dashboard lives, e.g. `/dashboard`. */
  base: string;
  /** The demo campaign, served once the pretend vault is ready. */
  source: DashboardSource;
  /** How long a waitlist request waits before the demo approves it (ms). */
  approveAfter?: number;
  /** How long `init` pretends to take (ms). */
  initDelay?: number;
  now?: () => Date;
}

type DemoRepo = HostedRepo & { adoptable?: boolean };
type AccountStatus = "waitlisted" | "approved" | "denied" | "deleted";
interface DemoAccount {
  id: number;
  login: string;
  status: AccountStatus;
  note?: string;
  created: string;
  updated: string;
  admin: boolean;
}

const LOGIN = "player";
const USER_ID = 1001;
const VAULT_LIMIT = 5;
/** Demo vault ids, shaped like the Worker's (ULIDs), so the dashboard takes them in `?vault=`. */
const vaultId = (n: number) => `01J9Z8D3M0V${String(n).padStart(15, "0")}`;
const STAGES: HostedDemoStage[] = ["signed-out", "waitlisted", "requested", "approved", "installed", "ready"];

const REPOS: DemoRepo[] = [
  { id: 501, fullName: `${LOGIN}/vault`, private: true, empty: true },
  { id: 502, fullName: `${LOGIN}/lisbon-arc`, private: true, empty: false, adoptable: true },
  { id: 503, fullName: `${LOGIN}/dotfiles`, private: true, empty: false, adoptable: false },
  { id: 504, fullName: `${LOGIN}/harbor-notes`, private: false },
];

const GITLAB_URL = "https://gitlab.example";
const GITLAB_REPOS: DemoRepo[] = [
  { id: 701, fullName: `${LOGIN}/lisbon-vault`, private: true, empty: true },
  { id: 702, fullName: `${LOGIN}/dotfiles`, private: true, empty: false, adoptable: false },
  { id: 703, fullName: `${LOGIN}/harbor-notes`, private: false },
];

/** A handler for the hosted routes; undefined means "not mine" (the regular demo API answers). */
export function hostedDemo(opts: HostedDemoOptions): (request: Request) => Promise<Response | undefined> {
  const { base, source } = opts;
  const api = `${base}/api`;
  const now = opts.now ?? (() => new Date());
  const ago = (ms: number) => new Date(now().getTime() - ms).toISOString();
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const origin = (request: Request) => new URL(request.url).origin;

  const fresh = () => ({
    signedIn: false,
    status: "waitlisted" as AccountStatus,
    note: undefined as string | undefined,
    admin: false,
    installation: undefined as { id: number } | undefined,
    /** GitLab connected (the demo's stand-in for the consent page). */
    gitlab: false,
    vaults: [] as HostedVault[],
    /** The vault used last, opened when a request doesn't name one. */
    last: undefined as string | undefined,
    keys: {} as Record<string, HostedKeyInfo[]>,
    curatorActions: {} as Record<string, boolean>,
    made: 0,
    /** Who each vault is shared with (the owner included). */
    members: {} as Record<string, HostedMember[]>,
    /** Open invites, with the token each was made with. */
    invites: [] as (HostedInvite & { token: string; from: string })[],
    /** Invites waiting for player: one vault someone shares with them. */
    incoming: [] as HostedIncomingInvite[],
    /** Invites player sent to the app that were accepted. */
    accepted: 0,
    /** The demo's one inviter an admin stopped, if any. */
    referralsOff: undefined as string | undefined,
    apps: [] as HostedConnectedApp[],
    run: undefined as CuratorStatus["run"],
    history: [] as CuratorStatus["history"],
    others: [
      { id: 2001, login: "harbor-student", status: "waitlisted", note: "Starting at Harbor University in the spring; my agents keep losing track of deadlines.", created: ago(2 * DAY), updated: ago(2 * DAY), admin: false },
      { id: 2002, login: "lisbon-newcomer", status: "waitlisted", created: ago(5 * HOUR), updated: ago(5 * HOUR), admin: false },
      { id: 2003, login: "player-two", status: "approved", note: "Same move, different family.", created: ago(20 * DAY), updated: ago(19 * DAY), admin: false },
      { id: 2004, login: "campus-visitor", status: "denied", note: "Just looking around.", created: ago(12 * DAY), updated: ago(11 * DAY), admin: false },
    ] as DemoAccount[],
  });
  let state = fresh();
  let approval: ReturnType<typeof setTimeout> | undefined;

  const approve = () => {
    state.status = "approved";
    // The demo makes you its admin too, so the admin page has someone to show it to.
    state.admin = true;
  };

  /** The vault a request is about: the one it names, else the one used last, else the oldest. */
  const pick = (request: Request): HostedVault | undefined => {
    const asked = request.headers.get(VAULT_HEADER)?.trim();
    if (asked) {
      const vault = state.vaults.find((v) => v.id === asked);
      if (!vault) throw new HttpError(404, "That vault isn't one of yours, or it was removed.", "NO_VAULT");
      state.last = vault.id;
      return vault;
    }
    return state.vaults.find((v) => v.id === state.last) ?? state.vaults[0];
  };
  const ready = (request: Request) => pick(request)?.status === "ready";
  /** The repo can become a vault: not one already, and the person has room for another. */
  const claimable = (fullName: string, provider: "github" | "gitlab") => {
    if (state.vaults.some((v) => v.fullName === fullName && (v.provider ?? "github") === provider)) throw new HttpError(409, `${fullName} is already one of your vaults.`, "ALREADY_VAULT");
    if (owned().length >= VAULT_LIMIT) throw new HttpError(409, `You can have ${VAULT_LIMIT} vaults; remove one first.`, "VAULT_LIMIT");
  };
  const addVault = (vault: Omit<HostedVault, "id">): HostedVault => {
    const made: HostedVault = { role: "owner", ...vault, id: vaultId(++state.made) };
    state.vaults.push(made);
    state.keys[made.id] = [];
    state.members[made.id] = made.role === "owner" ? [{ user: "u-player", login: LOGIN, role: "owner", since: ago(HOUR) }] : [];
    return made;
  };
  const owned = () => state.vaults.filter((v) => (v.role ?? "owner") === "owner");

  /** Curator runs for a vault that has been around a while: two finished, one that ran out of time, one going now. */
  const seedCurator = () => {
    state.history = [
      { id: "run-3", curator: "archivist", model: "claude-sonnet-4-5", started: ago(DAY + 6 * 60_000), ended: ago(DAY), outcome: "done", consolidated: 9, failed: 0, skipped: 1, summaries: 4, remaining: 0, commits: 3 },
      { id: "run-2", curator: "archivist", model: "claude-sonnet-4-5", started: ago(2 * DAY + 5 * 60_000), ended: ago(2 * DAY), outcome: "done", consolidated: 6, failed: 1, skipped: 0, summaries: 3, remaining: 0, commits: 2 },
      { id: "run-1", curator: "game-master", model: "qwen3.5-9b", started: ago(3 * DAY + 20 * 60_000), ended: ago(3 * DAY), outcome: "expired", consolidated: 2, failed: 0, skipped: 0, summaries: 0, remaining: 5, commits: 1 },
    ];
    state.run = { id: "run-4", curator: "archivist", model: "claude-sonnet-4-5", started: ago(3 * 60_000), leaseUntil: new Date(now().getTime() + 2 * 60_000).toISOString(), live: true, progress: { done: 3, total: 8, unit: "episode" } };
    state.apps = [{ id: "grant-1", client: "Claude", scopes: ["read", "remember"], agent: "home-finder", vault: state.vaults[0]?.id ?? vaultId(1), created: ago(DAY / 2) }];
  };

  const toStage = (stage: HostedDemoStage, provider?: string) => {
    clearTimeout(approval);
    state = fresh();
    const at = STAGES.indexOf(stage);
    if (at >= 1) state.signedIn = true;
    if (at >= 2) state.note = "Moving to Lisbon; I'd like my agents to share one memory.";
    if (at >= 3) approve();
    const gitlab = provider === "gitlab";
    if (at >= 4) {
      if (gitlab) state.gitlab = true;
      else state.installation = { id: 9001 };
    }
    if (at >= 5) {
      state.installation = undefined;
      const github = { fullName: `${LOGIN}/vault`, branch: "main", status: "ready" as const, provider: "github" as const };
      const lab = gitlabVault(`${LOGIN}/lisbon-vault`);
      for (const v of gitlab ? [lab, github] : [github, lab]) addVault(v);
      // The first vault is shared with game-master, and someone has a vault to share with player.
      const first = state.vaults[0]!;
      state.members[first.id]!.push({ user: "u-gm", login: "game-master", role: "member", human: "game-master", since: ago(2 * DAY) });
      state.incoming = [{ id: "inv-harbor", from: "harbor-student", vault: { id: vaultId(90), fullName: "harbor-student/study-group" }, role: "viewer", human: "player", expires: new Date(now().getTime() + 5 * DAY).toISOString() }];
      state.accepted = 1;
      seedCurator();
    }
  };

  const gitlabVault = (fullName: string): Omit<HostedVault, "id"> => ({ fullName, branch: "main", status: "ready", provider: "gitlab", url: `${GITLAB_URL}/${fullName}` });

  const me = (): DemoAccount => ({ id: USER_ID, login: LOGIN, status: state.status, note: state.note, created: ago(DAY), updated: ago(HOUR), admin: state.admin });

  function items(s: HostedSetupStatus): SetupItem[] {
    const a = s.account;
    const out: SetupItem[] = [
      a.status === "approved"
        ? { id: "access", title: "Access", state: "done", detail: `@${a.login} is approved`, how: "performed" }
        : { id: "access", title: "Access", state: a.requested ? "warn" : "todo", detail: a.requested ? "Requested; waiting for an admin to approve it" : "Ask for access", how: "performed" },
    ];
    if (a.status !== "approved") return out;
    const v = s.vault;
    const onGitLab = v?.provider === "gitlab" || (!v && s.gitlab?.connected && !s.installation);
    out.push(
      onGitLab
        ? { id: "install", title: "Connect GitLab", state: "done", detail: v ? `Connected; ${v.fullName} is the vault` : `Connected as @${s.gitlab?.login}; pick the project next`, how: "guided" }
        : v?.status === "ready" || s.installation
          ? { id: "install", title: "Install the GitHub App", state: "done", detail: v ? `Installed on ${v.fullName}` : "Installed; pick the repo next", how: "guided" }
          : { id: "install", title: "Install the GitHub App", state: "todo", detail: "Create an empty private repo, then install the app on it (only that repo), or connect GitLab instead", how: "guided" },
    );
    out.push(v ? { id: "vault", title: "Vault", state: "done", detail: `${v.fullName}@${v.branch}`, how: "performed" } : { id: "vault", title: "Vault", state: "todo", detail: s.installation || s.gitlab?.connected ? "Pick the repo and name the campaign" : "Install the app first", how: "performed" });
    if (v) {
      const n = s.keys?.length ?? 0;
      out.push({ id: "keys", title: "Agent keys", state: n ? "done" : "todo", detail: n ? `${n} ${n === 1 ? "key" : "keys"} issued` : "Mint a key for your agents (or connect Claude.ai or ChatGPT with the connector URL)", how: "performed" });
    }
    return out;
  }

  function status(request: Request, url: URL): HostedSetupStatus {
    const publicUrl = origin(request);
    const vault = pick(request);
    const adding = url.searchParams.has("add");
    const s: HostedSetupStatus = {
      kind: "hosted",
      account: { login: LOGIN, status: state.status === "approved" ? "approved" : state.status === "denied" ? "denied" : "waitlisted", requested: state.note !== undefined, admin: state.admin },
      installUrl: `${api}/__demo/install`,
      newRepoUrl: `${api}/__demo/new-repo`,
      providers: ["github", "gitlab"],
      ...(state.status === "approved" && (adding || vault?.status !== "ready")
        ? {
            gitlab: {
              connected: state.gitlab,
              ...(state.gitlab ? { login: LOGIN, repos: GITLAB_REPOS.map(({ id, fullName, private: p, empty }) => ({ id, fullName, private: p, ...(empty === undefined ? {} : { empty }) })) } : {}),
              connectUrl: `${api}/__demo/gitlab-connect`,
              newRepoUrl: `${api}/__demo/new-project`,
            },
          }
        : {}),
      ...(state.installation && state.status === "approved" ? { installation: { id: state.installation.id, repos: REPOS.map(({ id, fullName, private: p }) => ({ id, fullName, private: p })) } } : {}),
      ...(vault ? { vault, keys: state.keys[vault.id] ?? [], ...(vault.provider === "gitlab" ? {} : { curatorActions: !!state.curatorActions[vault.id] }) } : {}),
      vaults: state.vaults,
      vaultLimit: VAULT_LIMIT,
      publicUrl,
      mcpUrl: vault ? `${publicUrl}/mcp/${vault.id}` : `${publicUrl}/mcp`,
      presets: demoPresets(),
      items: [],
    };
    s.items = items(s);
    return s;
  }

  async function session(request: Request): Promise<SessionInfo | HostedSessionInfo> {
    const account = { status: state.status === "approved" ? ("approved" as const) : ("waitlisted" as const), admin: state.admin };
    const v = pick(request);
    if (v?.status !== "ready") return { mode: "setup", user: { login: LOGIN }, account, capabilities: { ...capabilities(undefined, "hosted"), setup: "hosted" } };
    const info = await source.info();
    const shared = v.role === "viewer" ? readOnlySource(source) : source;
    return { ...info, mode: "worker", vault: { kind: v.provider === "gitlab" ? "gitlab" : "github", repo: v.fullName, branch: v.branch, ...(v.url ? { url: v.url } : {}) }, user: { login: LOGIN }, account, capabilities: { ...capabilities(shared, "hosted"), curator: (v.role ?? "owner") === "owner" } };
  }

  async function mint(request: Request, body: unknown): Promise<HostedMintedKey> {
    const vault = pick(request);
    if (vault?.status !== "ready") throw new HttpError(409, "This vault isn't ready, so it can't take new keys.", "NOT_READY");
    const b = (body ?? {}) as { kind?: unknown; label?: unknown; agent?: unknown; scopes?: unknown };
    const kind = b.kind;
    if (kind !== "agent" && kind !== "curator" && kind !== "bound") throw new HttpError(400, "kind: expected one of agent, curator, bound", "INVALID");
    const label = typeof b.label === "string" ? b.label.trim().slice(0, 80) : "";
    let agent: string | undefined;
    let scopes = kind === "curator" ? ["read", "curate"] : ["read", "remember", "goal"];
    if (kind === "bound") {
      agent = typeof b.agent === "string" ? b.agent.trim().toLowerCase() : "";
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(agent)) throw new HttpError(400, "agent: use lowercase letters, digits and dashes, like home-finder", "INVALID");
      const asked = Array.isArray(b.scopes) ? (b.scopes as unknown[]).map(String) : scopes;
      if (!asked.includes("read")) throw new HttpError(400, "scopes: every key needs read", "INVALID");
      scopes = scopes.filter((s) => asked.includes(s));
    }
    const token = `hippo_demo_${hex(16)}`;
    const key: HostedKeyInfo = { id: hex(32), kind, ...(agent ? { agent } : {}), scopes, label: label || (kind === "curator" ? "Curator" : kind === "bound" ? agent! : "Any agent"), created: now().toISOString() };
    (state.keys[vault.id] ??= []).push(key);
    return { ...key, token, snippets: keySnippets(origin(request), token, kind, vault) };
  }

  async function setupRoute(request: Request, method: string, sub: string, body: unknown, url: URL): Promise<unknown> {
    if ((sub === "" || sub === "status") && method === "GET") return status(request, url);
    if (sub === "access" && method === "POST") {
      const note = (body as { note?: unknown } | undefined)?.note ?? "";
      if (typeof note !== "string" || note.length > 500) throw new HttpError(400, "note: up to 500 characters of text", "INVALID");
      if (state.status === "approved") throw new HttpError(409, "Your account is already approved.", "ALREADY_APPROVED");
      state.note = note.trim();
      clearTimeout(approval);
      approval = setTimeout(approve, opts.approveAfter ?? 6000);
      return { ok: true };
    }
    if (state.status !== "approved") throw new HttpError(403, "Your account is waiting for an admin's approval.", "NOT_APPROVED");
    if (sub === "repos" && method === "GET" && url.searchParams.get("provider") === "gitlab") {
      if (!state.gitlab) throw new HttpError(409, "Connect your GitLab account first.", "NO_GITLAB_CONNECTION");
      return { gitlab: { login: LOGIN }, repos: GITLAB_REPOS };
    }
    if (sub === "gitlab/disconnect" && method === "POST") {
      const onGitLab = state.vaults.find((v) => v.provider === "gitlab");
      if (onGitLab) throw new HttpError(409, `${onGitLab.fullName} is on GitLab: disconnecting would cut it off. Remove that vault first.`, "HAS_VAULT");
      state.gitlab = false;
      return { ok: true };
    }
    if (sub === "repos" && method === "GET") {
      if (!state.installation) throw new HttpError(409, "Install the GitHub App on your vault repo first.", "NO_INSTALLATION");
      return { installation: state.installation, repos: REPOS };
    }
    if (sub === "init" && method === "POST" && (body as { provider?: unknown } | undefined)?.provider === "gitlab") {
      if (!state.gitlab) throw new HttpError(409, "Connect your GitLab account first.", "NO_GITLAB_CONNECTION");
      const b = (body ?? {}) as { repoId?: unknown; campaign?: unknown };
      const repo = GITLAB_REPOS.find((r) => r.id === b.repoId);
      if (!repo) throw new HttpError(404, "That isn't one of your GitLab projects with write access (Developer or better), in your personal namespace. Pick another.", "NOT_FOUND");
      if (typeof b.campaign !== "string" || !b.campaign.trim()) throw new HttpError(400, "campaign: a name, up to 120 characters", "INVALID");
      if (!repo.private) throw new HttpError(400, `${repo.fullName} is not private: anyone could read this memory. Make it private on GitLab (Settings → General → Visibility), then try again.`, "PUBLIC_REPO");
      if (repo.empty === false && !repo.adoptable) throw new HttpError(409, `${repo.fullName} already has files; pick an empty project (or one with only a README, LICENSE or .gitignore).`, "NOT_EMPTY");
      claimable(repo.fullName, "gitlab");
      await new Promise((r) => setTimeout(r, opts.initDelay ?? 1200));
      const vault = addVault(gitlabVault(repo.fullName));
      if (state.vaults.length === 1) seedCurator();
      const result: HostedInitResult = { vault, mode: repo.adoptable ? "adopted" : "initialized" };
      return result;
    }
    if (sub === "init" && method === "POST") {
      if (!state.installation) throw new HttpError(409, "Install the GitHub App on your vault repo first.", "NO_INSTALLATION");
      const b = (body ?? {}) as { repoId?: unknown; name?: unknown; campaign?: unknown };
      const name = b.name ?? b.campaign;
      const repo = REPOS.find((r) => r.id === b.repoId);
      if (!repo) throw new HttpError(404, "That repo isn't one the app was installed on. Add it to the installation on GitHub, or pick another.", "NOT_FOUND");
      if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "name: a name, up to 120 characters", "INVALID");
      if (!repo.private) throw new HttpError(400, `${repo.fullName} is public: anyone could read this memory. Make it private on GitHub (Settings → Danger Zone → Change visibility), then try again.`, "PUBLIC_REPO");
      if (repo.empty === false && !repo.adoptable) throw new HttpError(409, `${repo.fullName} already has files; pick an empty repo (or one with only a README, LICENSE or .gitignore).`, "NOT_EMPTY");
      claimable(repo.fullName, "github");
      await new Promise((r) => setTimeout(r, opts.initDelay ?? 1200));
      state.installation = undefined;
      const vault = addVault({ fullName: repo.fullName, branch: "main", status: "ready", provider: "github" });
      if (state.vaults.length === 1) seedCurator();
      const result: HostedInitResult = { vault, mode: repo.adoptable ? "adopted" : "initialized" };
      return result;
    }
    if (sub === "vaults/remove" && method === "POST") {
      const b = (body ?? {}) as { id?: unknown; confirm?: unknown };
      const vault = state.vaults.find((v) => v.id === b.id);
      if (!vault) throw new HttpError(404, "That vault isn't one of yours, or it was removed already.", "NOT_FOUND");
      if (typeof b.confirm !== "string" || b.confirm.trim().toLowerCase() !== vault.fullName.toLowerCase()) throw new HttpError(400, `confirm: type ${vault.fullName} to remove it`, "CONFIRM");
      state.vaults = state.vaults.filter((v) => v !== vault);
      delete state.keys[vault.id];
      state.apps = state.apps.filter((a) => a.vault !== vault.id);
      if (state.last === vault.id) state.last = undefined;
      return { ok: true };
    }
    const vault = pick(request);
    if (sub === "keys" && method === "GET") return { keys: vault ? (state.keys[vault.id] ?? []) : [] };
    if (sub === "keys" && method === "POST") return mint(request, body);
    if (sub === "keys/revoke" && method === "POST") {
      const id = (body as { id?: unknown } | undefined)?.id;
      if (vault) state.keys[vault.id] = (state.keys[vault.id] ?? []).filter((k) => k.id !== id);
      return { ok: true };
    }
    if (sub === "curator-actions" && method === "POST") {
      if (vault?.status !== "ready") throw new HttpError(409, "No vault yet: set one up first.", "NO_VAULT");
      if (vault.provider === "gitlab") throw new HttpError(409, "Nightly sleep on a schedule runs on GitHub Actions; for a GitLab vault, run sleep with your own curator agent.", "GITHUB_ONLY");
      const enabled = !!(body as { enable?: unknown } | undefined)?.enable;
      state.curatorActions[vault.id] = enabled;
      const result: HostedCuratorActionsResult = { enabled, path: ".github/workflows/sleep.yml" };
      return result;
    }
    throw new HttpError(404, `No such setup route: ${method} ${sub}`, "NOT_FOUND");
  }

  function adminRoute(method: string, sub: string, body: unknown, url: URL): unknown {
    if (!state.admin) throw new HttpError(403, "Only admins can do that.", "ADMIN");
    const everyone = (): DemoAccount[] => [...(state.note !== undefined || state.status === "approved" ? [me()] : []), ...state.others];
    if (sub === "accounts" && method === "GET") {
      const want = url.searchParams.get("status");
      return { accounts: everyone().filter((a) => (want ? a.status === want : a.status !== "deleted")) };
    }
    const decision = /^accounts\/(approve|deny)$/.exec(sub)?.[1];
    if (decision && method === "POST") {
      const id = (body as { id?: unknown } | undefined)?.id;
      if (id === USER_ID) throw new HttpError(400, "Admins can't be denied; remove them from HIPPO_ADMINS first.", "INVALID");
      const a = state.others.find((x) => x.id === id);
      if (!a) throw new HttpError(404, "No such account", "NOT_FOUND");
      a.status = decision === "approve" ? "approved" : "denied";
      a.updated = now().toISOString();
      return { account: a };
    }
    if (sub === "vaults" && method === "GET") {
      const vaults = [
        ...state.vaults.map((v) => ({ id: v.id, fullName: v.fullName, status: v.status, login: LOGIN, created: ago(HOUR) })),
        { id: "vault-2003", fullName: "player-two/harbor-notes", status: "ready", login: "player-two", created: ago(19 * DAY) },
        { id: "vault-2005", fullName: "campus-visitor/vault", status: "disconnected", reason: "uninstalled", login: "campus-visitor", created: ago(11 * DAY) },
      ];
      return { vaults };
    }
    if (sub === "referrals" && method === "GET") {
      const found: AdminReferrals = {
        people: [
          { user: "u-player", login: LOGIN, status: "approved", canInvite: true },
          { user: "u-gm", login: "game-master", status: "approved", invitedBy: "u-player", canInvite: true },
          { user: "u-two", login: "player-two", status: "approved", invitedBy: "u-player", canInvite: state.referralsOff !== "u-two" },
          { user: "u-harbor", login: "harbor-student", status: "approved", invitedBy: "u-gm", canInvite: true },
          { user: "u-newcomer", login: "lisbon-newcomer", status: "waitlisted", invitedBy: "u-two", canInvite: true },
          { user: "u-visitor", login: "campus-visitor", status: "denied", invitedBy: "u-harbor", canInvite: true },
        ],
        edges: [
          { from: "u-player", to: "u-gm", at: ago(20 * DAY), vault: `${LOGIN}/vault` },
          { from: "u-player", to: "u-two", at: ago(19 * DAY) },
          { from: "u-gm", to: "u-harbor", at: ago(12 * DAY) },
          { from: "u-two", to: "u-newcomer", at: ago(5 * HOUR) },
          { from: "u-harbor", to: "u-visitor", at: ago(11 * DAY) },
        ],
      };
      return found;
    }
    if (sub === "referrals/invites" && method === "POST") {
      const b = (body ?? {}) as { user?: unknown; allow?: unknown };
      state.referralsOff = b.allow === false && typeof b.user === "string" ? b.user : undefined;
      return { ok: true };
    }
    throw new HttpError(404, `No such admin route: ${method} ${sub}`, "NOT_FOUND");
  }

  function accountRoute(method: string, sub: string, body: unknown): unknown {
    if (sub === "" && method === "GET")
      return { id: USER_ID, login: LOGIN, status: state.status, admin: state.admin, vaults: state.vaults.map((v) => ({ id: v.id, fullName: v.fullName, status: v.status })) };
    if (sub === "delete" && method === "POST") {
      const typed = (body as { confirm?: unknown } | undefined)?.confirm;
      if (typeof typed !== "string" || typed.trim().replace(/^@/, "").toLowerCase() !== LOGIN) throw new HttpError(400, `To delete your account, type your GitHub login (${LOGIN}) as confirm.`, "CONFIRM");
      toStage("signed-out");
      return { ok: true };
    }
    if (sub === "apps" && method === "GET") return { apps: state.apps };
    if (sub === "apps/revoke" && method === "POST") {
      const id = (body as { id?: unknown } | undefined)?.id;
      state.apps = state.apps.filter((a) => a.id !== id);
      return { ok: true };
    }
    throw new HttpError(404, `No such account route: ${method} ${sub}`, "NOT_FOUND");
  }

  const DEMO_ORIGIN = (request: Request) => origin(request);
  const inviteLink = (request: Request, token: string) => `${DEMO_ORIGIN(request)}${base}/invite/#${token}`;
  const newInvite = (request: Request, fields: Omit<HostedInvite, "id" | "created" | "expires">): HostedNewInvite => {
    const token = `hinv_demo${hex(12)}`;
    const invite: HostedInvite = { id: hex(32), ...fields, created: now().toISOString(), expires: new Date(now().getTime() + 7 * DAY).toISOString() };
    state.invites.push({ ...invite, token, from: LOGIN });
    return { invite, link: inviteLink(request, token) };
  };
  const plain = ({ token: _t, from: _f, ...i }: HostedInvite & { token: string; from: string }): HostedInvite => i;

  function vaultsRoute(request: Request, method: string, sub: string, body: unknown): unknown {
    const vault = pick(request);
    if (!vault) throw new HttpError(409, "No vault yet: set one up first.", "NO_VAULT");
    const owner = (vault.role ?? "owner") === "owner";
    const members = (state.members[vault.id] ??= []);
    const b = (body ?? {}) as Record<string, unknown>;
    const ownerOnly = () => {
      if (!owner) throw new HttpError(403, "Only the vault's owner can do that.", "OWNER_ONLY");
    };
    if (sub === "members" && method === "GET") {
      const found: HostedMembers = { members, ...(owner ? { invites: state.invites.filter((i) => i.vault === vault.id).map(plain) } : {}), you: "u-player" };
      return found;
    }
    if (sub === "members/invite" && method === "POST") {
      ownerOnly();
      const human = String(b.human ?? "");
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(human)) throw new HttpError(400, "human: who they are in the vault, an id like game-master", "INVALID");
      if (members.some((m) => m.human === human)) throw new HttpError(409, `Someone is ${human} in this vault already.`, "HUMAN_TAKEN");
      const role = b.role === "viewer" ? "viewer" : "member";
      const login = typeof b.login === "string" && b.login ? b.login : undefined;
      return newInvite(request, { vault: vault.id, role, human, ...(login ? { login } : {}) });
    }
    if (sub === "members/role" && method === "POST") {
      ownerOnly();
      const m = members.find((x) => x.user === b.user && x.role !== "owner");
      if (!m) throw new HttpError(404, "No such member.", "NOT_FOUND");
      m.role = b.role === "viewer" ? "viewer" : "member";
      return { ok: true };
    }
    if (sub === "members/remove" && method === "POST") {
      ownerOnly();
      state.members[vault.id] = members.filter((x) => x.user !== b.user || x.role === "owner");
      return { ok: true };
    }
    if (sub === "invites/revoke" && method === "POST") {
      ownerOnly();
      state.invites = state.invites.filter((i) => i.id !== b.id);
      return { ok: true };
    }
    if (sub === "leave" && method === "POST") {
      if (owner) throw new HttpError(403, "Only the vault's owner can remove it; the owner removes the vault instead.", "OWNER_ONLY");
      state.vaults = state.vaults.filter((v) => v.id !== vault.id);
      if (state.last === vault.id) state.last = undefined;
      return { ok: true };
    }
    throw new HttpError(404, `No such route: ${method} vaults/${sub}`, "NOT_FOUND");
  }

  function invitesRoute(request: Request, method: string, sub: string, body: unknown): unknown {
    const b = (body ?? {}) as Record<string, unknown>;
    if (sub === "" && method === "GET") {
      const found: HostedInvites = { sent: state.invites.filter((i) => !i.vault).map(plain), accepted: state.accepted, canInvite: state.status === "approved", ...(state.admin ? {} : { limit: 10 }), incoming: state.incoming };
      return found;
    }
    if (sub === "" && method === "POST") {
      if (state.status !== "approved") throw new HttpError(403, "Your account is waiting for an admin's approval.", "NOT_APPROVED");
      const login = typeof b.login === "string" && b.login ? b.login : undefined;
      return newInvite(request, login ? { login } : {});
    }
    if (sub === "revoke" && method === "POST") {
      state.invites = state.invites.filter((i) => i.id !== b.id || i.vault);
      return { ok: true };
    }
    const byToken = typeof b.token === "string" ? state.invites.find((i) => i.token === b.token) : undefined;
    const addressed = typeof b.id === "string" ? state.incoming.find((i) => i.id === b.id) : undefined;
    if (sub === "peek" && method === "POST") {
      if (byToken) return { id: byToken.id, from: byToken.from, ...(byToken.vault ? { vault: { id: byToken.vault, fullName: state.vaults.find((v) => v.id === byToken.vault)?.fullName ?? "?" } } : {}), ...(byToken.role ? { role: byToken.role } : {}), ...(byToken.human ? { human: byToken.human } : {}), expires: byToken.expires };
      throw new HttpError(410, "This invite was used, revoked, or has expired. Ask for a new one.", "INVITE_GONE");
    }
    if (sub === "decline" && method === "POST") {
      state.incoming = state.incoming.filter((i) => i !== addressed);
      return { ok: true };
    }
    if (sub === "accept" && method === "POST") {
      // The demo is one person: their own links can't be accepted, so only the waiting invite can.
      if (byToken) throw new HttpError(400, "That's your own invite.", "OWN_INVITE");
      if (!addressed) throw new HttpError(410, "This invite was used, revoked, or has expired. Ask for a new one.", "INVITE_GONE");
      state.incoming = state.incoming.filter((i) => i !== addressed);
      if (state.status !== "approved") approve();
      if (!addressed.vault) return {};
      const vault = addVault({ fullName: addressed.vault.fullName, branch: "main", status: "ready", provider: "github", role: addressed.role ?? "member", human: addressed.human ?? LOGIN });
      state.members[vault.id] = [
        { user: "u-harbor", login: addressed.from, role: "owner", since: ago(30 * DAY) },
        { user: "u-player", login: LOGIN, role: addressed.role ?? "member", human: addressed.human ?? LOGIN, since: now().toISOString() },
      ];
      state.last = vault.id;
      return { vault };
    }
    throw new HttpError(404, `No such route: ${method} invites/${sub}`, "NOT_FOUND");
  }

  function curatorStatus(): CuratorStatus {
    return { ...(state.run ? { run: state.run } : {}), history: state.history };
  }

  async function demoRoute(sub: string, url: URL): Promise<Response> {
    if (sub === "stage") {
      const to = url.searchParams.get("to") as HostedDemoStage;
      if (!STAGES.includes(to)) throw new HttpError(400, `to: one of ${STAGES.join(", ")}`, "INVALID");
      toStage(to, url.searchParams.get("provider") ?? undefined);
      return redirect(to === "signed-out" ? `${base}/welcome/` : `${base}/setup/`);
    }
    if (sub === "install") {
      if (!state.signedIn) return redirect(`${base}/auth/login?return=${encodeURIComponent(`${base}/setup/#repo`)}`);
      if (state.status === "approved") state.installation = { id: 9001 };
      return redirect(`${base}/setup/#repo`);
    }
    if (sub === "gitlab-connect") {
      if (!state.signedIn) return redirect(`${base}/auth/login?return=${encodeURIComponent(`${base}/setup/#repo`)}`);
      if (state.status === "approved") state.gitlab = true;
      return redirect(`${base}/setup/#repo`);
    }
    if (sub === "new-project")
      return page(
        "Create a project (demo)",
        `<p>In the real app this is GitLab's new-project form: Create blank project, Visibility Private.</p><p>The demo pretends you made it. Close this tab and go on with <strong>Connect GitLab</strong>.</p><p><a href="${base}/setup/#install">Back to setup</a></p>`,
      );
    if (sub === "new-repo")
      return page(
        "Create a repository (demo)",
        `<p>In the real app this is GitHub's new-repository form, filled in: named <code>vault</code>, private.</p><p>The demo pretends you made it. Close this tab and go on with <strong>Install the app</strong>.</p><p><a href="${base}/setup/#install">Back to setup</a></p>`,
      );
    throw new HttpError(404, "No such demo route", "NOT_FOUND");
  }

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if ((path === `${base}/` || path === base) && method === "GET") return state.signedIn ? undefined : redirect(`${base}/welcome/`);
      if (path === `${base}/auth/login`) {
        if (method !== "GET") throw new HttpError(405, "Method not allowed", "METHOD");
        state.signedIn = true;
        const back = url.searchParams.get("return") ?? `${base}/setup/`;
        return redirect(back.startsWith(`${base}/`) && !back.startsWith("//") ? back : `${base}/setup/`);
      }
      if (path === `${base}/auth/logout`) {
        if (method !== "POST") throw new HttpError(405, "Method not allowed", "METHOD");
        state.signedIn = false;
        return new Response(null, { status: 204, headers: securityHeaders() });
      }
      if (!path.startsWith(`${api}/`)) return undefined;
      const rest = path.slice(api.length + 1).replace(/\/+$/, "");
      if (rest.startsWith("__demo/")) return await demoRoute(rest.slice("__demo/".length), url);
      if (!state.signedIn) throw new HttpError(401, "Sign in with GitHub to continue.", "SIGN_IN", { login: `${base}/auth/login` });
      const [section = ""] = rest.split("/");
      const sub = rest.slice(section.length).replace(/^\//, "");
      if (rest === "session") return json(200, await session(request));
      if (method !== "GET" && method !== "POST") throw new HttpError(405, "Method not allowed", "METHOD");
      const body = method === "POST" ? await readJson(request) : undefined;
      if (section === "setup") return json(200, await setupRoute(request, method, sub, body, url));
      if (section === "admin") return json(200, adminRoute(method, sub, body, url));
      if (section === "account") return json(200, accountRoute(method, sub, body));
      if (section === "invites") return json(200, invitesRoute(request, method, sub, body));
      if (section === "vaults" && sub) return json(200, vaultsRoute(request, method, sub, body));
      if (section === "vaults" && method === "GET") {
        const current = state.vaults.length ? pick(request) : undefined;
        const found: HostedVaults = { vaults: state.vaults, ...(current ? { current: current.id } : {}), limit: VAULT_LIMIT };
        return json(200, found);
      }
      if (!ready(request)) throw new HttpError(409, "No vault yet: finish setting one up first.", "NO_VAULT");
      if (method === "POST" && pick(request)?.role === "viewer") throw new HttpError(403, "You can only read this vault.", "READ_ONLY");
      if (rest === "curator" && method === "GET") return json(200, curatorStatus());
      if (rest === "actions/curator" && method === "POST") {
        const run = (body as { abort?: unknown } | undefined)?.abort;
        if (!state.run || state.run.id !== run) throw new HttpError(409, "That run isn't open anymore.", "NO_RUN");
        const r = state.run;
        state.history.unshift({ id: r.id, curator: r.curator, model: r.model, started: r.started, ended: now().toISOString(), outcome: "aborted", consolidated: r.progress.done, failed: 0, skipped: 0, summaries: 0, remaining: r.progress.total - r.progress.done, commits: 1 });
        state.run = undefined;
        return json(200, curatorStatus());
      }
      return undefined;
    } catch (err) {
      return errorResponse(err);
    }
  };
}

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...securityHeaders() } });
}

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...securityHeaders(), "content-security-policy": "default-src 'none'; frame-ancestors 'none'" } });
}

/** The same connect snippets the Worker sends with a new key (apps/worker/src/hosted/onboarding.ts). */
function keySnippets(publicUrl: string, token: string, kind: HostedKeyInfo["kind"], vault: HostedVault): Snippet[] {
  const mcp = `${publicUrl}/mcp/${vault.id}`;
  const auth = `Bearer ${token}`;
  const slug = (vault.fullName.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "vault";
  const name = `hippo-${slug}${kind === "curator" ? "-curator" : ""}`;
  const snippets: Snippet[] = [
    { label: "Claude Code", lang: "bash", code: `claude mcp add --transport http ${name} ${mcp} --header "Authorization: ${auth}"` },
    { label: "Any MCP client over HTTP (.mcp.json)", lang: "json", code: JSON.stringify({ mcpServers: { [name]: { type: "http", url: mcp, headers: { Authorization: auth } } } }, null, 2) },
    { label: "Cursor (~/.cursor/mcp.json)", lang: "json", code: JSON.stringify({ mcpServers: { [name]: { url: mcp, headers: { Authorization: auth } } } }, null, 2) },
    { label: "VS Code (.vscode/mcp.json)", lang: "json", code: JSON.stringify({ servers: { [name]: { type: "http", url: mcp, headers: { Authorization: auth } } } }, null, 2) },
  ];
  if (kind !== "curator") snippets.push({ label: "Claude.ai or ChatGPT (custom connector)", lang: "text", code: mcp, note: "Connectors sign in with GitHub instead of a key: add a custom connector with this URL." });
  return snippets;
}
