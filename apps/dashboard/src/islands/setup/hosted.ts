// Session Zero on the hosted app, its pure parts: the onboarding steps and when each unlocks, the
// repo picker's verdicts, the campaign draft, and the curator recipes. No DOM here, so it is
// unit-tested in hosted.test.ts.
import type { HostedAgentClaim, HostedConnectedApp, HostedCuratorStatus, HostedInitRequest, HostedKeyInfo, HostedLlmProvider, HostedLlmStep, HostedStepMix, HostedVaultCurator, Snippet } from "@hippocampus/dashboard";
import { accessOf } from "@hippocampus/dashboard/connect";
import type { IconName } from "../../lib/icons.ts";
import type { HostedRepoView, HostedStatus } from "../../lib/types.ts";
import { agentIdProblem, isTimeZone, type BadgeState, type Wording } from "./model.ts";


export type HostedProvider = "github" | "gitlab";

/** The five onboarding steps. Access shows only while the account waits for approval. */
export type HostedStepId = "access" | "repo" | "vault" | "agent" | "curate";

export interface HostedStepDef {
  id: HostedStepId;
  title: Wording;
  icon: IconName;
  lede: Wording;
}

export const HOSTED_STEPS: readonly HostedStepDef[] = [
  {
    id: "access",
    title: ["Request access", "Ask for a seat"],
    icon: "quill",
    lede: ["This Hippocampus lets people in by hand. Ask once, and an admin approves your account.", "This table seats players by invitation. Ask once, and an admin lets you in."],
  },
  {
    id: "repo",
    title: ["Repository", "The vault repo"],
    icon: "github",
    lede: [
      "Your memory lives in a private GitHub repository that you own. Create one, install the Hippocampus app on it, and pick it here.",
      "The campaign lives in a private GitHub repository that you own. Create one, install the Hippocampus app on it, and pick it here.",
    ],
  },
  {
    id: "vault",
    title: ["Your vault", "The campaign"],
    icon: "scroll",
    lede: ["Give it a name. Everything else has a sensible default, and one commit puts the vault template into your repository.", "Name the campaign. Everything else has a sensible default, and one commit lays the campaign wiki into your repository."],
  },
  {
    id: "agent",
    title: ["Add your first agent", "Seat your first agent"],
    icon: "party",
    lede: ["Paste one prompt into your agent. It connects itself, learns how to use the memory, and checks who curates.", "Paste one prompt into your agent. It takes its seat by itself, learns the table's ways, and checks who curates."],
  },
  {
    id: "curate",
    title: ["Curation", "Appoint a curator"],
    icon: "moonStars",
    lede: ["Every night a curator turns what your agents saved into confirmed records. Choose who does it.", "Every night a curator sleeps on the party's notes and turns them into canon. Choose who does it."],
  },
];

/** The steps' words for GitLab: the same steps, a different host. */
const GITLAB_WORDS: Partial<Record<HostedStepId, Pick<HostedStepDef, "title" | "icon" | "lede">>> = {
  repo: {
    title: ["Project", "The vault project"],
    icon: "link",
    lede: ["Your memory lives in a private GitLab project that you own. Create one, connect GitLab, and pick it here.", "The campaign lives in a private GitLab project that you own. Create one, connect GitLab, and pick it here."],
  },
};

/** The step definitions as worded for the host the vault will live on, without Access once the account is approved. */
export function stepsFor(provider: HostedProvider, withAccess = true): readonly HostedStepDef[] {
  const steps = withAccess ? HOSTED_STEPS : HOSTED_STEPS.filter((s) => s.id !== "access");
  return provider === "gitlab" ? steps.map((s) => ({ ...s, ...GITLAB_WORDS[s.id] })) : steps;
}

/** The steps this person sees: Access only while they wait for approval (or were refused). */
export const visibleSteps = (ctx: HostedContext): readonly HostedStepDef[] => stepsFor(hostedProvider(ctx), ctx.status.account.status !== "approved");

/** The 9-step onboarding's step ids, and the step each is part of now. Links, bookmarks and redirects still carry them. */
export const STEP_ALIASES: Readonly<Record<string, HostedStepId>> = { create: "repo", install: "repo", campaign: "vault", init: "vault", agents: "agent", curator: "curate", done: "curate" };

