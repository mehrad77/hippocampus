import { isConnectApp, keySnippets } from "./connect.ts";
import { demoPresets } from "./demo-setup.ts";
import { HttpError, errorResponse, json, readJson, securityHeaders } from "./http.ts";
import { ACTIONS_MODELS, VAULT_HEADER, byRecentPush, type HostedActionsModel, type HostedActionsRun, type HostedActionsRunResult, type HostedActionsSecret, type HostedActionsSecretsResult, type HostedCuratorActionsState, type AdminReferrals, type HostedDeviceRequest, type HostedIncomingInvite, type HostedInvite, type HostedInvites, type HostedMember, type HostedMembers, type HostedNewInvite, type HostedConnectedApp, type HostedCuratorActionsResult, type HostedCuratorRunResult, type HostedCuratorStatus, type HostedLlmProvider, type HostedStepMix, type HostedVaultCurator, type HostedAgentClaim, type HostedInitResult, type HostedKeyInfo, type HostedMintedKey, type HostedRepo, type HostedSessionInfo, type HostedSetupStatus, type HostedVault, type HostedVaults, type SetupItem } from "./setup.ts";
import { capabilities, readOnlySource, type CuratorStatus, type DashboardSource, type SessionInfo } from "./source.ts";

// The hosted app for `astro dev` (HIPPO_DEMO_HOSTED=1): an in-memory stand-in for the Worker's
// sign-in, onboarding, admin, account and curator routes, so every onboarding step can be walked
// and screenshotted without GitHub. Once the pretend vault is set up, the demo campaign answers
// everything else. All names are fictional (seeds/example-relocation).
//
//   signed out → waitlisted → (asks; approved a few seconds later) → installed → vault ready → keys
//
// `GET <base>/api/__demo/key` downloads the demo vault's key file, for walking Reveal and Rotate.
// `GET <base>/api/__demo/stage?to=<stage>` jumps straight to a stage: signed-out, waitlisted,
// requested, denied, fresh (approved, nothing set up), approved, installed, disconnected (your own
// vault, cut off: Reconnect it), bootstrapping (a vault being set up), ready. Add `&provider=gitlab`
// for the GitLab path: `installed` then means GitLab is connected (one of its projects is an existing
// vault), and `ready` is a vault on GitLab. `ready` gives two vaults (one on each host), so the vault
// switcher has something to switch; both show the same demo campaign. A jump clears this browser's
// setup drafts, so the wizard starts where the stage is.
//
// `GET <base>/api/__demo/device` plays an agent starting device sign-in (`?access=curate` for a
// curator): it opens the approval page with the request's code, and approving makes the connection,
// which calls in a few seconds later.
//
// Hosted curation (Setup → Nightly curation) answers with a fake spend, a made-up recommended mix
// and instant runs; a key with "refused" in it is refused. `GET <base>/api/__demo/curator` plays its
// states: `?pause=budget|auth|credit|none` pauses it (saving a pretend key first if there is none),
// and `?standby=<curator>|none` records a standby curator's check-in, or forgets it.
//
// The GitHub Actions curator keeps secret names only (what's pasted is dropped), fake past runs with one
// failure, and Run now adds a queued run. `GET <base>/api/__demo/actions?permission=missing` plays an
// installation that hasn't approved the Actions permissions yet; `?permission=granted` approves them
// (the card's "Approve it on GitHub" link goes there in the demo).

export type HostedDemoStage = "signed-out" | "waitlisted" | "requested" | "denied" | "fresh" | "approved" | "installed" | "disconnected" | "bootstrapping" | "ready";

export interface HostedDemoOptions {
  /** Where the dashboard lives, e.g. `/dashboard`. */
  base: string;
  /** The demo campaign, served once the pretend vault is ready. */
  source: DashboardSource;
  /** The demo vault's private key, offered at `__demo/key` as a key file to walk revealing and rotating secrets. Demo only. */
  demoKey?: string;
  /** How long a waitlist request waits before the demo approves it (ms). */
  approveAfter?: number;
  /** How long `init` pretends to take (ms). */
  initDelay?: number;
  /** How long after a key is made the demo pretends its app called in (ms). */
  firstCallAfter?: number;
  /** How long the `bootstrapping` stage's vault takes to be ready (ms). */
  bootstrapFor?: number;
  now?: () => Date;
}

interface DemoActions {
  secrets: HostedActionsSecret[];
  /** The model baked into the workflow, once it was turned on. */
  model?: string;
  runs: HostedActionsRun[];
}

/** `ageDays`: how long ago the repo was last pushed to, so the list's order and times stay fresh. */
type DemoRepo = HostedRepo & { ageDays?: number };
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
export const DEMO_STAGES: readonly HostedDemoStage[] = ["signed-out", "waitlisted", "requested", "denied", "fresh", "approved", "installed", "disconnected", "bootstrapping", "ready"];
/** Device sign-in's code alphabet (consonants), as the Worker's. */
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";

