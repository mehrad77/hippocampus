// Session Zero's pure parts: the steps, state words, validation, and the snippets the wizard builds
// itself (the server builds the rest). No DOM here, so it is unit-tested in model.test.ts.
import type { GitStatus, LocalSetupStatus, SessionInfo, SetupItem, SetupState, Snippet } from "@hippocampus/dashboard";
import type { IconName } from "../../lib/icons.ts";

export type StepId = "welcome" | "vault" | "party" | "secrets" | "llm" | "git" | "agents" | "schedule" | "remote" | "done";

export interface StepDef {
  id: StepId;
  title: string;
  icon: IconName;
  /** Locked until a vault exists. */
  needsVault: boolean;
  lede: string;
}

export const STEPS: readonly StepDef[] = [
  {
    id: "welcome",
    title: "Welcome",
    icon: "d20",
    needsVault: false,
    lede: "Session Zero is the evening before a campaign starts, when the table agrees on the world, the party and the rules. Here it takes a few minutes, and every step says what it changes on this machine.",
  },
  {
    id: "vault",
    title: "The vault",
    icon: "codex",
    needsVault: false,
    lede: "The vault is your campaign wiki: a folder of Markdown notes you can open in Obsidian. Everything else builds on it.",
  },
  {
    id: "party",
    title: "The party",
    icon: "party",
    needsVault: true,
    lede: "Every agent that remembers things gets a character sheet: who it is, what it handles, and where its word counts as canon.",
  },
  {
    id: "secrets",
    title: "Secrets key",
    icon: "key",
    needsVault: true,
    lede: "Passport numbers, account ids and passwords are sealed with age encryption before they are written into the vault.",
  },
  {
    id: "llm",
    title: "Curator model",
    icon: "brain",
    needsVault: false,
    lede: "Each night a curator model reads the inbox and decides what becomes canon. A small local model is enough.",
  },
  {
    id: "git",
    title: "Git & GitHub",
    icon: "github",
    needsVault: true,
    lede: "A private GitHub repository backs the vault up, and lets agents elsewhere reach it.",
  },
  {
    id: "agents",
    title: "Connect agents",
    icon: "link",
    needsVault: true,
    lede: "Each agent connects as itself, so what it remembers is filed under its name and weighed by its authority.",
  },
  {
    id: "schedule",
    title: "Nightly sleep",
    icon: "moonStars",
    needsVault: true,
    lede: "The curator sleeps once a night: while you rest, it consolidates the day's inbox into canon.",
  },
  {
    id: "remote",
    title: "Remote",
    icon: "cloud",
    needsVault: false,
    lede: "Optional. Put your memory on a Cloudflare Worker so hosted assistants (Claude.ai, ChatGPT) and agents away from this machine can reach it.",
  },
  {
    id: "done",
    title: "The table is set",
    icon: "tavern",
    needsVault: true,
    lede: "Everything a campaign needs is in place. The rest happens at the table.",
  },
];

/** What every local step body gets. */
export interface StepProps {
  session: SessionInfo;
  status: LocalSetupStatus;
  hasVault: boolean;
  item?: SetupItem;
}