export function parseHostedStep(hash: string): HostedStepId | undefined {
  const id = hash.replace(/^#/, "");
  if (HOSTED_STEPS.some((s) => s.id === id)) return id as HostedStepId;
  return Object.hasOwn(STEP_ALIASES, id) ? STEP_ALIASES[id] : undefined;
}

/** Setup & health's sections, in the sticky nav's order. */
export const SETUP_SECTIONS = [
  { id: "setup-vault", title: ["Vault", "Vault"] },
  { id: "setup-agents", title: ["Agents", "Party"] },
  { id: "setup-curation", title: ["Curation", "Sleep"] },
  { id: "setup-people", title: ["People", "Table"] },
  { id: "setup-account", title: ["Account", "Account"] },
] as const satisfies readonly { id: string; title: Wording }[];

export type SetupSectionId = (typeof SETUP_SECTIONS)[number]["id"];

/**
 * On a ready vault, the steps with nothing left to do open the matching part of Setup & health. Old step
 * ids land there too: `#curator` on Nightly curation (`#curation`), `#agents` on the Agents section.
 */
const READY_ANCHOR: Readonly<Record<string, string>> = { access: "account", repo: "sz-repo", create: "sz-repo", install: "sz-repo", campaign: "sz-repo", init: "sz-repo", agents: "setup-agents", curator: "curation", done: "setup-vault" };
/** Steps that still mean something on a ready vault: the vault's own (it says it's ready), adding an agent, and curation. */
const READY_STEPS: ReadonlySet<string> = new Set(["vault", "agent", "curate"]);
/** Anchors the onboarding page has too, below the wizard. */
const ONBOARDING_ANCHORS: ReadonlySet<string> = new Set(["account", "personalization", "invite"]);

export type SetupTarget = { step: HostedStepId; alias: boolean } | { anchor: string; alias: boolean };

/**
 * Where a setup page hash lands: a wizard step, or an element of the page. `alias` says the hash isn't the
 * target's own id (an old step id), so the page can put the real one in the address. Undefined: no hash, or
 * one the wizard doesn't know, so it opens on the step that needs the person.
 */
export function resolveSetupHash(hash: string, o: { ready: boolean; adding?: boolean }): SetupTarget | undefined {
  const id = hash.replace(/^#/, "");
  if (!id) return undefined;
  if (o.ready && !o.adding) {
    if (READY_STEPS.has(id)) return { step: id as HostedStepId, alias: false };
    if (Object.hasOwn(READY_ANCHOR, id)) return { anchor: READY_ANCHOR[id]!, alias: true };
    return { anchor: id, alias: false };
  }
  const step = parseHostedStep(id);
  if (step) return { step, alias: step !== id };
  if (!o.adding && ONBOARDING_ANCHORS.has(id)) return { anchor: id, alias: false };
  return undefined;
}

export function hostedStepDef(id: HostedStepId, provider: HostedProvider = "github"): HostedStepDef {
  const steps = stepsFor(provider);
  return steps.find((s) => s.id === id) ?? steps[0]!;
}

/** Where a step sits among the steps shown (Access counts only while it's shown). */
export function hostedIndex(id: HostedStepId, steps: readonly HostedStepDef[] = HOSTED_STEPS): number {
  return Math.max(0, steps.findIndex((s) => s.id === id));
}

export function hostedNeighbors(id: HostedStepId, steps: readonly HostedStepDef[] = HOSTED_STEPS): { prev?: HostedStepDef; next?: HostedStepDef } {
  const i = steps.findIndex((s) => s.id === id);
  if (i < 0) return {};
  return { prev: steps[i - 1], next: steps[i + 1] };
}

/** What the steps depend on: the server's status, the repo picked here, whether the vault form is ready, and the sign-in apps. */
export interface HostedContext {
  status: HostedStatus;
  picked?: number;
  draftReady: boolean;
  /** The host the person chose in this browser; the vault's own, once there is one, wins. */
  provider?: HostedProvider;
  /** The person's sign-in apps (Claude.ai, ChatGPT), from `/account/apps`: a grant to this vault counts as an agent, one that may curate as the curator. */
  apps?: readonly Pick<HostedConnectedApp, "vault" | "curate">[];
}

/** Which host the flow is about: the vault's, else the person's choice, else wherever they already connected. GitHub unless GitLab is offered. */
export function hostedProvider(ctx: Pick<HostedContext, "status" | "provider">): HostedProvider {
  const s = ctx.status;
  if (s.vault?.provider) return s.vault.provider;
  if (!s.providers?.includes("gitlab")) return "github";
  if (ctx.provider) return ctx.provider;
  return s.gitlab?.connected && !s.installation ? "gitlab" : "github";
}

/** The repos the person can pick from, on the chosen host. */
export function hostedRepos(ctx: Pick<HostedContext, "status" | "provider">): HostedRepoView[] {
  const provider = hostedProvider(ctx);
  const repos = provider === "gitlab" ? (ctx.status.gitlab?.repos ?? []) : (ctx.status.installation?.repos ?? []);
  const mine = new Map((ctx.status.vaults ?? []).filter((v) => (v.provider ?? "github") === provider).map((v) => [v.fullName.toLowerCase(), v.status]));
  // A disconnected vault isn't taken: picking its repo again brings it back.
  return repos.map((r) => {
    const status = mine.get(r.fullName.toLowerCase());
    return status === undefined ? r : status === "disconnected" ? { ...r, reconnect: true } : { ...r, yours: true };
  });
}

/**
 * The repo to preselect: the only one that can become the vault, or the person's own disconnected vault (picking
 * it reconnects it). Nothing when there's a real choice to make.
 */
export function preselectRepo(ctx: Pick<HostedContext, "status" | "provider">): number | undefined {
  const provider = hostedProvider(ctx);
  const usable = hostedRepos(ctx).filter((r) => repoVerdict(r, provider).usable);
  const back = usable.filter((r) => r.reconnect);
  if (back.length === 1) return back[0]!.id;
  return usable.length === 1 ? usable[0]!.id : undefined;
}

/** The picked repo already holds a vault, so setup adopts it as it is: no name, id or domains to ask for. */
export function pickedAdoptable(ctx: Pick<HostedContext, "status" | "picked" | "provider">): boolean {
  return ctx.picked !== undefined && !!hostedRepos(ctx).find((r) => r.id === ctx.picked)?.adoptable;
}

/** Where the setup status comes from; `?add` also lists GitLab projects beside a ready vault. */
export const statusKey = (adding: boolean) => (adding ? "/setup/status?add" : "/setup/status");

/** The status as a new vault's setup sees it: nothing of the vault the tab shows, so the wizard starts fresh. */
export function forNewVault(s: HostedStatus): HostedStatus {
  const { vault: _vault, keys: _keys, curatorActions: _actions, hostedCurator, ...rest } = s;
  // The account's key and caps stay; the shown vault's schedule doesn't.
  const account = hostedCurator ? (({ vault: _v, ...a }) => a)(hostedCurator) : undefined;
  return { ...rest, ...(account ? { hostedCurator: account } : {}), items: s.items.filter((i) => i.id === "access") };
}

/** How many of these vaults the person owns (a vault without a role is theirs: an older server). */
export const ownedCount = (vaults: readonly { role?: string }[]) => vaults.filter((v) => (v.role ?? "owner") === "owner").length;

/** Whether the person may add another vault, and why not. */
export function canAddVault(s: Pick<HostedStatus, "account" | "vaults" | "vaultLimit">): { ok: boolean; why?: string } {
  if (s.account.status !== "approved") return { ok: false, why: "An admin approves your account first." };
  // Only vaults of their own count; ones shared with them don't.
  const n = ownedCount(s.vaults ?? []);
  if (s.vaultLimit !== undefined && n >= s.vaultLimit) return { ok: false, why: `You have ${n} vaults, the most one person can have here. Remove one to add another.` };
  return { ok: true };
}

/** Whether the host is connected, so repos can be listed: the GitHub App installed, or GitLab signed in. */
export function hostedConnected(ctx: Pick<HostedContext, "status" | "provider">): boolean {
  const s = ctx.status;
  return hostedProvider(ctx) === "gitlab" ? !!s.gitlab?.connected : !!s.installation;
}

export const hasKey = (keys: readonly HostedKeyInfo[] | undefined, kinds: readonly HostedKeyInfo["kind"][]) => (keys ?? []).some((k) => kinds.includes(k.kind));

/** The sign-in apps granted this vault (a grant without a vault is an older one, for whichever vault it opens). */
const appsHere = (ctx: HostedContext) => (ctx.apps ?? []).filter((a) => !a.vault || a.vault === ctx.status.vault?.id);

/** Some agent is connected: a key for agents, or a sign-in app. */
export const hasAgent = (ctx: HostedContext) => hasKey(ctx.status.keys, ["agent", "bound"]) || appsHere(ctx).length > 0;

/** Someone curates: a curator key, the Actions workflow, or a sign-in app the owner let curate. */
export const hasCurator = (ctx: HostedContext) =>
  hasKey(ctx.status.keys, ["curator"]) || !!ctx.status.curatorActions || !!ctx.status.hostedCurator?.vault?.enabled || appsHere(ctx).some((a) => a.curate);

/** The picked repo is one the installation can still see. */
export function pickedRepo(ctx: HostedContext): boolean {
  return ctx.picked !== undefined && hostedRepos(ctx).some((r) => r.id === ctx.picked);
}

/** Why a step can't be used yet, in both voices; undefined when it can. */
export function hostedLock(id: HostedStepId, ctx: HostedContext): Wording | undefined {
  const s = ctx.status;
  const v = s.vault;
  const ready = v?.status === "ready";
  if (id === "access") return undefined;
  if (s.account.status !== "approved") return ["An admin approves your account first. This step unlocks then.", "An admin seats you first. This step unlocks then."];
  if (id === "repo") return undefined;
  if (id === "vault") {
    if (ready || v?.status === "bootstrapping") return undefined;
    if (!hostedConnected(ctx)) {
      const gitlab = hostedProvider(ctx) === "gitlab";
      if (gitlab) return v ? ["Connect GitLab again first.", "Connect GitLab again first."] : ["Connect GitLab first.", "Connect GitLab first."];
      return v ? ["Install the app on your repo again first.", "Install the app on your repo again first."] : ["Install the app on your repo first.", "Install the app on your repo first."];
    }
    if (!pickedRepo(ctx)) return hostedProvider(ctx) === "gitlab" ? ["Pick the project first.", "Pick the project first."] : ["Pick the repo first.", "Pick the repo first."];
    return undefined;
  }
  return ready ? undefined : ["This needs your vault. Set it up first; everything after it unlocks.", "This needs the vault. Open it first; everything after it unlocks."];
}

/** A step's badge: `locked` until it can be used, then how it stands. */
export function hostedStepState(id: HostedStepId, ctx: HostedContext): BadgeState {
  if (hostedLock(id, ctx)) return "locked";
  const s = ctx.status;
  const v = s.vault;
  const ready = v?.status === "ready";
  switch (id) {
    case "access":
      return s.account.status === "approved" ? "done" : s.account.status === "denied" ? "error" : s.account.requested ? "wait" : "todo";
    case "repo": {
      if (ready || v?.status === "bootstrapping" || pickedRepo(ctx)) return "done";
      const link = hostedProvider(ctx) === "gitlab" ? s.gitlab : s.installation;
      if (link?.error && hostedConnected(ctx)) return "warn";
      return v?.status === "disconnected" ? "error" : "todo";
    }
    case "vault":
      return ready ? "done" : v?.status === "bootstrapping" ? "wait" : v?.status === "disconnected" && !pickedAdoptable(ctx) ? "error" : "todo";
    case "agent":
      return hasAgent(ctx) ? "done" : "todo";
    case "curate":
      return hasCurator(ctx) ? "done" : "todo";
  }
}

/** Where to land without a hash: the first step that needs you. */
export function hostedDefaultStep(ctx: HostedContext): HostedStepId {
  const s = ctx.status;
  const v = s.vault;
  if (s.account.status !== "approved") return "access";
  if (v?.status === "ready") return hasAgent(ctx) ? "curate" : "agent";
  if (v?.status === "bootstrapping") return "vault";
  if (hostedConnected(ctx) && pickedRepo(ctx)) return "vault";
  return "repo";
}

/** Which server status item speaks for a step ("Right now: …"). */
export const STEP_ITEM: Partial<Record<HostedStepId, string>> = { access: "access", repo: "install", vault: "vault", agent: "keys" };

/** What the "add an agent" card sees arrive after it opened: nothing yet, a connection that hasn't called in, or one that has. */
export type Arrival = { state: "waiting" } | { state: "approved"; name: string } | { state: "connected"; name: string; agent?: string };

/**
 * A connection that wasn't there when the card opened (`before`: the ids it saw then). The curator's own
 * connection doesn't count: the setup prompt makes it after the agent's.
 */
export function arrival(rows: readonly ConnectionRow[], before: ReadonlySet<string>): Arrival {
  const fresh = rows.filter((r) => !before.has(r.id) && !("curator" in r.actsAs));
  if (!fresh.length) return { state: "waiting" };
  // A sign-in app is connected once it holds a grant; a key, once it has called in.
  const spoke = fresh.find((r) => r.source === "app" || r.lastUsed || r.agents.length);
  if (!spoke) return { state: "approved", name: fresh[0]!.name };
  const agent = "agent" in spoke.actsAs ? spoke.actsAs.agent : spoke.agents[0]?.agent;
  return { state: "connected", name: spoke.name, ...(agent ? { agent } : {}) };
}

// ── The repo picker ────────────────────────────────────────────────────────

export interface RepoVerdict {
  usable: boolean;
  tone: BadgeState;
  tag: string;
  detail: string;
}

/** Whether a repo can become the vault, and why not. Public repos never can: anyone could read the memory. */
export function repoVerdict(r: HostedRepoView, provider: HostedProvider = "github"): RepoVerdict {
  if (!r.private && provider === "gitlab")
    return { usable: false, tone: "error", tag: "Not private", detail: "Anyone could read your memory there (internal projects are open to every signed-in user of the instance). Set it to Private in the project's visibility settings on GitLab, or pick another." };
  if (!r.private) return { usable: false, tone: "error", tag: "Public", detail: "Anyone could read your memory there. Make it private on GitHub (Settings → Danger Zone → Change visibility), or pick another." };
  if (r.yours) return { usable: false, tone: "optional", tag: "Already yours", detail: "It's one of your vaults here already. Switch to it from the vault menu, or pick another repo." };
  if (r.reconnect && r.adoptable) return { usable: true, tone: "done", tag: "Reconnect", detail: "Your vault, disconnected: it's reconnected as it is, with nothing to fill in." };
  if (r.adoptable) return { usable: true, tone: "done", tag: "Existing vault", detail: "Already a Hippocampus vault: it's adopted as it is, and only missing rule files are added." };
  if (r.empty === true) return { usable: true, tone: "done", tag: "Empty", detail: "Private and empty: ready to become your vault." };
  if (r.empty === false && r.adoptable === false) return { usable: false, tone: "error", tag: "Has files", detail: "It already holds other files. Pick an empty repo (one with only a README, LICENSE or .gitignore works too)." };
  if (r.empty === false)
    return {
      usable: true,
      tone: "warn",
      tag: "Has files",
      detail: "Works if it's an existing Hippocampus vault (adopted as it is) or holds only a README, LICENSE or .gitignore. Anything else is refused when you set it up.",
    };
  return { usable: true, tone: "optional", tag: "Not checked", detail: "Private. Whether it's empty is checked when you set it up." };
}

// ── The campaign draft ─────────────────────────────────────────────────────

/** The vault template's own domains (vault-template/_hippo/config.yaml), as a starting point. */
export const TEMPLATE_DOMAINS: readonly string[] = ["admin", "housing", "career", "finance", "health", "story"];

export interface CampaignDraft {
  campaign: string;
  human: string;
  timezone: string;
  domains: string[];
  /** Lay the fictional example campaign over the template. */
  seed: boolean;
  /** Presets to add, in the order they were ticked. */
  presets: string[];
  secrets: "create" | "skip";
  /** The age public key made in the browser; the private half never leaves it. */
  recipient?: string;
  /** The person ticked "I saved the key file". */
  saved: boolean;
}

/** A new draft: your id from your login, the browser's time zone, the template's domains, and a secrets key to make. */
export function newDraft(timezone: string, login?: string): CampaignDraft {
  return { campaign: "", human: (login && humanIdFor(login)) || "player", timezone, domains: [...TEMPLATE_DOMAINS], seed: false, presets: [], secrets: "create", saved: false };
}

/** What stops the vault being created. The secrets key never does: without a saved one, the vault starts without it. */
export function draftProblems(d: CampaignDraft): { campaign?: string; human?: string; timezone?: string } {
  const campaign = d.campaign.trim();
  return {
    campaign: !campaign ? "Give it a name." : campaign.length > 120 ? "Up to 120 characters." : undefined,
    human: agentIdProblem(d.human),
    timezone: isTimeZone(d.timezone) ? undefined : "Use a time zone name such as Europe/Lisbon.",
  };
}

export const draftReady = (d: CampaignDraft) => Object.values(draftProblems(d)).every((p) => !p);

/** The key goes along only once the person ticked that they saved its file: a vault locked to a lost key can't read its secrets. */
export const keyGoesAlong = (d: CampaignDraft): d is CampaignDraft & { recipient: string } => d.secrets === "create" && !!d.recipient && d.saved;

/** The init request for the picked repo. A repo that already holds a vault (`adopt`) is adopted as it is: presets only shape new vaults. */
export function initRequest(d: CampaignDraft, repoId: number, opts: { adopt?: boolean; provider?: HostedProvider } = {}): HostedInitRequest {
  const provider = opts.provider ?? "github";
  // An existing vault keeps its own settings, so nothing from the form goes along but a saved secrets key (used if the vault has none).
  if (opts.adopt) return { ...(provider === "gitlab" ? { provider } : {}), repoId, adopt: true, ...(keyGoesAlong(d) ? { recipient: d.recipient } : {}) };
  return {
    ...(provider === "gitlab" ? { provider } : {}),
    repoId,
    campaign: d.campaign.trim(),
    human: d.human.trim().toLowerCase(),
    timezone: d.timezone.trim(),
    domains: d.domains,
    ...(d.seed ? { seed: "example-relocation" as const } : {}),
    ...(d.presets?.length && !opts.adopt ? { presets: d.presets } : {}),
    ...(keyGoesAlong(d) ? { recipient: d.recipient } : {}),
  };
}

/** The downloaded identity's file name: `hippocampus-<campaign>.agekey`. */
export function identityFileName(campaign: string): string {
  const slug = campaign
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `hippocampus-${slug || "vault"}.agekey`;
}

/** What `hippo secrets show` reads: the identity alone, as `age-keygen` and `hippo secrets keygen` write it. */
export const identityFileText = (identity: string) => `${identity.trim()}\n`;

// ── Agents and the curator ─────────────────────────────────────────────────

/** What the Actions curator needs in the vault repo, set with the GitHub CLI. */
export function actionsSnippets(repo: string, mcpUrl: string): Snippet[] {
  return [
    {
      label: "Repository secrets",
      lang: "bash",
      code: [`gh secret set HIPPO_CURATOR_KEY --repo ${repo}`, `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${repo}   # or ANTHROPIC_API_KEY`].join("\n"),
      note: "Each command asks for the value: the curator key, then a token from your Claude subscription (make one with claude setup-token; no API bill) or, as ANTHROPIC_API_KEY instead, an Anthropic API key. Or set them on GitHub: the repo → Settings → Secrets and variables → Actions.",
    },
    {
      label: "Repository variables",
      lang: "bash",
      code: [`gh variable set HIPPO_MCP_URL --repo ${repo} --body ${mcpUrl}`, `gh variable set HIPPO_CURATOR_MODEL --repo ${repo} --body opus`].join("\n"),
      note: "HIPPO_CURATOR_MODEL is optional (sonnet or opus, say); without it the workflow uses sonnet. It runs nightly at 03:23 UTC.",
    },
  ];
}

// ── Hosted curation (the owner's model key) ────────────────────────────────

export type CuratorModel = HostedCuratorStatus["models"][number];

/** The curator's four model steps, in the order a memory meets them, with what each does in plain words. */
export const LLM_STEPS: readonly { id: HostedLlmStep; word: string; help: string }[] = [
  { id: "mentions", word: "Mentions", help: "finds who and what a memory is about" },
  { id: "match", word: "Matching", help: "matches those to the vault's notes" },
  { id: "claims", word: "Facts", help: "reads the facts and relations out of it" },
  { id: "summary", word: "Summaries", help: "rewrites the summaries of changed notes" },
];

export const PROVIDER_WORDS: Record<HostedLlmProvider, string> = { anthropic: "Anthropic", mistral: "Mistral" };

/**
 * Output tokens a hosted call may write, per step: a copy of `STEP_MAX_OUTPUT` in
 * packages/curator/src/pricing.ts, which the dashboard can't import. Keep the two equal.
 */
export const STEP_MAX_OUTPUT: Record<HostedLlmStep, number> = { mentions: 2048, match: 512, claims: 4096, summary: 1024 };

/** The prompt size the estimate assumes for every call: generous, so the estimate errs high. */
export const ESTIMATE_PROMPT_TOKENS = 4000;

/**
 * Calls per memory the estimate assumes for each step: a memory makes one match call per new thing it
 * names, and each note it touches gets a summary, so those steps count more than once.
 */
export const ESTIMATE_CALLS: Record<HostedLlmStep, number> = { mentions: 1, match: 3, claims: 1, summary: 2 };

/** The estimate's assumptions, shown next to it. */
export const ESTIMATE_ASSUMES = `per memory, one call to find what it names, three to match them to notes, one for its facts and two summaries, each reading ${ESTIMATE_PROMPT_TOKENS.toLocaleString("en-US")} tokens and writing as much as the step may. Real runs usually cost less.`;

export const uniformMix = (model: string): HostedStepMix => ({ mentions: model, match: model, claims: model, summary: model });

/** Whether every step uses the same model. */
export const isUniform = (mix: HostedStepMix) => LLM_STEPS.every((s) => mix[s.id] === mix.mentions);

/** A provider's models, cheapest first. */
export function modelsOf(models: readonly CuratorModel[], provider: HostedLlmProvider): CuratorModel[] {
  return models.filter((m) => m.provider === provider).sort((a, b) => a.inputUsdPerMTok + a.outputUsdPerMTok - (b.inputUsdPerMTok + b.outputUsdPerMTok));
}

/** The providers the instance can price, in the order it lists them. */
export const curatorProviders = (models: readonly CuratorModel[]): HostedLlmProvider[] => [...new Set(models.map((m) => m.provider))];

/**
 * The mix the form starts from for a provider: the saved one, else the eval's recommendation, else the
 * provider's cheapest model for every step. `recommended` says whether the eval chose it.
 */
export function startingMix(c: Pick<HostedCuratorStatus, "provider" | "steps" | "recommended" | "models">, provider: HostedLlmProvider): { mix: HostedStepMix; recommended: boolean } | undefined {
  const rec = c.recommended[provider];
  if (c.provider === provider && c.steps) return { mix: c.steps, recommended: !!rec && LLM_STEPS.every((s) => rec[s.id] === c.steps![s.id]) };
  if (rec) return { mix: rec, recommended: true };
  const cheapest = modelsOf(c.models, provider)[0];
  return cheapest ? { mix: uniformMix(cheapest.model), recommended: false } : undefined;
}

/**
 * What 100 memories cost at most, in USD, under `ESTIMATE_ASSUMES`. Undefined when a step's model has
 * no price (a run would refuse it anyway).
 */
export function estimatePer100(mix: HostedStepMix, models: readonly CuratorModel[], provider: HostedLlmProvider): number | undefined {
  let usd = 0;
  for (const s of LLM_STEPS) {
    const m = models.find((x) => x.provider === provider && x.model === mix[s.id]);
    if (!m) return undefined;
    // USD per million tokens, so tokens × rate / 1e6 per call.
    usd += (ESTIMATE_CALLS[s.id] * (ESTIMATE_PROMPT_TOKENS * m.inputUsdPerMTok + STEP_MAX_OUTPUT[s.id] * m.outputUsdPerMTok)) / 1e6;
  }
  return usd * 100;
}

/** Dollars for people: cents under $100, whole dollars above, and "under $0.01" for crumbs. */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return "under $0.01";
  return usd >= 100 ? `$${Math.round(usd).toLocaleString("en-US")}` : `$${usd.toFixed(2)}`;
}

/** A model's price as it shows beside it. */
export const priceWords = (m: CuratorModel) => `$${m.inputUsdPerMTok} in / $${m.outputUsdPerMTok} out per M tokens`;

export interface CapsDraft {
  month: string;
  run: string;
}

/** Why the caps can't be saved yet. A run's cap above the month's would never bind. */
export function capProblems(d: CapsDraft): { month?: string; run?: string } {
  const month = Number(d.month);
  const run = Number(d.run);
  const bad = (n: number, raw: string) => (!raw.trim() || !Number.isFinite(n) ? "A number of US dollars." : n <= 0 ? "More than $0." : n > 10_000 ? "Up to $10,000." : undefined);
  return { month: bad(month, d.month), run: bad(run, d.run) ?? (Number.isFinite(month) && run > month ? "At most the monthly cap." : undefined) };
}

/** Whether a save must carry a key: the first save, and any save that changes the provider. */
export const keyNeeded = (c: Pick<HostedCuratorStatus, "provider" | "keyHint">, provider: HostedLlmProvider) => !c.keyHint || c.provider !== provider;

/**
 * The 24 nightly hours, stored as UTC, each labelled in the person's own time (`timeZone`, else the
 * browser's), sorted by that time. A half-hour zone shows 03:30 rather than pretending to 03:00.
 */
export function hourOptions(at: Date, timeZone?: string): { hourUtc: number; label: string }[] {
  const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) });
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return Array.from({ length: 24 }, (_, h) => ({ hourUtc: h, label: fmt.format(new Date(day + h * 3600_000)) })).sort((a, b) => a.label.localeCompare(b.label));
}

