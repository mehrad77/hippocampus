// Session Zero on the hosted app, its pure parts: the onboarding steps and when each unlocks, the
// repo picker's verdicts, the campaign draft, and the curator recipes. No DOM here, so it is
// unit-tested in hosted.test.ts.
import type { HostedInitRequest, HostedKeyInfo, Snippet } from "@hippocampus/dashboard";
import type { IconName } from "../../lib/icons.ts";
import type { HostedRepoView, HostedStatus } from "../../lib/types.ts";
import { agentIdProblem, isTimeZone, type BadgeState, type Wording } from "./model.ts";

export type HostedProvider = "github" | "gitlab";

export type HostedStepId = "access" | "create" | "install" | "repo" | "campaign" | "init" | "agents" | "curator" | "done";

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
    id: "create",
    title: ["Create a repo", "Make a vault repo"],
    icon: "github",
    lede: ["Your memory lives in a GitHub repository that you own: private, and empty to start with.", "The campaign lives in a GitHub repository that you own: private, and empty to start with."],
  },
  {
    id: "install",
    title: ["Install the app", "Install the app"],
    icon: "link",
    lede: ["The Hippocampus GitHub App reads and writes that one repository for you, and nothing else.", "The Hippocampus GitHub App reads and writes that one repository for you, and nothing else."],
  },
  {
    id: "repo",
    title: ["Pick the repo", "Pick the repo"],
    icon: "codex",
    lede: ["Choose which of the app's repositories becomes your vault.", "Choose which of the app's repositories becomes the campaign's vault."],
  },
  {
    id: "campaign",
    title: ["Name it", "The campaign"],
    icon: "scroll",
    lede: [
      "A name, your id, your time zone and the areas your agents work in. Plus an optional key for secret facts, made in this browser.",
      "The campaign's name, your id, your time zone and its lanes. Plus an optional key for secrets, forged in this browser.",
    ],
  },
  {
    id: "init",
    title: ["Set up the vault", "Open the vault"],
    icon: "sparkle",
    lede: ["One commit puts the vault template into your repository. Check your choices, then go.", "One commit lays the campaign wiki into your repository. Check your choices, then begin."],
  },
  {
    id: "agents",
    title: ["Connect agents", "Gather the party"],
    icon: "party",
    lede: [
      "Give your agents the vault's address and a key, or connect Claude.ai and ChatGPT with a GitHub sign-in.",
      "Give the party the vault's address and a key, or seat Claude.ai and ChatGPT with a GitHub sign-in.",
    ],
  },
  {
    id: "curator",
    title: ["Set up curation", "Appoint a curator"],
    icon: "moonStars",
    lede: [
      "Your best agent turns the inbox into confirmed records, on a schedule you choose.",
      "Your best agent sleeps on the party's notes and turns them into canon, on a schedule you choose.",
    ],
  },
  {
    id: "done",
    title: ["All set", "The table is set"],
    icon: "tavern",
    lede: ["Everything is in place. From here on, you use the dashboard day to day.", "Everything a campaign needs is in place. The rest happens at the table."],
  },
];

/** The steps' words for GitLab: the same steps, a different host. */
const GITLAB_WORDS: Partial<Record<HostedStepId, Pick<HostedStepDef, "title" | "icon" | "lede">>> = {
  create: {
    title: ["Create a project", "Make a vault project"],
    icon: "link",
    lede: ["Your memory lives in a GitLab project that you own: private, and empty to start with.", "The campaign lives in a GitLab project that you own: private, and empty to start with."],
  },
  install: {
    title: ["Connect GitLab", "Connect GitLab"],
    icon: "link",
    lede: ["Hippocampus signs in to GitLab as you, to read and write that one project for you, and nothing else.", "Hippocampus signs in to GitLab as you, to read and write that one project for you, and nothing else."],
  },
  repo: {
    title: ["Pick the project", "Pick the project"],
    icon: "codex",
    lede: ["Choose which of your GitLab projects becomes your vault.", "Choose which of your GitLab projects becomes the campaign's vault."],
  },
};

/** The step definitions as worded for the host the vault will live on. */
export const stepsFor = (provider: HostedProvider): readonly HostedStepDef[] => (provider === "gitlab" ? HOSTED_STEPS.map((s) => ({ ...s, ...GITLAB_WORDS[s.id] })) : HOSTED_STEPS);