export function parseStep(hash: string): StepId | undefined {
  const id = hash.replace(/^#/, "");
  return STEPS.some((s) => s.id === id) ? (id as StepId) : undefined;
}

export function stepDef(id: StepId): StepDef {
  return STEPS.find((s) => s.id === id) ?? STEPS[0]!;
}

export function stepIndex(id: StepId): number {
  return Math.max(0, STEPS.findIndex((s) => s.id === id));
}

export function neighbors(id: StepId): { prev?: StepDef; next?: StepDef } {
  const i = stepIndex(id);
  return { prev: STEPS[i - 1], next: STEPS[i + 1] };
}

export function isLocked(step: StepDef, hasVault: boolean): boolean {
  return step.needsVault && !hasVault;
}

// ── States ──────────────────────────────────────────────────────────────────

export type BadgeState = SetupState | "locked";

/** Each state as a word and a glyph (24×24 path), so color is never the only signal. */
export const STATE_META: Record<BadgeState, { word: string; help: string; path: string }> = {
  done: { word: "Done", help: "In order", path: "M5 12.5 10 17l9-10" },
  todo: { word: "To do", help: "Not done yet", path: "M12 4l8 8-8 8-8-8 8-8Z" },
  warn: { word: "Warning", help: "Works, but needs a look", path: "M12 4 2.5 20h19L12 4Zm0 6v5m0 3v.5" },
  error: { word: "Problem", help: "Broken: fix this first", path: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5m0 3v.5" },
  optional: { word: "Optional", help: "Nice to have", path: "M12 6v12M6 12h12" },
  na: { word: "Not needed", help: "Doesn't apply to this vault", path: "M6 12h12" },
  locked: { word: "Locked", help: "Needs a vault first", path: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5V11Zm7 4v2" },
};

/** A step's badge: its status item's state, `locked` without a vault, nothing for welcome/done. */
export function stepState(id: StepId, items: readonly SetupItem[], hasVault: boolean): BadgeState | undefined {
  if (isLocked(stepDef(id), hasVault)) return "locked";
  const item = items.find((i) => i.id === id);
  if (item) return item.state;
  return id === "vault" && !hasVault ? "todo" : undefined;
}

/** Where to land without a hash: Welcome before there is a vault, else the first step that needs you. */
export function defaultStep(items: readonly SetupItem[], hasVault: boolean): StepId {
  if (!hasVault) return "welcome";
  const steps = STEPS.filter((s) => s.id !== "welcome" && s.id !== "done");
  for (const want of ["error", "todo", "warn"] as const) {
    const hit = steps.find((s) => items.find((i) => i.id === s.id)?.state === want);
    if (hit) return hit.id;
  }
  return "done";
}

export function tally(items: readonly SetupItem[]): { done: number; total: number; attention: number } {
  const counted = items.filter((i) => i.state !== "na" && i.state !== "optional");
  return {
    done: counted.filter((i) => i.state === "done").length,
    total: counted.length,
    attention: items.filter((i) => i.state === "error" || i.state === "warn" || i.state === "todo").length,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Same rule as core's AGENT_ID, so ids work in the vault, the Worker and OAuth consent alike. */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function agentIdProblem(raw: string, taken: readonly string[] = []): string | undefined {
  const id = raw.trim();
  if (!id) return "Give it an id.";
  if (/[A-Z]/.test(id)) return "Use lowercase letters.";
  if (!AGENT_ID.test(id)) return "Lowercase letters, digits and dashes, starting with a letter or digit (at most 63).";
  if (taken.includes(id)) return `“${id}” is already taken.`;
  return undefined;
}

export function domainProblem(raw: string, existing: readonly string[] = []): string | undefined {
  const d = raw.trim().toLowerCase();
  if (!d) return "Type a domain first.";
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(d)) return "Lowercase letters, digits and dashes (e.g. housing).";
  if (existing.includes(d)) return `“${d}” is already listed.`;
  return undefined;
}

export function isTimeZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/** `owner/name`, as GitHub spells repositories. */
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A Worker URL as https (http only for a local `wrangler dev`), without a trailing slash; undefined if unusable. */
export function normalizeUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return undefined;
  if (url.username || url.password) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// ── Snippets the wizard builds ──────────────────────────────────────────────

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A path safe to paste into a shell, keeping `~/` expandable. */
export function shellPath(p: string): string {
  if (/^[\w@%+=:,./~-]+$/.test(p)) return p;
  if (p.startsWith("~/")) return `~/${quote(p.slice(2))}`;
  return quote(p);
}

/** A repository name from the vault folder: `~/vaults/lisbon-arc` → `lisbon-arc`. */
export function repoName(dir: string): string {
  const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "my-campaign";
}

/** A remote's path as `owner/name`. */
export function repoSlug(path: string): string {
  return path.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

export const migrateCommand = (dir: string) => `npx @mehrad77/hippocampus -v ${shellPath(dir)} migrate`;

/** How to put a vault without a remote into a new private GitHub repo. The dashboard never runs these. */
export function publishSnippets(git: GitStatus | undefined, dir: string, opts: { owner?: string; name?: string } = {}): Snippet[] {
  const name = opts.name?.trim() || repoName(dir);
  const owner = opts.owner?.trim() || "<you>";
  const fresh = !git?.repo;
  const branch = fresh ? "main" : (git?.branch ?? "main");
  const lines = [`cd ${shellPath(dir)}`];
  if (fresh) lines.push("git init -b main");
  if (fresh || (git?.dirty ?? 0) > 0) lines.push(`git add -A && git commit -m "chore: new vault"`);
  if (git?.ghAvailable) {
    return [
      {
        label: "Create a private repository and push (GitHub CLI)",
        lang: "bash",
        code: [...lines, `gh repo create ${name} --private --source . --push`].join("\n"),
        note: "--private is the point: your memory must never be public. gh uses the account it is signed in to (check with gh auth status).",
      },
    ];
  }
  return [
    {
      label: "Then link the empty repository and push",
      lang: "bash",
      code: [...lines, `git remote add origin git@github.com:${owner}/${name}.git`, `git push -u origin ${branch}`].join("\n"),
      note: owner === "<you>" ? "Replace <you> with your GitHub account, or type it above." : undefined,
    },
  ];
}

/** Commands to bring a vault with a remote back in sync, from git's own counts. */
export function syncSnippets(git: GitStatus, dir: string): Snippet[] {
  if (!git.remote) return [];
  const out: Snippet[] = [];
  const cd = `cd ${shellPath(dir)}`;
  const dirty = git.dirty ?? 0;
  if (dirty > 0) {
    out.push({
      label: `Commit ${dirty} changed file${dirty === 1 ? "" : "s"}`,
      lang: "bash",
      code: `${cd}\ngit add -A && git commit -m "chore: vault edits"`,
      note: "Look at git status first if you are unsure what changed.",
    });
  }
  if ((git.behind ?? 0) > 0) out.push({ label: `Pull ${git.behind} new commit${git.behind === 1 ? "" : "s"}`, lang: "bash", code: `${cd}\ngit pull --rebase` });
  if (!git.upstream) out.push({ label: "Push and track the remote branch", lang: "bash", code: `${cd}\ngit push -u ${git.remote.name} ${git.branch ?? "main"}` });
  else if ((git.ahead ?? 0) > 0 || dirty > 0) out.push({ label: "Push", lang: "bash", code: `${cd}\ngit push` });
  return out;
}

export const pad2 = (n: number) => String(n).padStart(2, "0");
export const hhmm = (hour: number, minute: number) => `${pad2(hour)}:${pad2(minute)}`;

/** `age1qz…k7n3`: enough to compare by eye, never the whole key. */
export function truncateKey(key: string | undefined): string {
  if (!key) return "";
  return key.length <= 14 ? key : `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** A token id (its SHA-256) shortened for tables. */
export const shortId = (id: string) => id.slice(0, 10);

// ── Curator and embeddings providers ────────────────────────────────────────

export interface ProviderDef {
  id: string;
  label: string;
  /** Default OpenAI-compatible base URL; `required` when the user must give one. */
  baseURL?: string | "required";
  key: "none" | "optional" | "required";
  /** The env var the key can also come from. */
  keyEnv?: string;
  modelHint: string;
}

export const LLM_PROVIDERS: readonly ProviderDef[] = [
  { id: "lmstudio", label: "LM Studio (on this machine)", baseURL: "http://localhost:1234/v1", key: "none", modelHint: "qwen/qwen3.5-9b" },
  { id: "ollama", label: "Ollama (on this machine)", baseURL: "http://localhost:11434/v1", key: "none", modelHint: "a model from `ollama list`" },
  { id: "openai-compatible", label: "Any OpenAI-compatible server", baseURL: "required", key: "optional", modelHint: "the server's model id" },
  { id: "anthropic", label: "Anthropic API", key: "required", keyEnv: "ANTHROPIC_API_KEY", modelHint: "claude-haiku-4-5-20251001" },
  { id: "xai", label: "xAI API", key: "required", keyEnv: "XAI_API_KEY", modelHint: "grok-4-fast" },
];

export const EMBED_PROVIDERS: readonly ProviderDef[] = [
  { id: "off", label: "Off: keyword search only", key: "none", modelHint: "" },
  { id: "lmstudio", label: "LM Studio (on this machine)", baseURL: "http://localhost:1234/v1", key: "none", modelHint: "an embedding model, e.g. bge-m3" },
  { id: "ollama", label: "Ollama (on this machine)", baseURL: "http://localhost:11434/v1", key: "none", modelHint: "bge-m3" },
  { id: "openai-compatible", label: "Any OpenAI-compatible embeddings API", baseURL: "required", key: "optional", modelHint: "the API's embedding model id" },
];

export function providerDef(list: readonly ProviderDef[], id: string): ProviderDef | undefined {
  return list.find((p) => p.id === id);
}

/** The provider a probed model server speaks for. */
export function providerForServer(name: string): string {
  if (/lm\s*studio/i.test(name)) return "lmstudio";
  if (/ollama/i.test(name)) return "ollama";
  return "openai-compatible";
}

// ── Remote ──────────────────────────────────────────────────────────────────

export const PLACEHOLDER_WORKER = "https://hippocampus.<your-subdomain>.workers.dev";

export function workerBase(url: string | undefined): string {
  return normalizeUrl(url ?? "") ?? PLACEHOLDER_WORKER;
}

export interface DeployStep {
  title: string;
  detail: string;
  snippets: Snippet[];
}

/** The guided Worker deploy, with the user's Worker URL filled in when known. Nothing here is run for you. */
export function workerDeploySteps(url: string | undefined): DeployStep[] {
  const base = workerBase(url);
  const put = (name: string) => `pnpm exec wrangler secret put ${name}`;
  return [
    {
      title: "Create the Worker's storage",
      detail: "From a clone of the Hippocampus repository (pnpm install done), signed in to Cloudflare with wrangler login. Paste the three ids it prints into apps/worker/wrangler.jsonc, and keep that edit local.",
      snippets: [
        {
          label: "Search index, agent tokens and OAuth grants",
          lang: "bash",
          code: ["cd apps/worker", "pnpm exec wrangler d1 create hippocampus-index", "pnpm exec wrangler kv namespace create TOKENS", "pnpm exec wrangler kv namespace create OAUTH_KV"].join("\n"),
        },
      ],
    },
    {
      title: "Point it at your private vault",
      detail: "Each command asks for the value. GITHUB_REPO is owner/name of the vault repository. GITHUB_TOKEN is a fine-grained token with Contents: read and write on that repository only.",
      snippets: [{ label: "Vault access", lang: "bash", code: [put("GITHUB_REPO"), put("GITHUB_TOKEN")].join("\n") }],
    },
    {
      title: "Create a GitHub OAuth app",
      detail: "GitHub → Settings → Developer settings → OAuth Apps → New OAuth App. Use the Worker URL as the homepage and this callback. The dashboard signs in at …/callback/dashboard, which GitHub accepts under the same callback.",
      snippets: [
        { label: "Authorization callback URL", lang: "text", code: `${base}/oauth/github/callback` },
        { label: "Used by the dashboard sign-in (no separate app needed)", lang: "text", code: `${base}/oauth/github/callback/dashboard` },
      ],
    },
    {
      title: "Turn on sign-in",
      detail: `HIPPO_PUBLIC_URL is ${base}. HIPPO_OWNERS is your GitHub login (comma-separate several); only these accounts can sign in and connect apps. The last two come from the OAuth app.`,
      snippets: [{ label: "Sign-in settings", lang: "bash", code: [put("HIPPO_PUBLIC_URL"), put("HIPPO_OWNERS"), put("GITHUB_OAUTH_CLIENT_ID"), put("GITHUB_OAUTH_CLIENT_SECRET")].join("\n") }],
    },
    {
      title: "Deploy",
      detail: "From the repository root. Wrangler prints the Worker's URL: paste it above and check it.",
      snippets: [{ label: "Deploy the Worker", lang: "bash", code: "pnpm --filter @hippocampus/worker run deploy" }],
    },
  ];
}

export const TOKEN_SCOPES: readonly { id: "read" | "remember" | "quest"; label: string; help: string }[] = [
  { id: "read", label: "Read", help: "Recall and read the vault. Every token needs it." },
  { id: "remember", label: "Remember", help: "File new memories into the inbox." },
  { id: "quest", label: "Quest", help: "Update quests: objectives, clocks and deadlines." },
];

// ── Errors ──────────────────────────────────────────────────────────────────

/** An API failure in plain words. 501 means this runtime can't do it; NO_VAULT means Session Zero isn't done. */
export function describeError(err: unknown): { title: string; message: string; noVault: boolean; unsupported: boolean } {
  const e = (typeof err === "object" && err ? err : {}) as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = typeof e.code === "string" ? e.code : undefined;
  const message = typeof e.message === "string" && e.message ? e.message : String(err);
  if (status === 501) return { title: "Not available here", message: `${message.replace(/\.$/, "")}. This dashboard can't do that from where it runs; the guides show how to do it by hand.`, noVault: false, unsupported: true };
  if (status === 409 && code === "NO_VAULT") return { title: "No vault yet", message: "Create or open a vault first.", noVault: true, unsupported: false };
  if (status === 0 || code === "NETWORK") return { title: "Can't reach the dashboard server", message: "Is hippo dashboard still running?", noVault: false, unsupported: false };
  return { title: "That didn't work", message, noVault: false, unsupported: false };
}