/** One UTC hour in local time, e.g. `04:00`. */
export const localHour = (hourUtc: number, at: Date, timeZone?: string) => hourOptions(at, timeZone).find((o) => o.hourUtc === hourUtc)?.label ?? `${String(hourUtc).padStart(2, "0")}:00 UTC`;

/** Why hosted runs wait, and what fixes it. */
export const PAUSE_WORDS: Record<"auth" | "credit" | "budget", { word: string; fix: string }> = {
  auth: { word: "Paused: the provider refused the key", fix: "Save a new key below. Runs start again with the next night." },
  credit: { word: "Paused: the provider's credit ran out", fix: "Add credit at the provider, or save a key that has some. Saving a key starts runs again." },
  budget: {
    word: "Paused: monthly budget reached",
    fix: "What's left this month can't cover another memory at its most expensive, so a little may stay unspent. Raise the monthly cap below, or wait for the next month: the budget starts again on the 1st (UTC).",
  },
};

/** A pause this dashboard doesn't know (a newer Worker's) reads as a plain pause. */
export const pauseWords = (reason: string) =>
  Object.hasOwn(PAUSE_WORDS, reason) ? PAUSE_WORDS[reason as keyof typeof PAUSE_WORDS] : { word: "Paused", fix: "Save the settings again, or ask the operator." };