/** The name hosted runs carry in the run history (`HOSTED_CURATOR` in packages/curator/src/relay.ts). */
const HOSTED = "hosted";
const DEMO_STEPS = ["mentions", "match", "claims", "summary"] as const;
/** The models hosted curation can price: a copy of packages/curator/src/pricing.ts's rows, which the dashboard can't import. */
const DEMO_MODELS: HostedCuratorStatus["models"] = [
  { provider: "anthropic", model: "claude-haiku-5-5", inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
  { provider: "anthropic", model: "claude-sonnet-5-5", inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  { provider: "anthropic", model: "claude-opus-5-5", inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
  { provider: "mistral", model: "ministral-14b-2512", inputUsdPerMTok: 0.2, outputUsdPerMTok: 0.2 },
  { provider: "mistral", model: "mistral-small-2603", inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
  { provider: "mistral", model: "mistral-large-4", inputUsdPerMTok: 0.7, outputUsdPerMTok: 2.1 },
];
/**
 * A made-up recommended mix, so the demo can show one. Not the eval's: the real list is empty until the
 * curator eval has run. Mistral has none here, so "no recommended mix yet" can be walked too.
 */
const DEMO_RECOMMENDED: HostedCuratorStatus["recommended"] = {
  anthropic: { mentions: "claude-haiku-5-5", match: "claude-haiku-5-5", claims: "claude-sonnet-5-5", summary: "claude-haiku-5-5" },
};
/** What a stage jump clears in the browser: setup drafts, the add-a-vault flag, and the tab's vault (ids repeat per stage). */
const STAGE_CLEARS = `for(const k of Object.keys(sessionStorage))if(k.startsWith("hippo:hosted-draft:")||k==="hippo:adding-vault"||k==="hippo:vault")sessionStorage.removeItem(k);`;

const REPOS: DemoRepo[] = [
  { id: 501, fullName: `${LOGIN}/vault`, private: true, empty: true, ageDays: 30 },
  { id: 502, fullName: `${LOGIN}/lisbon-arc`, private: true, empty: false, adoptable: true, ageDays: 1 },
  { id: 503, fullName: `${LOGIN}/dotfiles`, private: true, empty: false, adoptable: false, ageDays: 9 },
  { id: 504, fullName: `${LOGIN}/harbor-notes`, private: false, ageDays: 90 },
];

const GITLAB_URL = "https://gitlab.example";
const GITLAB_REPOS: DemoRepo[] = [
  { id: 701, fullName: `${LOGIN}/lisbon-vault`, private: true, empty: true },
  { id: 704, fullName: `${LOGIN}/old-vault`, private: true, empty: false, adoptable: true },
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
    /** Which agent names each key's connection has spoken as, once it has called in. */
    claims: {} as Record<string, HostedAgentClaim[]>,
    curatorActions: {} as Record<string, boolean>,
    /** The Actions curator's repo settings, per vault: secret names only (values are dropped), the workflow's model, runs. */
    actions: {} as Record<string, DemoActions>,
    /** `__demo/actions?permission=missing`: the installation hasn't approved Secrets and Actions. */
    actionsPermission: true,
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
    /** Device sign-in requests an agent started (`__demo/device`). */
    devices: [] as { code: string; client: string; access: "remember" | "curate"; expires: string; status: "pending" | "approved" | "denied" }[],
    run: undefined as CuratorStatus["run"],
    history: [] as CuratorStatus["history"],
    /** Hosted curation's settings for the account: only the key's hint is kept, never the key. */
    llm: undefined as (Omit<HostedCuratorStatus, "available" | "spentThisMonthUsd" | "recommended" | "models" | "vault"> & { provider: HostedLlmProvider; steps: HostedStepMix }) | undefined,
    /** This month's pretend spend, in micro-dollars. */
    spent: 0,
    /** Each vault's nightly hour (UTC), when hosted curation is on for it. */
    hours: {} as Record<string, number>,
    /** Each vault's last standby check-in. */
    standby: {} as Record<string, NonNullable<HostedVaultCurator["standby"]>>,
    others: [
      { id: 2001, login: "harbor-student", status: "waitlisted", note: "Starting at Harbor University in the spring; my agents keep losing track of deadlines.", created: ago(2 * DAY), updated: ago(2 * DAY), admin: false },
      { id: 2002, login: "lisbon-newcomer", status: "waitlisted", created: ago(5 * HOUR), updated: ago(5 * HOUR), admin: false },
      { id: 2003, login: "player-two", status: "approved", note: "Same move, different family.", created: ago(20 * DAY), updated: ago(19 * DAY), admin: false },
      { id: 2004, login: "campus-visitor", status: "denied", note: "Just looking around.", created: ago(12 * DAY), updated: ago(11 * DAY), admin: false },
    ] as DemoAccount[],
  });
  let state = fresh();
  let approval: ReturnType<typeof setTimeout> | undefined;
  let bootstrap: ReturnType<typeof setTimeout> | undefined;

  const approve = () => {
    state.status = "approved";
    // The demo makes you its admin too, so the admin page has someone to show it to.
    state.admin = true;
  };

  /** A vault's Actions settings: nothing set yet, and three past nightly runs, the middle one failed. */
  const actionsOf = (id: string): DemoActions =>
    (state.actions[id] ??= {
      secrets: [],
      runs: [1, 2, 3].map((d, i) => ({
        id: 7000 - i,
        status: "completed",
        conclusion: i === 1 ? "failure" : "success",
        created: ago(d * DAY - 3 * HOUR),
        url: `https://github.com/${LOGIN}/vault/actions/runs/${7000 - i}`,
        event: "schedule",
      })),
    });

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
  /** The person's disconnected vault in this repo, if they have one: setting it up again reconnects it. */
  const disconnectedAt = (fullName: string, provider: "github" | "gitlab") => state.vaults.find((v) => v.fullName === fullName && (v.provider ?? "github") === provider && v.status === "disconnected");
  /** Bring a disconnected vault back, as it is. */
  const reconnect = (fullName: string, provider: "github" | "gitlab"): HostedVault | undefined => {
    const v = disconnectedAt(fullName, provider);
    if (!v) return undefined;
    v.status = "ready";
    delete v.reason;
    return v;
  };
  /** The repo can become a vault: not one already, and the person has room for another. */
  const claimable = (fullName: string, provider: "github" | "gitlab") => {
    if (disconnectedAt(fullName, provider)) return;
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

  /**
   * Curator runs for a vault that has been around a while: two finished, one that ran out of time, one going now.
   * With `apps`, a Claude.ai connection that may curate too; a vault just set up has no agent yet, so its first can be walked.
   */
  const seedCurator = (apps = true) => {
    state.history = [
      { id: "run-3", curator: "archivist", model: "claude-sonnet-4-5", started: ago(DAY + 6 * 60_000), ended: ago(DAY), outcome: "done", consolidated: 9, failed: 0, skipped: 1, summaries: 4, remaining: 0, commits: 3 },
      { id: "run-2", curator: "archivist", model: "claude-sonnet-4-5", started: ago(2 * DAY + 5 * 60_000), ended: ago(2 * DAY), outcome: "done", consolidated: 6, failed: 1, skipped: 0, summaries: 3, remaining: 0, commits: 2 },
      { id: "run-1", curator: "game-master", model: "qwen3.5-9b", started: ago(3 * DAY + 20 * 60_000), ended: ago(3 * DAY), outcome: "expired", consolidated: 2, failed: 0, skipped: 0, summaries: 0, remaining: 5, commits: 1 },
    ];
    state.run = { id: "run-4", curator: "archivist", model: "claude-sonnet-4-5", started: ago(3 * 60_000), leaseUntil: new Date(now().getTime() + 2 * 60_000).toISOString(), live: true, progress: { done: 3, total: 8, unit: "episode" } };
    if (apps) state.apps = [{ id: "grant-1", client: "Claude", scopes: ["read", "remember", "goal", "curate"], agent: "home-finder", vault: state.vaults[0]?.id ?? vaultId(1), created: ago(DAY / 2), curate: true, mayCurate: true }];
    // archivist stands by too: it checked in last night and ran, since nothing else curated.
    const first = state.vaults[0];
    if (apps && first) state.standby[first.id] = { curator: "archivist", at: ago(DAY), decision: "needed" };
  };

  // ── Hosted curation with the owner's key ──

  const mixOf = (b: Record<string, unknown>, provider: HostedLlmProvider): HostedStepMix => {
    if (b.steps !== undefined) {
      const s = (b.steps ?? {}) as Record<string, unknown>;
      for (const step of DEMO_STEPS) if (typeof s[step] !== "string" || !(s[step] as string).trim()) throw new HttpError(400, `steps.${step}: a model id`, "INVALID");
      return Object.fromEntries(DEMO_STEPS.map((step) => [step, (s[step] as string).trim()])) as HostedStepMix;
    }
    if (typeof b.model === "string" && b.model.trim()) return Object.fromEntries(DEMO_STEPS.map((step) => [step, (b.model as string).trim()])) as HostedStepMix;
    const mix = DEMO_RECOMMENDED[provider];
    if (!mix) throw new HttpError(400, "steps: pick a model for each step, or one model for all (there's no recommended mix for this provider yet)", "INVALID");
    return mix;
  };
  const capOf = (v: unknown, field: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10_000) throw new HttpError(400, `${field}: US dollars, 0 to 10000`, "INVALID");
    return v;
  };
  const month = () => now().toISOString().slice(0, 7);
  /** When the hour next comes round, UTC. */
  const nextAt = (hourUtc: number) => {
    const t = now();
    const at = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), hourUtc);
    return new Date(at > t.getTime() ? at : at + DAY).toISOString();
  };
  const vaultCurator = (v: HostedVault): HostedVaultCurator => {
    const hour = state.hours[v.id];
    const last = state.history.find((h) => h.curator === HOSTED);
    return {
      enabled: hour !== undefined,
      ...(hour !== undefined ? { hourUtc: hour, nextRun: nextAt(hour) } : {}),
      ...(last ? { lastRun: { id: last.id, ended: last.ended, outcome: last.outcome, ...(last.stop ? { stop: last.stop } : {}), consolidated: last.consolidated, ...(last.cost ? { costUsd: last.cost.micros / 1e6 } : {}) } } : {}),
      ...(state.standby[v.id] ? { standby: state.standby[v.id] } : {}),
    };
  };
  const hostedCurator = (vault: HostedVault | undefined): HostedCuratorStatus => ({
    available: true,
    ...(state.llm ?? {}),
    spentThisMonthUsd: state.spent / 1e6,
    recommended: DEMO_RECOMMENDED,
    models: DEMO_MODELS,
    ...(vault?.role === "owner" && vault.status === "ready" ? { vault: vaultCurator(vault) } : {}),
  });
  const pauseFor = (reason: "auth" | "credit" | "budget") => {
    if (state.llm) state.llm.paused = reason === "budget" ? { reason, until: month() } : { reason };
  };

  /** A hosted run, done at once: it spends a little, and stops at the month's cap, which pauses the account. */
  const hostedRun = (llm: NonNullable<typeof state.llm>): string => {
    const id = `run-h${state.history.length + 1}`;
    const left = Math.max(0, (llm.monthCapUsd ?? 0) * 1e6 - state.spent);
    const want = Math.min(370_000, (llm.runCapUsd ?? 0) * 1e6);
    const micros = Math.min(want, left);
    const stopped = micros < want ? "budget" : undefined;
    state.spent += micros;
    const consolidated = stopped ? Math.floor((7 * micros) / Math.max(1, want)) : 7;
    state.history.unshift({
      id,
      curator: HOSTED,
      model: `${llm.provider}:${llm.steps.mentions}`,
      started: ago(90_000),
      ended: now().toISOString(),
      outcome: stopped ? "aborted" : "done",
      consolidated,
      failed: 0,
      skipped: 0,
      summaries: stopped ? 0 : 3,
      remaining: 7 - consolidated,
      commits: consolidated ? 2 : 0,
      ...(stopped ? { stop: stopped } : {}),
      cost: { micros, calls: consolidated * 4 },
    });
    if (stopped) pauseFor("budget");
    return id;
  };

  const toStage = (stage: HostedDemoStage, provider?: string) => {
    clearTimeout(approval);
    clearTimeout(bootstrap);
    state = fresh();
    const gitlab = provider === "gitlab";
    if (stage === "signed-out") return;
    state.signedIn = true;
    if (stage === "waitlisted") return;
    state.note = "Moving to Lisbon; I'd like my agents to share one memory.";
    if (stage === "requested") return;
    if (stage === "denied") {
      state.status = "denied";
      return;
    }
    approve();
    if (stage === "fresh" || stage === "approved") return;
    if (gitlab) state.gitlab = true;
    else state.installation = { id: 9001 };
    if (stage === "installed") return;
    if (stage === "disconnected") {
      // Their own vault, cut off (the app uninstalled, or GitLab's connection revoked) and connected again: picking it reconnects it as it is.
      addVault(gitlab ? { ...gitlabVault(`${LOGIN}/old-vault`), status: "disconnected", reason: "token_revoked" } : { fullName: `${LOGIN}/lisbon-arc`, branch: "main", status: "disconnected", reason: "uninstalled", provider: "github" });
      return;
    }
    if (stage === "bootstrapping") {
      const v = addVault(gitlab ? { ...gitlabVault(`${LOGIN}/lisbon-vault`), status: "bootstrapping" } : { fullName: `${LOGIN}/vault`, branch: "main", status: "bootstrapping", provider: "github" });
      bootstrap = setTimeout(() => {
        v.status = "ready";
        state.installation = undefined;
      }, opts.bootstrapFor ?? 8000);
      return;
    }
    {
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
      const n = (s.keys ?? []).filter((k) => k.kind !== "curator").length;
      out.push({ id: "keys", title: "Connected apps", state: n ? "done" : "todo", detail: n ? `${n} ${n === 1 ? "app" : "apps"} connected with a key` : "Add your first agent: paste the setup prompt into it (or connect Claude.ai or ChatGPT with the connector address)", how: "performed" });
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
      ...(state.status === "approved" ? { hostedCurator: hostedCurator(adding ? undefined : vault) } : {}),
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
    const { setSecretsRecipient: _key, secretFiles: _files, rotateSecrets: _rotate, ...member } = source;
    // Only the owner sets the secrets key: it decides who can read the vault's secrets.
    const shared = v.role === "viewer" ? readOnlySource(source) : (v.role ?? "owner") === "owner" ? source : member;
    return { ...info, mode: "worker", vault: { kind: v.provider === "gitlab" ? "gitlab" : "github", repo: v.fullName, branch: v.branch, ...(v.url ? { url: v.url } : {}) }, user: { login: LOGIN }, account, capabilities: { ...capabilities(shared, "hosted"), curator: (v.role ?? "owner") === "owner" } };
  }

  /** The app calls in a few seconds later, so "Waiting for its first call" turns into "Connected"; a shared key's agents name themselves. */
  const callsIn = (vault: HostedVault, key: HostedKeyInfo, agent?: string) =>
    setTimeout(() => {
      key.lastUsed = now().toISOString();
      if (agent) (state.claims[vault.id] ??= []).push({ agent, credential: `key:${key.id}`, since: key.lastUsed });
    }, opts.firstCallAfter ?? 6000);

  /** Device sign-in's approval page: what the agent asked for, and the person's answer. On approval the agent picks up its key (the Worker mints it then). */
  function connectRoute(request: Request, method: string, sub: string, body: unknown, url: URL): unknown {
    const code = String((method === "GET" ? url.searchParams.get("code") : (body as { code?: unknown } | undefined)?.code) ?? "")
      .trim()
      .toUpperCase();
    const r = state.devices.find((d) => d.code === code || d.code.replace("-", "") === code);
    if (!r || r.status !== "pending") throw new HttpError(410, "This code was used, or it expired. Ask the app to start again.", "CODE_GONE");
    const vaults = state.vaults.filter((v) => v.status === "ready" && v.role !== "viewer");
    if (sub === "" && method === "GET") {
      const current = pick(request);
      const found: HostedDeviceRequest = { code: r.code, client: r.client, access: r.access, expires: r.expires, vaults, ...(current && vaults.includes(current) ? { current: current.id } : {}) };
      return found;
    }
    if (sub === "deny" && method === "POST") {
      r.status = "denied";
      return { ok: true };
    }
    if (sub !== "approve" || method !== "POST") throw new HttpError(404, `No such route: ${method} connect/${sub}`, "NOT_FOUND");
    const vault = vaults.find((v) => v.id === (body as { vault?: unknown } | undefined)?.vault);
    if (!vault) throw new HttpError(400, "vault: one of your vaults that's ready", "INVALID");
    if (r.access === "curate" && (vault.role ?? "owner") !== "owner") throw new HttpError(403, "Only the vault's owner can approve a curator.", "OWNER_ONLY");
    r.status = "approved";
    const curator = r.access === "curate";
    // As the Worker mints it when the agent collects it: one shared key for the app, or a curator key.
    const key: HostedKeyInfo = { id: hex(32), kind: curator ? "curator" : "agent", scopes: curator ? ["read", "curate"] : ["read", "remember", "goal"], label: r.client, created: now().toISOString() };
    (state.keys[vault.id] ??= []).push(key);
    callsIn(vault, key, curator ? undefined : "claude-code-home-finder");
    return { ok: true };
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
    const app = (body as { app?: unknown } | undefined)?.app;
    const key: HostedKeyInfo = { id: hex(32), kind, ...(agent ? { agent } : {}), scopes, label: label || (kind === "curator" ? "Curator" : kind === "bound" ? agent! : "Any agent"), ...(isConnectApp(app) ? { app } : {}), created: now().toISOString() };
    (state.keys[vault.id] ??= []).push(key);
    callsIn(vault, key, kind === "agent" && isConnectApp(app) ? `${app}-home-finder` : undefined);
    return { ...key, token, snippets: keySnippets({ publicUrl: origin(request), token, kind, vault, ...(isConnectApp(app) ? { app } : {}) }) };
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
      // Newest push first, as the real list is.
      const repos = REPOS.map(({ ageDays, ...r }): HostedRepo => ({ ...r, ...(ageDays === undefined ? {} : { pushedAt: ago(ageDays * DAY) }) }));
      return { installation: state.installation, repos: repos.sort(byRecentPush) };
    }
    if (sub === "init" && method === "POST" && (body as { provider?: unknown } | undefined)?.provider === "gitlab") {
      if (!state.gitlab) throw new HttpError(409, "Connect your GitLab account first.", "NO_GITLAB_CONNECTION");
      const b = (body ?? {}) as { repoId?: unknown; campaign?: unknown; adopt?: unknown };
      const repo = GITLAB_REPOS.find((r) => r.id === b.repoId);
      if (!repo) throw new HttpError(404, "That isn't one of your GitLab projects with write access (Developer or better), in your personal namespace. Pick another.", "NOT_FOUND");
      if (b.adopt !== true && (typeof b.campaign !== "string" || !b.campaign.trim())) throw new HttpError(400, "campaign: a name, up to 120 characters", "INVALID");
      if (!repo.private) throw new HttpError(400, `${repo.fullName} is not private: anyone could read this memory. Make it private on GitLab (Settings → General → Visibility), then try again.`, "PUBLIC_REPO");
      if (repo.empty === false && !repo.adoptable) throw new HttpError(409, `${repo.fullName} already has files; pick an empty project (or one with only a README, LICENSE or .gitignore).`, "NOT_EMPTY");
      if (b.adopt === true && !repo.adoptable) throw new HttpError(409, `${repo.fullName} isn't a Hippocampus vault yet. Pick it again to set it up as a new one.`, "NOT_A_VAULT");
      claimable(repo.fullName, "gitlab");
      await new Promise((r) => setTimeout(r, opts.initDelay ?? 1200));
      const vault = reconnect(repo.fullName, "gitlab") ?? addVault(gitlabVault(repo.fullName));
      if (state.vaults.length === 1) seedCurator(false);
      const result: HostedInitResult = { vault, mode: repo.adoptable ? "adopted" : "initialized" };
      return result;
    }
    if (sub === "init" && method === "POST") {
      if (!state.installation) throw new HttpError(409, "Install the GitHub App on your vault repo first.", "NO_INSTALLATION");
      const b = (body ?? {}) as { repoId?: unknown; name?: unknown; campaign?: unknown; adopt?: unknown };
      const name = b.name ?? b.campaign;
      const repo = REPOS.find((r) => r.id === b.repoId);
      if (!repo) throw new HttpError(404, "That repo isn't one the app was installed on. Add it to the installation on GitHub, or pick another.", "NOT_FOUND");
      if (b.adopt !== true && (typeof name !== "string" || !name.trim())) throw new HttpError(400, "name: a name, up to 120 characters", "INVALID");
      if (!repo.private) throw new HttpError(400, `${repo.fullName} is public: anyone could read this memory. Make it private on GitHub (Settings → Danger Zone → Change visibility), then try again.`, "PUBLIC_REPO");
      if (repo.empty === false && !repo.adoptable) throw new HttpError(409, `${repo.fullName} already has files; pick an empty repo (or one with only a README, LICENSE or .gitignore).`, "NOT_EMPTY");
      if (b.adopt === true && !repo.adoptable) throw new HttpError(409, `${repo.fullName} isn't a Hippocampus vault yet. Pick it again to set it up as a new one.`, "NOT_A_VAULT");
      claimable(repo.fullName, "github");
      await new Promise((r) => setTimeout(r, opts.initDelay ?? 1200));
      state.installation = undefined;
      const vault = reconnect(repo.fullName, "github") ?? addVault({ fullName: repo.fullName, branch: "main", status: "ready", provider: "github" });
      if (state.vaults.length === 1) seedCurator(false);
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
      delete state.claims[vault.id];
      state.apps = state.apps.filter((a) => a.vault !== vault.id);
      if (state.last === vault.id) state.last = undefined;
      return { ok: true };
    }
    const vault = pick(request);
    if (sub === "keys" && method === "GET") return { keys: vault ? (state.keys[vault.id] ?? []) : [], ...(vault && state.claims[vault.id] ? { agents: state.claims[vault.id] } : {}) };
    if (sub === "keys" && method === "POST") return mint(request, body);
    if (sub === "keys/revoke" && method === "POST") {
      const id = (body as { id?: unknown } | undefined)?.id;
      if (vault) state.keys[vault.id] = (state.keys[vault.id] ?? []).filter((k) => k.id !== id);
      return { ok: true };
    }
    if (sub === "curator-actions" && method === "POST") {
      if (vault?.status !== "ready") throw new HttpError(409, "No vault yet: set one up first.", "NO_VAULT");
      if (vault.provider === "gitlab") throw new HttpError(409, "Nightly sleep on a schedule runs on GitHub Actions; for a GitLab vault, run sleep with your own curator agent.", "GITHUB_ONLY");
      const b = (body ?? {}) as { enable?: unknown; model?: unknown };
      if (b.model !== undefined && !ACTIONS_MODELS.includes(b.model as HostedActionsModel)) throw new HttpError(400, `model: ${ACTIONS_MODELS.join(" or ")}`, "INVALID");
      const enabled = !!b.enable;
      state.curatorActions[vault.id] = enabled;
      // The model is baked into the workflow file: the one asked for, else the one it had, else sonnet.
      const a = actionsOf(vault.id);
      if (enabled) a.model = (b.model as string | undefined) ?? a.model ?? "sonnet";
      const result: HostedCuratorActionsResult = { enabled, path: ".github/workflows/sleep.yml", ...(enabled ? { model: a.model } : {}) };
      return result;
    }
    if (sub.startsWith("curator-actions/")) {
      if (!vault || (vault.role ?? "owner") !== "owner") throw new HttpError(403, "Only the vault's owner can set up its curator.", "OWNER_ONLY");
      if (vault.status !== "ready") throw new HttpError(409, "This vault isn't ready.", "NOT_READY");
      if (vault.provider === "gitlab") throw new HttpError(409, "Nightly sleep on a schedule runs on GitHub Actions; for a GitLab vault, run sleep with your own curator agent.", "GITHUB_ONLY");
      const settingsUrl = `${api}/__demo/actions?permission=granted`;
      const mcpUrl = `${origin(request)}/mcp/${vault.id}`;
      const a = actionsOf(vault.id);
      const refused = () => new HttpError(403, `Hippocampus needs permission to manage Actions secrets and runs on ${vault.fullName}. Approve it on GitHub.`, "NEEDS_PERMISSION", { settingsUrl, repo: vault.fullName, who: "owner", missing: ["secrets", "actions"] });
      if (sub === "curator-actions/state" && method === "GET") {
        const enabled = !!state.curatorActions[vault.id];
        const s: HostedCuratorActionsState = state.actionsPermission
          ? { enabled, mcpUrl, ...(enabled ? { workflow: { mcpUrl, model: a.model ?? "sonnet" } } : {}), secrets: [...a.secrets], runs: enabled ? a.runs.slice(0, 5) : [] }
          : { enabled, mcpUrl, needsPermission: { repo: vault.fullName, settingsUrl, who: "owner" } };
        return s;
      }
      if (sub === "curator-actions/secrets" && method === "POST") {
        const b = (body ?? {}) as { claudeToken?: unknown; apiKey?: unknown; model?: unknown };
        if (b.claudeToken !== undefined && b.apiKey !== undefined) throw new HttpError(400, "Send claudeToken or apiKey, not both: the workflow uses one.", "INVALID");
        if (b.model !== undefined && !ACTIONS_MODELS.includes(b.model as HostedActionsModel)) throw new HttpError(400, `model: ${ACTIONS_MODELS.join(" or ")}`, "INVALID");
        const kind: HostedActionsSecret | undefined = b.claudeToken !== undefined ? "CLAUDE_CODE_OAUTH_TOKEN" : b.apiKey !== undefined ? "ANTHROPIC_API_KEY" : undefined;
        const raw = kind === "CLAUDE_CODE_OAUTH_TOKEN" ? b.claudeToken : b.apiKey;
        if (kind && (typeof raw !== "string" || !raw.trim() || /\s/.test(raw.trim()) || raw.trim().length > 512)) throw new HttpError(400, `${kind === "CLAUDE_CODE_OAUTH_TOKEN" ? "claudeToken" : "apiKey"}: paste it as one line, no spaces`, "INVALID");
        if (!state.actionsPermission) throw refused();
        // The demo keeps names only: what was pasted is dropped here, as the Worker drops it after sealing.
        const saved: HostedActionsSecret[] = [];
        const removed: HostedActionsSecret[] = [];
        if (kind) {
          const other: HostedActionsSecret = kind === "CLAUDE_CODE_OAUTH_TOKEN" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN";
          if (a.secrets.includes(other)) removed.push(other);
          a.secrets = a.secrets.filter((s) => s !== other && s !== kind).concat(kind);
          saved.push(kind);
        }
        const rotate = !!kind || !a.secrets.includes("HIPPO_CURATOR_KEY");
        if (rotate) {
          if (!a.secrets.includes("HIPPO_CURATOR_KEY")) a.secrets.push("HIPPO_CURATOR_KEY");
          saved.push("HIPPO_CURATOR_KEY");
          const keys = (state.keys[vault.id] ?? []).filter((k) => k.app !== "github-actions");
          keys.unshift({ id: hex(32), kind: "curator", scopes: ["read", "curate"], label: "GitHub Actions", app: "github-actions", created: now().toISOString() });
          state.keys[vault.id] = keys;
        }
        // A model goes into the workflow, so only while it's on; turning it on takes the card's choice.
        const on = !!state.curatorActions[vault.id];
        if (on && b.model) a.model = b.model as string;
        const result: HostedActionsSecretsResult = { saved, removed, curatorKey: rotate ? "replaced" : "kept", ...(on && b.model ? { model: a.model! } : {}) };
        return result;
      }
      if (sub === "curator-actions/run" && method === "POST") {
        if (!state.actionsPermission) throw refused();
        if (!state.curatorActions[vault.id]) throw new HttpError(409, "The workflow isn't in the repository: turn the Actions curator on first.", "NOT_ENABLED");
        const id = (a.runs[0]?.id ?? 7000) + 1;
        a.runs.unshift({ id, status: "queued", conclusion: null, created: now().toISOString(), url: `https://github.com/${vault.fullName}/actions/runs/${id}`, event: "workflow_dispatch" });
        const result: HostedActionsRunResult = { queued: true };
        return result;
      }
    }
    if ((sub === "curator-llm" || sub.startsWith("curator-llm/")) && method === "POST") {
      if (!vault || (vault.role ?? "owner") !== "owner") throw new HttpError(403, "Only the vault's owner can set up hosted curation.", "OWNER_ONLY");
      if (sub === "curator-llm") {
        const b = (body ?? {}) as Record<string, unknown>;
        const provider = b.provider as HostedLlmProvider;
        if (provider !== "anthropic" && provider !== "mistral") throw new HttpError(400, "provider: anthropic or mistral", "INVALID");
        const steps = mixOf(b, provider);
        const unpriced = [...new Set(DEMO_STEPS.map((s) => steps[s]))].filter((m) => !DEMO_MODELS.some((x) => x.provider === provider && x.model === m));
        if (unpriced.length) throw new HttpError(400, `${unpriced.join(", ")}: no price for ${unpriced.length === 1 ? "this model" : "these models"}, pick a listed one`, "INVALID");
        const monthCapUsd = capOf(b.monthCapUsd, "monthCapUsd");
        const runCapUsd = capOf(b.runCapUsd, "runCapUsd");
        if (b.key !== undefined && typeof b.key !== "string") throw new HttpError(400, "key: the provider's API key, as text", "INVALID");
        const key = typeof b.key === "string" ? b.key.trim() : "";
        if (!key && !state.llm) throw new HttpError(400, "key: paste the provider's API key", "INVALID");
        if (!key && state.llm && state.llm.provider !== provider) throw new HttpError(400, "key: a new provider needs its own key", "INVALID");
        // The demo's stand-in for the provider's check: a key with "refused" in it is refused. Only its hint is kept.
        if (/refused/i.test(key)) throw new HttpError(400, "The provider refused that key. Check it and paste it again.", "KEY_AUTH");
        let paused = state.llm?.paused;
        if (key && paused && paused.reason !== "budget") paused = undefined;
        if (paused?.reason === "budget" && monthCapUsd * 1e6 > state.spent) paused = undefined;
        state.llm = { provider, steps, keyHint: key ? `…${key.slice(-4)}` : state.llm!.keyHint!, monthCapUsd, runCapUsd, ...(paused ? { paused } : {}) };
        return hostedCurator(vault);
      }
      if (vault.status !== "ready") throw new HttpError(409, "This vault isn't ready.", "NOT_READY");
      if (sub === "curator-llm/vault") {
        const raw = (body as { hourUtc?: unknown } | undefined)?.hourUtc;
        if (raw !== null && !(typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 24)) throw new HttpError(400, "hourUtc: 0 to 23 (UTC), or null to turn it off", "INVALID");
        if (raw !== null && !state.llm) throw new HttpError(409, "Save a model key first.", "NO_KEY");
        if (raw === null) delete state.hours[vault.id];
        else state.hours[vault.id] = raw as number;
        return vaultCurator(vault);
      }
      if (sub === "curator-llm/run") {
        const llm = state.llm;
        if (!llm) throw new HttpError(409, "Hosted curation can't run: no model key is saved.", "NO_KEY");
        if (llm.paused?.reason === "budget" || state.spent >= (llm.monthCapUsd ?? 0) * 1e6) throw new HttpError(409, "Hosted curation can't run: this month's budget is spent.", "BUDGET");
        if (llm.paused) throw new HttpError(409, `Hosted curation can't run: ${llm.paused.reason === "auth" ? "the model key was refused" : "the model provider's credit ran out"}.`, "PAUSED");
        // The demo's runs finish at once, so they never wait on the open agent run it shows.
        const result: HostedCuratorRunResult = { run: hostedRun(llm) };
        return result;
      }
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
    if (sub === "apps/curate" && method === "POST") {
      const { id, on } = (body ?? {}) as { id?: unknown; on?: unknown };
      const app = state.apps.find((a) => a.id === id);
      if (!app) throw new HttpError(404, "No such app: it may be disconnected already.", "NOT_FOUND");
      if (typeof on !== "boolean") throw new HttpError(400, "on: expected true or false", "INVALID");
      app.curate = on;
      return { ok: true };
    }
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
      if (!DEMO_STAGES.includes(to)) throw new HttpError(400, `to: one of ${DEMO_STAGES.join(", ")}`, "INVALID");
      toStage(to, url.searchParams.get("provider") ?? undefined);
      return await cleared(to === "signed-out" ? `${base}/welcome/` : `${base}/setup/`);
    }
    if (sub === "device") {
      if (!state.signedIn) return redirect(`${base}/auth/login?return=${encodeURIComponent(`${base}/api/__demo/device${url.search}`)}`);
      const letters = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join("");
      const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
      const access = url.searchParams.get("access") === "curate" ? "curate" : "remember";
      state.devices.push({ code, client: access === "curate" ? "Claude Code (curator)" : "Claude Code", access, expires: new Date(now().getTime() + 10 * 60_000).toISOString(), status: "pending" });
      return redirect(`${base}/connect/?code=${code}`);
    }
    if (sub === "curator") {
      // Hosted curation's states: a pause (saving a key first if none is), and a standby curator's check-in.
      const vault = state.vaults.find((v) => v.id === state.last) ?? state.vaults[0];
      const pause = url.searchParams.get("pause");
      if (pause === "budget" || pause === "auth" || pause === "credit") {
        state.llm ??= { provider: "anthropic", steps: DEMO_RECOMMENDED.anthropic!, keyHint: "…demo", monthCapUsd: 5, runCapUsd: 1 };
        if (pause === "budget") state.spent = Math.max(state.spent, (state.llm.monthCapUsd ?? 0) * 1e6);
        pauseFor(pause);
      } else if (pause === "none" && state.llm) delete state.llm.paused;
      const standby = url.searchParams.get("standby");
      if (vault && standby === "none") delete state.standby[vault.id];
      else if (vault && standby) state.standby[vault.id] = { curator: standby.slice(0, 40), at: now().toISOString(), decision: state.hours[vault.id] !== undefined && !state.llm?.paused ? "hosted" : "needed" };
      return redirect(`${base}/setup/#curation`);
    }
    if (sub === "actions") {
      // The Actions curator's permission: `missing` until the installation approves Secrets and Actions.
      const permission = url.searchParams.get("permission");
      if (permission === "missing") state.actionsPermission = false;
      else if (permission === "granted") state.actionsPermission = true;
      return redirect(`${base}/setup/#curation`);
    }
    if (sub === "key") {
      if (!opts.demoKey) throw new HttpError(404, "The demo has no key", "NOT_FOUND");
      return new Response(`${opts.demoKey}\n`, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": 'attachment; filename="hippocampus-demo.agekey"', ...securityHeaders() } });
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
      // A clone: a request that isn't one of these routes goes on to the demo campaign's API, which reads the body itself.
      const body = method === "POST" ? await readJson(request.clone()) : undefined;
      if (section === "setup") return json(200, await setupRoute(request, method, sub, body, url));
      if (section === "admin") return json(200, adminRoute(method, sub, body, url));
      if (section === "account") return json(200, accountRoute(method, sub, body));
      if (section === "invites") return json(200, invitesRoute(request, method, sub, body));
      if (section === "connect") return json(200, connectRoute(request, method, sub, body, url));
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

/** A page that clears the browser's setup drafts (sessionStorage) and goes on to `to`: a 302 can't. Its one script is allowed by its hash. */
async function cleared(to: string): Promise<Response> {
  const script = `${STAGE_CLEARS}location.replace(${JSON.stringify(to)});`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo stage</title></head><body><p><a href="${to}">Continue</a></p><script>${script}</script></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-demo-next": to, ...securityHeaders(), "content-security-policy": `default-src 'none'; script-src 'sha256-${hash}'; frame-ancestors 'none'` } });
}

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...securityHeaders(), "content-security-policy": "default-src 'none'; frame-ancestors 'none'" } });
}