export function parseHostedStep(hash: string): HostedStepId | undefined {
  const id = hash.replace(/^#/, "");
  return HOSTED_STEPS.some((s) => s.id === id) ? (id as HostedStepId) : undefined;
}

export function hostedStepDef(id: HostedStepId, provider: HostedProvider = "github"): HostedStepDef {
  const steps = stepsFor(provider);
  return steps.find((s) => s.id === id) ?? steps[0]!;
}

export function hostedIndex(id: HostedStepId): number {
  return Math.max(0, HOSTED_STEPS.findIndex((s) => s.id === id));
}

export function hostedNeighbors(id: HostedStepId): { prev?: HostedStepDef; next?: HostedStepDef } {
  const i = hostedIndex(id);
  return { prev: HOSTED_STEPS[i - 1], next: HOSTED_STEPS[i + 1] };
}

/** What the steps depend on: the server's status, the repo picked here, and whether the campaign form is ready. */
export interface HostedContext {
  status: HostedStatus;
  picked?: number;
  draftReady: boolean;
  /** The host the person chose in this browser; the vault's own, once there is one, wins. */
  provider?: HostedProvider;
}

/** Which host the flow is about: the vault's, else the person's choice, else wherever they already connected. GitHub unless GitLab is offered. */
export function hostedProvider(ctx: HostedContext): HostedProvider {
  const s = ctx.status;
  if (s.vault?.provider) return s.vault.provider;
  if (!s.providers?.includes("gitlab")) return "github";
  if (ctx.provider) return ctx.provider;
  return s.gitlab?.connected && !s.installation ? "gitlab" : "github";
}

/** The repos the person can pick from, on the chosen host. */
export function hostedRepos(ctx: HostedContext): HostedRepoView[] {
  const provider = hostedProvider(ctx);
  const repos = provider === "gitlab" ? (ctx.status.gitlab?.repos ?? []) : (ctx.status.installation?.repos ?? []);
  const mine = new Set((ctx.status.vaults ?? []).filter((v) => (v.provider ?? "github") === provider).map((v) => v.fullName.toLowerCase()));
  return mine.size ? repos.map((r) => (mine.has(r.fullName.toLowerCase()) ? { ...r, yours: true } : r)) : repos;
}

/** Where the setup status comes from; `?add` also lists GitLab projects beside a ready vault. */
export const statusKey = (adding: boolean) => (adding ? "/setup/status?add" : "/setup/status");

/** The status as a new vault's setup sees it: nothing of the vault the tab shows, so the wizard starts fresh. */
export function forNewVault(s: HostedStatus): HostedStatus {
  const { vault: _vault, keys: _keys, curatorActions: _actions, ...rest } = s;
  return { ...rest, items: s.items.filter((i) => i.id === "access") };
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
export function hostedConnected(ctx: HostedContext): boolean {
  const s = ctx.status;
  return hostedProvider(ctx) === "gitlab" ? !!s.gitlab?.connected : !!s.installation;
}

export const hasKey = (keys: readonly HostedKeyInfo[] | undefined, kinds: readonly HostedKeyInfo["kind"][]) => (keys ?? []).some((k) => kinds.includes(k.kind));

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
  if (id === "create" || id === "install" || id === "campaign") return undefined;
  if (id === "repo" || id === "init") {
    if (ready || v?.status === "bootstrapping") return undefined;
    if (!hostedConnected(ctx)) {
      const gitlab = hostedProvider(ctx) === "gitlab";
      if (gitlab) return v ? ["Connect GitLab again first.", "Connect GitLab again first."] : ["Connect GitLab first.", "Connect GitLab first."];
      return v ? ["Install the app on your repo again first.", "Install the app on your repo again first."] : ["Install the app on your repo first.", "Install the app on your repo first."];
    }
    if (id === "init" && !pickedRepo(ctx)) return ["Pick the repo first.", "Pick the repo first."];
    if (id === "init" && !ctx.draftReady) return ["Fill in the campaign step first.", "Settle the campaign first."];
    return undefined;
  }
  return ready ? undefined : ["This needs your vault. Set it up first; everything after it unlocks.", "This needs the vault. Open it first; everything after it unlocks."];
}

/** A step's badge: `locked` until it can be used, then how it stands. Nothing for the last step. */
export function hostedStepState(id: HostedStepId, ctx: HostedContext): BadgeState | undefined {
  if (hostedLock(id, ctx)) return "locked";
  const s = ctx.status;
  const v = s.vault;
  const ready = v?.status === "ready";
  switch (id) {
    case "access":
      return s.account.status === "approved" ? "done" : s.account.status === "denied" ? "error" : s.account.requested ? "wait" : "todo";
    case "create":
      return hostedConnected(ctx) || v ? "done" : "todo";
    case "install": {
      const link = hostedProvider(ctx) === "gitlab" ? s.gitlab : s.installation;
      if (ready || (hostedConnected(ctx) && !link?.error)) return "done";
      if (link?.error && hostedConnected(ctx)) return "warn";
      return v?.status === "disconnected" ? "error" : "todo";
    }
    case "repo":
      return ready || pickedRepo(ctx) ? "done" : "todo";
    case "campaign":
      return ready || ctx.draftReady ? "done" : "todo";
    case "init":
      return ready ? "done" : v?.status === "bootstrapping" ? "wait" : v?.status === "disconnected" ? "error" : "todo";
    case "agents":
      return hasKey(s.keys, ["agent", "bound"]) ? "done" : "todo";
    case "curator":
      return hasKey(s.keys, ["curator"]) || s.curatorActions ? "done" : "todo";
    case "done":
      return undefined;
  }
}

/** Where to land without a hash: the first step that needs you. */
export function hostedDefaultStep(ctx: HostedContext): HostedStepId {
  const s = ctx.status;
  const v = s.vault;
  if (s.account.status !== "approved") return "access";
  if (v?.status === "ready") return !hasKey(s.keys, ["agent", "bound"]) ? "agents" : !hasKey(s.keys, ["curator"]) && !s.curatorActions ? "curator" : "done";
  if (v?.status === "bootstrapping") return "init";
  if (hostedConnected(ctx)) return !pickedRepo(ctx) ? "repo" : ctx.draftReady ? "init" : "campaign";
  if (v?.status === "disconnected") return "install";
  return "create";
}

/** Which server status item speaks for a step ("Right now: …"). */
export const STEP_ITEM: Partial<Record<HostedStepId, string>> = { access: "access", install: "install", repo: "vault", init: "vault", agents: "keys" };

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

export function newDraft(timezone: string): CampaignDraft {
  return { campaign: "", human: "player", timezone, domains: [...TEMPLATE_DOMAINS], seed: false, presets: [], secrets: "create", saved: false };
}

export function draftProblems(d: CampaignDraft): { campaign?: string; human?: string; timezone?: string; secrets?: string } {
  const campaign = d.campaign.trim();
  return {
    campaign: !campaign ? "Give it a name." : campaign.length > 120 ? "Up to 120 characters." : undefined,
    human: agentIdProblem(d.human),
    timezone: isTimeZone(d.timezone) ? undefined : "Use a time zone name such as Europe/Lisbon.",
    secrets: d.secrets === "skip" ? undefined : !d.recipient ? "Make the key, or choose to skip it." : !d.saved ? "Save the key file, then tick the box." : undefined,
  };
}

export const draftReady = (d: CampaignDraft) => Object.values(draftProblems(d)).every((p) => !p);

/** The init request for the picked repo. A repo that already holds a vault (`adopt`) is adopted as it is: presets only shape new vaults. */
export function initRequest(d: CampaignDraft, repoId: number, opts: { adopt?: boolean; provider?: HostedProvider } = {}): HostedInitRequest {
  const provider = opts.provider ?? "github";
  return {
    ...(provider === "gitlab" ? { provider } : {}),
    repoId,
    campaign: d.campaign.trim(),
    human: d.human.trim().toLowerCase(),
    timezone: d.timezone.trim(),
    domains: d.domains,
    ...(d.seed ? { seed: "example-relocation" as const } : {}),
    ...(d.presets?.length && !opts.adopt ? { presets: d.presets } : {}),
    ...(d.secrets === "create" && d.recipient ? { recipient: d.recipient } : {}),
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

const PLUGIN_INSTALL = ["claude plugin marketplace add mehrad77/hippocampus", "claude plugin install hippocampus@hippocampus"];
const PLUGIN_NOTE = "Inside a Claude Code session: /plugin marketplace add mehrad77/hippocampus, then /plugin install hippocampus@hippocampus.";

/** The Claude Code plugin for everyday agents: the server (from two env vars) plus the memory skill. */
export function agentPluginSnippets(mcpUrl: string): Snippet[] {
  return [
    {
      label: "Claude Code plugin (optional)",
      lang: "bash",
      code: [...PLUGIN_INSTALL, `export HIPPO_MCP_URL=${mcpUrl}`, "export HIPPO_KEY=<your agent key>"].join("\n"),
      note: `The plugin brings the hippocampus server (it reads HIPPO_MCP_URL and HIPPO_KEY) and the /hippocampus:memory skill. ${PLUGIN_NOTE}`,
    },
  ];
}

/** The words a scheduled agent gets when it can't use the plugin's skill or the server's prompt. */
export const SLEEP_PROMPT = "Run the Hippocampus sleep procedure as the vault's curator: call sleep_start with your model name, then answer its questions until the run is done.";

/** How to run the curator by hand and on a schedule. The key stays a placeholder: it's shown only once, when minted. */
export function curatorRecipes(mcpUrl: string): { now: Snippet[]; schedule: Snippet[] } {
  return {
    now: [
      { label: "Install the Claude Code plugin", lang: "bash", code: PLUGIN_INSTALL.join("\n"), note: PLUGIN_NOTE },
      {
        label: "Connect it with the curator key",
        lang: "bash",
        code: [`export HIPPO_MCP_URL=${mcpUrl}`, "export HIPPO_KEY=<your curator key>"].join("\n"),
        note: "In the shell (or profile) Claude Code starts from. On the machine that curates, use the curator key here, not an agent key.",
      },
      {
        label: "Run it, in Claude Code",
        lang: "text",
        code: "/hippocampus:sleep",
        note: "Without the plugin, the server's own prompt does the same: /mcp__hippocampus__sleep (or /mcp__hippocampus-curator__sleep if you added the server as hippocampus-curator).",
      },
    ],
    schedule: [
      {
        label: "Every night with cron (03:30)",
        lang: "bash",
        code: `30 3 * * * HIPPO_MCP_URL=${mcpUrl} HIPPO_KEY=<your curator key> claude -p "/hippocampus:sleep" --allowedTools "mcp__hippocampus__*"`,
        note: "Add it with crontab -e on a machine that's on at that hour, with Claude Code signed in and the plugin installed. Keep the key out of shared files.",
      },
      {
        label: "Claude Code routines, Claude Desktop or Cowork scheduled tasks, Cursor Automations",
        lang: "text",
        code: SLEEP_PROMPT,
        note: "Schedule this prompt daily (or hourly if your agents write a lot), wherever the hippocampus server is connected with the curator key. With the plugin, /hippocampus:sleep works as the prompt too.",
      },
    ],
  };
}

/** What the Actions curator needs in the vault repo, set with the GitHub CLI. */
export function actionsSnippets(repo: string, mcpUrl: string): Snippet[] {
  return [
    {
      label: "Repository secrets",
      lang: "bash",
      code: [`gh secret set HIPPO_CURATOR_KEY --repo ${repo}`, `gh secret set ANTHROPIC_API_KEY --repo ${repo}`].join("\n"),
      note: "Each command asks for the value: the curator key, then an Anthropic API key. Or set them on GitHub: the repo → Settings → Secrets and variables → Actions.",
    },
    {
      label: "Repository variables",
      lang: "bash",
      code: [`gh variable set HIPPO_MCP_URL --repo ${repo} --body ${mcpUrl}`, `gh variable set HIPPO_CURATOR_MODEL --repo ${repo} --body opus`].join("\n"),
      note: "HIPPO_CURATOR_MODEL is optional (sonnet or opus, say); without it the workflow uses sonnet. It runs nightly at 03:23 UTC.",
    },
  ];
}

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

export const KEY_KIND: Record<HostedKeyInfo["kind"], { word: Wording; help: Wording }> = {
  agent: { word: ["Agent key", "Party key"], help: ["Any agent can use it; each names itself when it connects.", "Any party member can carry it; each names itself at the door."] },
  curator: { word: ["Curator key", "Curator's key"], help: ["Runs the nightly update (sleep). It sees secret memories while curating.", "Runs the sleep. It sees sealed memories while curating."] },
  bound: { word: ["Single-agent key", "Bound key"], help: ["Only one agent, with the scopes you choose.", "One party member only, with the scopes you choose."] },
};

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