/** The banner when hosted curation is paused: why, who covers tonight if anyone stands by, and the fix. */
export function pausedBanner(paused: { reason: string }, standby: HostedVaultCurator["standby"]): { head: string; standby?: string; fix: string } {
  const w = pauseWords(paused.reason);
  return { head: w.word, ...(standby ? { standby: standby.curator } : {}), fix: w.fix };
}

/** The standby line: who stands by and when they last checked in. Undefined means nobody does yet. */
export function standbyWords(standby: HostedVaultCurator["standby"]): { curator: string; at: string; decision: string } | undefined {
  if (!standby) return undefined;
  const decision = standby.decision === "needed" ? "it ran" : standby.decision === "hosted" ? "Hippocampus had it covered" : standby.decision === "idle" ? "nothing was waiting" : standby.decision;
  return { curator: standby.curator, at: standby.at, decision };
}

/** The hosted routes' error codes in plain words; anything else keeps the server's own words. */
const CURATOR_ERRORS: Record<string, string> = {
  KEY_AUTH: "The provider refused that key. Check it and paste it again.",
  KEY_UNREACHABLE: "The provider couldn't be reached to check the key. Try again in a minute.",
  UNAVAILABLE: "This Hippocampus doesn't run curation with your own key right now.",
  NO_KEY: "Save a model key first.",
  NOT_READY: "This vault isn't ready yet.",
  OFF: "The operator has switched hosted curation off for now.",
  NO_ACCOUNT: "This vault's account wasn't found.",
  PAUSED: "Hosted curation is paused. See what to do above.",
  BUDGET: "This month's budget is spent. Raise the monthly cap, or wait for the next month.",
  UNPRICED: "A chosen model has no price, so it can't be metered. Pick the models again and save.",
  BUSY: "Another curator's run is open. Try again when it finishes.",
  SLEEP_LIMIT: "This vault has had its runs for today. Try again tomorrow.",
  VAULT_UPGRADE_NEEDED: "The vault needs an upgrade before it can be curated. See Setup & health.",
  VAULT: "The vault couldn't be read just now. Try again in a minute.",
};

/** Codes Run now answers that aren't failures: nothing needed doing. */
export const RUN_NOTHING_TO_DO = new Set(["IDLE", "NOT_NEEDED"]);

/** An API error from a hosted curation route, reworded. The key is never part of it: the server never echoes it. */
export function curatorError(err: unknown): unknown {
  const e = (typeof err === "object" && err ? err : {}) as { status?: unknown; code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  // KEY_MODELS_MISSING and INVALID name the models or the field: the server's words say more.
  const words = Object.hasOwn(CURATOR_ERRORS, code) ? CURATOR_ERRORS[code] : undefined;
  return words ? { status: e.status, code, message: words } : err;
}

/** A run's stop reason as a tag: why a hosted run ended early. One this dashboard doesn't know shows as itself. */
export const STOP_TONE: Record<"budget" | "auth" | "credit" | "rate_limit" | "provider", { tone: BadgeState; word: string; help: string }> = {
  budget: { tone: "warn", word: "Paused at the budget", help: "The run reached its cap or the month's. What it committed stays; the rest waits for the next run." },
  auth: { tone: "error", word: "Key refused", help: "The provider refused the model key. Save a new one under Nightly curation." },
  credit: { tone: "error", word: "Out of credit", help: "The provider's credit ran out. Add credit there, or save another key." },
  rate_limit: { tone: "warn", word: "Rate limited", help: "The provider was rate limiting. The rest waits for the next run." },
  provider: { tone: "error", word: "Provider failed", help: "The model provider failed. The rest waits for the next run." },
};

export function stopTone(stop: string): { tone: BadgeState; word: string; help: string } {
  const known = Object.hasOwn(STOP_TONE, stop) ? STOP_TONE[stop as keyof typeof STOP_TONE] : undefined;
  return known ?? { tone: "na", word: `Stopped: ${stop.slice(0, 40)}`, help: "What it committed stays; the rest waits in the inbox." };
}

/** A run's cost in dollars, from the relay's micro-dollars. */
export const runCost = (cost: { micros: number; calls: number } | undefined) => (cost ? { usd: cost.micros / 1e6, calls: cost.calls } : undefined);

// ── Words for states that aren't setup items ───────────────────────────────

export const VAULT_TONE: Record<"bootstrapping" | "ready" | "disconnected", { tone: BadgeState; word: string }> = {
  ready: { tone: "done", word: "Ready" },
  bootstrapping: { tone: "wait", word: "Setting up" },
  disconnected: { tone: "error", word: "Disconnected" },
};

export const OUTCOME_TONE: Record<"done" | "expired" | "aborted", { tone: BadgeState; word: string; help: string }> = {
  done: { tone: "done", word: "Finished", help: "The run went through the inbox." },
  expired: { tone: "warn", word: "Expired", help: "The curator stopped answering and its lease ran out. What it committed stays; the rest waits in the inbox." },
  aborted: { tone: "error", word: "Aborted", help: "Stopped before the end. What it committed stays; the rest waits in the inbox." },
};

/** A run's outcome as a tag. One this dashboard doesn't know (a newer Worker's, after a rollback) shows as itself, never breaks the page. */
export function outcomeTone(outcome: string): { tone: BadgeState; word: string; help: string } {
  const known = Object.hasOwn(OUTCOME_TONE, outcome) ? OUTCOME_TONE[outcome as keyof typeof OUTCOME_TONE] : undefined;
  return known ?? { tone: "na", word: outcome.slice(0, 40) || "Unknown", help: "What it committed stays; the rest waits in the inbox." };
}

// ── Sharing ────────────────────────────────────────────────────────────────

/** What each role may do, in both voices, for pickers and the members list. */
export const ROLE_WORDS: Record<"owner" | "member" | "viewer", { word: Wording; help: Wording }> = {
  owner: { word: ["Owner", "Keeper"], help: ["Everything: invites people, removes them, the repository, keys and curation.", "Holds the campaign: seats players, the repository, keys and curation."] },
  member: { word: ["Member", "Player"], help: ["Adds memories and settles disputes as themselves, and connects their own agents.", "Plays as their own character: adds to the record, rules on disputes, brings their own agents."] },
  viewer: { word: ["Viewer", "Spectator"], help: ["Reads everything here, changes nothing.", "Watches the table, changes nothing."] },
};

/**
 * The vault's humans someone new can be: not the person inviting (they act as `me`), and not one a
 * member already is.
 */
export function freeHumans(humans: readonly string[], members: readonly { human?: string }[], me?: string): string[] {
  const taken = new Set(members.flatMap((m) => (m.human ? [m.human] : [])));
  return humans.filter((h) => h !== me && !taken.has(h));
}

/** A human id from a GitHub login: lowercase letters, digits and dashes. */
export function humanIdFor(login: string): string {
  return login
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** GitHub's login rule (the server checks it again). */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Why an invite form can't be sent yet; undefined when it can. */
export function inviteProblem(f: { login: string; human: string }): string | undefined {
  const login = f.login.trim().replace(/^@/, "");
  if (login && !GITHUB_LOGIN.test(login)) return "That isn't a GitHub username.";
  return agentIdProblem(f.human) ? "Who they are in the vault: lowercase letters, digits and dashes, like game-master." : undefined;
}

// ── Connections ────────────────────────────────────────────────────────────

/** One thing connected to the vault, a key or a sign-in app, in plain words with the exact details beside them. */
export interface ConnectionRow {
  id: string;
  source: "key" | "app";
  /** What the person called it (a key's label, an app's name). */
  name: string;
  /** Who it writes as: one agent, any agent that names itself, or the curator. */
  actsAs: { agent: string } | { shared: true } | { curator: true };
  /** For a shared connection: the agents that have spoken through it, from the vault's name claims. */
  agents: { agent: string; since: string }[];
  /** What it may do, in words. */
  can: string;
  created: string;
  lastUsed?: string;
  /** The exact kind and scopes, for the details. */
  kind: "single-agent key" | "shared key" | "curator key" | "sign-in app";
  /** What it may do now: an app's curating shows only while its switch is on. */
  scopes: string[];
  /** A sign-in app the viewer (an owner) can let curate or not, and whether it may now. */
  curating?: { may: boolean; on: boolean };
}

/** The vault's keys and the sign-in apps connected to it (apps for other vaults are left out), newest first. */
export function connectionRows(keys: readonly HostedKeyInfo[], apps: readonly HostedConnectedApp[], vaultId: string | undefined, claims: readonly HostedAgentClaim[] = []): ConnectionRow[] {
  const spoken = (credential: string) => claims.filter((c) => c.credential === credential).map(({ agent, since }) => ({ agent, since }));
  const fromKeys = keys.map((k): ConnectionRow => ({
    id: k.id,
    source: "key",
    agents: spoken(`key:${k.id}`),
    name: k.label,
    actsAs: k.kind === "curator" ? { curator: true } : k.kind === "agent" || !k.agent ? { shared: true } : { agent: k.agent },
    can: accessOf(k.scopes).title,
    created: k.created,
    ...(k.lastUsed ? { lastUsed: k.lastUsed } : {}),
    kind: k.kind === "curator" ? "curator key" : k.kind === "agent" ? "shared key" : "single-agent key",
    scopes: k.scopes,
  }));
  const fromApps = apps
    .filter((a) => !a.vault || a.vault === vaultId)
    .map((a): ConnectionRow => {
      // The token carries curate as the most the app may do; it counts only while the owner's switch is on.
      const scopes = a.curate ? a.scopes : a.scopes.filter((s) => s !== "curate");
      return {
        id: a.id,
        source: "app",
        agents: spoken(`oauth:${a.id}`),
        name: a.client,
        actsAs: a.curate && !a.agent ? { curator: true } : a.agent ? { agent: a.agent } : { shared: true },
        can: accessOf(scopes).title,
        created: a.created,
        kind: "sign-in app",
        scopes,
        ...(a.mayCurate ? { curating: { may: true, on: a.curate } } : {}),
      };
    });
  return [...fromKeys, ...fromApps].sort((a, b) => b.created.localeCompare(a.created));
}
