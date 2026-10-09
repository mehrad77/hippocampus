import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_PATH, CURRENT_VAULT_VERSION, parseConfig, vaultVersionStatus, type HippoConfig } from "@hippocampus/core";
import { aiSdkLLM, llmConfigFromEnv, pingLLM, sleep } from "@hippocampus/curator";
import {
  HttpError,
  type AgentConnect,
  type GitStatus,
  type Job,
  type LlmServer,
  type LlmSettings,
  type LocalSetupStatus,
  type LocalVaultStatus,
  type ScheduleStatus,
  type SecretsStatus,
  type SetupItem,
  type SetupPort,
  type Snippet,
} from "@hippocampus/dashboard";
import type { Overview } from "@hippocampus/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { readEnvFile, updateEnvFile, type EnvOrigins } from "../env-file.ts";
import { Git, ghAvailable } from "../git.ts";
import { configDir, expandHome, identityFile, indexKey, userEnvFile, type Env } from "../paths.ts";
import { cronLine, installSchedule, launchd, launchdStatus, nextRun, removeSchedule, scheduleLabel, type Launchd, type SleepJob } from "../schedule.ts";
import { githubToken, openIndex, parseRepo } from "../stores.ts";
import { IdentityExistsError, SLUG, initVault, keygen, localRecipient, validTimezone } from "../vault-setup.ts";
import type { ActiveVault, DashboardRuntime } from "./runtime.ts";

export interface LocalSetupOptions {
  runtime: DashboardRuntime;
  origins: EnvOrigins;
  /** Defaults to `process.env`; saved settings are mirrored into it so the next run of a job sees them. */
  env?: Env;
  /** Where `vault-template/` and `seeds/` live. */
  assets: string;
  /** How a scheduled job starts this CLI again. */
  cli: { nodePath: string; cliPath: string; version?: string };
  platform?: NodeJS.Platform;
  launchd?: Launchd;
  fetch?: typeof fetch;
}

const PKG = "@mehrad77/hippocampus";
const LLM_KEYS = ["HIPPO_LLM_PROVIDER", "HIPPO_LLM_MODEL", "HIPPO_LLM_BASE_URL", "HIPPO_LLM_API_KEY"] as const;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const LOCAL_SERVERS = [
  { name: "LM Studio", url: "http://127.0.0.1:1234/v1" },
  { name: "Ollama", url: "http://127.0.0.1:11434/v1" },
];

// ── Input validation ─────────────────────────────────────────────────────────

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\0-\x1f\x7f]/.test(s), "no control characters");

const LocalPath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((p) => !p.includes("\0") && (isAbsolute(p) || p === "~" || p.startsWith("~/")), "use an absolute path, or one starting with ~/")
  .transform((p) => resolve(expandHome(p)));

const Slug = z.string().trim().regex(SLUG, "lowercase letters, digits and dashes");
const Repo = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, "use owner/name")
  .refine((r) => !r.endsWith("/.") && !r.endsWith("/.."), "use owner/name");
const Branch = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._/-]{1,200}$/, "not a branch name")
  .refine((b) => !b.includes("..") && !b.startsWith("/") && !b.startsWith("-"), "not a branch name");
const Secret = z
  .string()
  .trim()
  .min(8)
  .max(1000)
  .regex(/^[\x21-\x7e]+$/, "printable characters without spaces");

function parseUrl(raw: string, opts: { loopbackHttp: boolean }): URL | undefined {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return undefined;
    if (u.protocol === "https:") return u;
    if (u.protocol === "http:" && (opts.loopbackHttp ? LOOPBACK.has(u.hostname) : true)) return u;
    return undefined;
  } catch {
    return undefined;
  }
}

/** A remote Hippocampus (Worker or `serve --http`): https, or http on this machine. No credentials in it. */
const RemoteUrl = z
  .string()
  .trim()
  .max(500)
  .refine((u) => !!parseUrl(u, { loopbackHttp: true }), "use an https:// URL (or http://127.0.0.1 for a local server)")
  .transform((u) => u.replace(/\/+$/, ""));
/** A model server: any http(s) URL (hosted APIs and LAN boxes alike). */
const ServerUrl = z
  .string()
  .trim()
  .max(500)
  .refine((u) => !!parseUrl(u, { loopbackHttp: false }), "use an http(s):// URL without credentials")
  .transform((u) => u.replace(/\/+$/, ""));
const blank = z.literal("").transform(() => undefined);

const VaultRequest = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    dir: LocalPath,
    campaign: oneLine(80),
    human: Slug,
    timezone: z.string().trim().refine(validTimezone, "unknown timezone (use an IANA name like Europe/Lisbon)"),
    domains: z.array(Slug).max(30),
    seed: z.string().trim().max(100).optional(),
    makeDefault: z.boolean().optional(),
  }),
  z.object({ action: z.literal("open"), dir: LocalPath, makeDefault: z.boolean().optional() }),
  z.object({ action: z.literal("github"), repo: Repo, branch: Branch.or(blank).optional(), token: Secret.or(blank).optional(), makeDefault: z.boolean().optional() }),
  z.object({ action: z.literal("mcp"), url: RemoteUrl, token: Secret.or(blank).optional() }),
]);

const LlmRequest = z.object({
  provider: z.enum(["lmstudio", "ollama", "openai-compatible", "anthropic", "xai"]),
  model: oneLine(200),
  baseURL: ServerUrl.or(blank).optional(),
  apiKey: Secret.nullable().optional(),
});

const ScheduleRequest = z.union([
  z.object({ remove: z.literal(true) }),
  z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
]);

const JobRequest = z.object({ kind: z.enum(["sleep-dry-run", "reindex"]), limit: z.number().int().min(1).max(50).optional() });

const RemoteRequest = z.object({
  workerUrl: RemoteUrl.or(z.literal("")).optional(),
  embed: z
    .object({
      provider: z.enum(["lmstudio", "ollama", "openai-compatible", "off"]).or(z.literal("")).optional(),
      baseURL: ServerUrl.or(z.literal("")).optional(),
      model: oneLine(200).or(z.literal("")).optional(),
      apiKey: Secret.nullable().optional(),
    })
    .optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const pad = (n: number) => String(n).padStart(2, "0");
const shellQuote = (s: string) => (/^[A-Za-z0-9_\-./:@=+,%~]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** `""` clears a setting, `undefined` leaves it alone. */
const setting = (v: string | undefined) => (v === undefined ? undefined : v || null);

async function attempt<T>(fn: () => Promise<T> | T): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { error: message(err) };
  }
}

export interface LocalSetupPort extends SetupPort {
  kind: "local";
  status(): Promise<LocalSetupStatus>;
}

/**
 * Session Zero on this machine (`hippo dashboard`): every local route of the setup contract in
 * `@hippocampus/dashboard`'s setup.ts. Writes go only to the chosen vault, the config directory,
 * the LaunchAgent plist and the index cache.
 */
export function localSetup(opts: LocalSetupOptions): LocalSetupPort {
  const { runtime, origins, assets } = opts;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const fetchFn = opts.fetch ?? fetch;
  const ld = opts.launchd ?? launchd();
  const envFile = () => userEnvFile(env);
  const jobs = new Map<string, Job>();
  let running: Job | undefined;

  async function save(updates: Record<string, string | null | undefined>): Promise<void> {
    await updateEnvFile(envFile(), updates);
    origins.apply(updates, env);
  }

  async function open(target: Parameters<DashboardRuntime["open"]>[0]): Promise<ActiveVault> {
    return runtime.open(target);
  }

  /** The current vault's config, read directly so an unsupported format version still reports. */
  async function vaultConfig(a: ActiveVault | undefined): Promise<HippoConfig | undefined> {
    if (!a?.store) return undefined;
    await a.store.refresh?.();
    return parseConfig(await a.store.read(CONFIG_PATH));
  }

  function needStore(what: string): ActiveVault & { store: NonNullable<ActiveVault["store"]> } {
    const a = runtime.vault;
    if (!a) throw new HttpError(409, `Open or create a vault first, then ${what}.`, "NO_VAULT");
    if (!a.store || a.mode === "demo") throw new HttpError(501, `This vault is reached over MCP; ${what} where the vault lives.`, "UNSUPPORTED");
    return a as ActiveVault & { store: NonNullable<ActiveVault["store"]> };
  }

  // ── LLM ──
  function llmSettings(): LlmSettings {
    const cfg = llmConfigFromEnv(env);
    return { provider: cfg.provider, model: cfg.model, baseURL: cfg.baseURL, apiKey: cfg.apiKey ? "set" : "unset", overriddenBy: origins.overriddenBy(LLM_KEYS) };
  }

  async function probe(server: { name: string; url: string }): Promise<LlmServer | undefined> {
    try {
      const res = await fetchFn(`${server.url}/models`, { signal: AbortSignal.timeout(1500), redirect: "error" });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
      return { ...server, models };
    } catch {
      return undefined;
    }
  }

  // ── Git ──
  async function gitStatus(a = runtime.vault): Promise<GitStatus> {
    const gh = await ghAvailable();
    if (a?.target.kind === "github" && a.vault.repo) {
      return { repo: true, branch: a.vault.branch, remote: { name: "github", host: githubHost(), path: a.vault.repo }, ghAvailable: gh };
    }
    if (a?.target.kind !== "dir") return { repo: false, ghAvailable: gh };
    const git = new Git(a.target.dir);
    if (!git.isRepo()) return { repo: false, ghAvailable: gh };
    const [state, remote] = await Promise.all([git.status().catch(() => ({ dirty: 0 })), git.remoteInfo().catch(() => undefined)]);
    return { repo: true, ...state, remote, ghAvailable: gh };
  }

  const githubApi = () => (env.HIPPO_GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const githubHost = () => (env.HIPPO_GITHUB_API_URL ? new URL(env.HIPPO_GITHUB_API_URL).hostname.replace(/^api\./, "") : "github.com");

  async function visibility(): Promise<"public" | "private" | "unknown"> {
    const a = runtime.vault;
    let repo: string | undefined;
    let token: string | undefined;
    if (a?.target.kind === "github") {
      repo = parseRepo(a.target.repo).repo;
      token = a.target.token ?? githubToken(env);
    } else if (a?.target.kind === "dir") {
      const remote = await new Git(a.target.dir).remoteInfo().catch(() => undefined);
      if (!remote || remote.host !== githubHost() || !/^[^/]+\/[^/]+$/.test(remote.path)) return "unknown";
      repo = remote.path;
    }
    if (!repo) return "unknown";
    try {
      // Unauthenticated, GitHub shows public repos only: a 200 means anyone can read the vault.
      const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "hippocampus-dashboard" };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetchFn(`${githubApi()}/repos/${repo}`, { headers, signal: AbortSignal.timeout(5000), redirect: "error" });
      if (res.ok) return token ? (((await res.json()) as { private?: boolean }).private === false ? "public" : "private") : "public";
      if (res.status === 404 && !token) return "private";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  // ── Schedule ──
  async function sleepJob(hour: number, minute: number): Promise<SleepJob | undefined> {
    const a = runtime.vault;
    if (!a || (a.target.kind !== "dir" && a.target.kind !== "github")) return undefined;
    const campaign = (await vaultConfig(a).catch(() => undefined))?.campaign ?? "campaign";
    const label = scheduleLabel(campaign);
    return {
      label,
      ...(a.target.kind === "dir" ? { vault: a.target.dir } : { github: a.target.repo }),
      hour,
      minute,
      nodePath: opts.cli.nodePath,
      cliPath: opts.cli.cliPath,
      version: opts.cli.version,
      logPath: join(configDir(env), "logs", `${label.replace(/^com\.hippocampus\./, "")}.log`),
      configDir: env.HIPPO_CONFIG_DIR ? configDir(env) : undefined,
    };
  }

  async function schedule(): Promise<ScheduleStatus> {
    const job = await sleepJob(3, 30);
    if (!job) return { platform, supported: false, label: "com.hippocampus.sleep", installed: false, cron: "# Open a local vault or a GitHub repo first: sleep runs where the vault lives." };
    if (platform !== "darwin") return { platform, supported: false, label: job.label, installed: false, cron: cronLine(job) };
    const st = await launchdStatus(job.label, ld);
    const hour = st.hour ?? job.hour;
    const minute = st.minute ?? job.minute;
    return {
      platform,
      supported: true,
      label: job.label,
      plistPath: join(ld.agentsDir, `${job.label}.plist`),
      installed: st.installed,
      loaded: st.loaded,
      hour: st.installed ? hour : undefined,
      minute: st.installed ? minute : undefined,
      nextRun: st.installed ? nextRun(hour, minute) : undefined,
      cron: cronLine({ ...job, hour, minute }),
    };
  }

  // ── Jobs ──
  function startJob(kind: Job["kind"], run: (log: (msg: string) => void) => Promise<string>): { id: string } {
    if (running) throw new HttpError(409, "Another job is still running.", "BUSY", { id: running.id });
    const job: Job = { id: randomUUID().slice(0, 8), kind, state: "running", started: new Date().toISOString(), log: [] };
    const log = (msg: string) => {
      for (const line of msg.split("\n")) job.log.push(line);
      if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
    };
    jobs.set(job.id, job);
    for (const old of [...jobs.keys()].slice(0, Math.max(0, jobs.size - 20))) jobs.delete(old);
    running = job;
    void run(log)
      .then(
        (summary) => Object.assign(job, { state: "done", summary }),
        (err: unknown) => {
          log(`✗ ${message(err)}`);
          Object.assign(job, { state: "error", error: message(err) });
        },
      )
      .finally(() => {
        if (running === job) running = undefined;
      });
    return { id: job.id };
  }

  // ── Agents ──
  function snippets(agent: string): Snippet[] {
    const a = runtime.vault;
    const out: Snippet[] = [];
    if (a?.target.kind === "dir" || a?.target.kind === "github") {
      const where = a.target.kind === "dir" ? ["-v", a.target.dir] : ["--github", a.target.repo];
      const args = ["-y", PKG, ...where, "serve", "--agent", agent];
      const note = a.target.kind === "github" ? `Reads HIPPO_GITHUB_TOKEN from ${envFile()} (save it with "make default").` : undefined;
      out.push({ label: "Claude Code", lang: "bash", code: `claude mcp add hippocampus -- npx ${args.map(shellQuote).join(" ")}`, note });
      out.push({ label: "Claude Desktop (claude_desktop_config.json)", lang: "json", code: JSON.stringify({ mcpServers: { hippocampus: { command: "npx", args } } }, null, 2), note });
      out.push({
        label: "Any MCP client over HTTP",
        lang: "text",
        code: `npx ${["-y", PKG, ...where, "serve", "--http", "8765"].map(shellQuote).join(" ")}\n→ http://127.0.0.1:8765/mcp?agent=${agent}`,
        note: "One server for every agent; each picks its id with ?agent=.",
      });
    }
    if (a?.target.kind === "mcp") {
      out.push({
        label: "Claude Code (this MCP server)",
        lang: "bash",
        code: `claude mcp add --transport http hippocampus ${a.target.url} --header "Authorization: Bearer <token for ${agent}>"`,
        note: "Each agent needs its own token, bound to its id.",
      });
    }
    const worker = env.HIPPO_WORKER_URL?.replace(/\/+$/, "");
    if (worker) {
      out.push({
        label: "Claude Code via the Worker",
        lang: "bash",
        code: `claude mcp add --transport http hippocampus ${worker}/mcp --header "Authorization: Bearer <token for ${agent}>"`,
        note: `Mint the token on the Worker: pnpm agent-token create ${agent} --scopes read,remember,quest --remote`,
      });
      out.push({ label: "Claude.ai or ChatGPT connector", lang: "text", code: `${worker}/mcp`, note: "Add it as a custom connector; the Worker's consent page asks which agent it acts as." });
    }
    return out;
  }

  // ── Defaults ──
  function seeds(): string[] {
    try {
      return readdirSync(join(assets, "seeds"), { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(assets, "seeds", d.name, CONFIG_PATH)))
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  function templateDomains(): string[] {
    try {
      const doc = parseYaml(readFileSync(join(assets, "vault-template", CONFIG_PATH), "utf8")) as { domains?: unknown };
      return Array.isArray(doc.domains) ? doc.domains.filter((d): d is string => typeof d === "string") : [];
    } catch {
      return [];
    }
  }

  function suggestedDir(): string {
    for (let i = 1; i < 10; i++) {
      const name = `~/vaults/my-campaign${i > 1 ? `-${i}` : ""}`;
      const dir = expandHome(name);
      if (!existsSync(dir) || readdirSync(dir).length === 0) return name;
    }
    return "~/vaults/my-campaign";
  }

  async function isDefault(a: ActiveVault): Promise<boolean> {
    const saved = await readEnvFile(envFile());
    if (a.target.kind === "dir") return !saved.HIPPO_GITHUB_REPO && !!saved.HIPPO_VAULT && resolve(expandHome(saved.HIPPO_VAULT)) === a.target.dir;
    if (a.target.kind === "github") return saved.HIPPO_GITHUB_REPO === a.target.repo;
    return false;
  }

  // ── Status ──
  async function status(): Promise<LocalSetupStatus> {
    const a = runtime.vault;
    const [config, overview, git, sched, recipientHere] = await Promise.all([
      attempt(() => vaultConfig(a)),
      attempt(() => a?.source.overview() as Promise<Overview> | undefined),
      a ? gitStatus(a) : Promise.resolve(undefined),
      schedule(),
      localRecipient(identityFile(env)),
    ]);
    const cfg = config.value;
    const ov = overview.value;

    let vault: LocalVaultStatus | undefined;
    if (a && a.mode !== "demo") {
      const kind = a.target.kind === "github" ? "github" : a.target.kind === "mcp" ? "mcp" : "dir";
      vault = {
        kind,
        dir: a.vault.dir,
        repo: a.vault.repo,
        branch: a.vault.branch,
        url: a.vault.url,
        version: cfg ? vaultVersionStatus(cfg) : "unknown",
        isDefault: await isDefault(a),
      };
    }
    const recipient = cfg?.secrets.recipient ?? undefined;
    const secrets: SecretsStatus = { identityFile: identityFile(env), identity: existsSync(identityFile(env)), recipient, matches: !!recipient && recipient === recipientHere };
    const llm = llmSettings();
    const party = ov?.party ?? [];
    const unknownAgents = ov?.attention.unknownAgents ?? [];
    const agents: AgentConnect[] = party.map((p) => ({ agent: p.slug, title: p.title, lastSeen: p.lastSeen, snippets: snippets(p.slug) }));
    const embedModel = env.HIPPO_EMBED_MODEL;

    const items: SetupItem[] = [
      vaultItem(a, vault, cfg, config.error ?? overview.error),
      partyItem(a, ov, party.length, unknownAgents),
      secretsItem(a, secrets),
      llmItem(a, llm, LLM_KEYS.some((k) => env[k])),
      gitItem(a, git),
      agentsItem(a, party.length),
      scheduleItem(a, sched, llm.overriddenBy),
      {
        id: "remote",
        title: "Remote (Worker)",
        state: env.HIPPO_WORKER_URL ? "done" : "optional",
        detail: env.HIPPO_WORKER_URL ? `${env.HIPPO_WORKER_URL}${embedModel ? ` · embeddings: ${embedModel}` : ""}` : "Optional: reach your memory from anywhere through a Cloudflare Worker",
        how: "guided",
      },
    ];

    return {
      kind: "local",
      items,
      vault,
      defaults: { dir: suggestedDir(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, seeds: seeds(), domains: templateDomains() },
      secrets,
      llm,
      git,
      schedule: sched,
      remote: {
        workerUrl: env.HIPPO_WORKER_URL,
        embed:
          env.HIPPO_EMBED_PROVIDER || embedModel
            ? { provider: env.HIPPO_EMBED_PROVIDER, model: embedModel, baseURL: env.HIPPO_EMBED_BASE_URL, apiKey: env.HIPPO_EMBED_API_KEY ? "set" : "unset" }
            : undefined,
      },
      agents,
      unknownAgents,
      envFile: envFile(),
    };
  }

  // ── Routes ──
  async function handle(method: "GET" | "POST", path: string, body: unknown): Promise<unknown> {
    const route = `${method} ${path}`;
    switch (route) {
      case "POST vault": {
        const req = VaultRequest.parse(body);
        if (req.action === "create") {
          if (req.seed && !seeds().includes(req.seed)) throw new HttpError(400, `No bundled seed "${req.seed}"`, "INVALID");
          const created = await attempt(() => initVault({ target: req.dir, seed: req.seed, assets, campaign: req.campaign, human: req.human, timezone: req.timezone, domains: req.domains }));
          if (created.error) throw new HttpError(400, created.error, "VAULT_SETUP");
          await open({ kind: "dir", dir: created.value!.dir });
          if (req.makeDefault) await save({ HIPPO_VAULT: created.value!.dir, HIPPO_GITHUB_REPO: null });
        } else if (req.action === "open") {
          await open({ kind: "dir", dir: req.dir });
          if (req.makeDefault) await save({ HIPPO_VAULT: req.dir, HIPPO_GITHUB_REPO: null });
        } else if (req.action === "github") {
          const token = req.token ?? githubToken(env);
          if (!token) throw new HttpError(400, "A GitHub token is needed: fine-grained, with Contents read and write on the vault repo only.", "TOKEN_REQUIRED");
          const spec = req.branch ? `${req.repo}#${req.branch}` : req.repo;
          await open({ kind: "github", repo: spec, token });
          if (req.makeDefault) await save({ HIPPO_GITHUB_REPO: spec, HIPPO_GITHUB_TOKEN: req.token });
        } else {
          await open({ kind: "mcp", url: req.url, token: req.token ?? env.HIPPO_MCP_TOKEN });
        }
        return { ok: true };
      }

      case "POST secrets": {
        const { reuseExisting } = z.object({ reuseExisting: z.boolean().optional() }).parse(body ?? {});
        const a = needStore("create its secrets key");
        try {
          const r = await keygen({ store: a.store, identityFile: identityFile(env), reuseExisting });
          return { recipient: r.recipient, identityFile: r.identityFile };
        } catch (err) {
          if (err instanceof IdentityExistsError)
            throw new HttpError(409, `An identity already exists at ${err.file}. Reuse it (it's never overwritten).`, "IDENTITY_EXISTS", { identityFile: err.file });
          throw err;
        }
      }

      case "GET llm":
        return llmSettings();
      case "POST llm": {
        const req = LlmRequest.parse(body);
        if (req.provider === "openai-compatible" && !req.baseURL) throw new HttpError(400, "baseURL: an OpenAI-compatible server needs its URL", "INVALID");
        await save({ HIPPO_LLM_PROVIDER: req.provider, HIPPO_LLM_MODEL: req.model, HIPPO_LLM_BASE_URL: req.baseURL ?? null, HIPPO_LLM_API_KEY: req.apiKey });
        return llmSettings();
      }
      case "GET llm/models":
        return { servers: (await Promise.all(LOCAL_SERVERS.map(probe))).filter((s): s is LlmServer => !!s) };
      case "POST llm/test":
        return pingLLM(llmConfigFromEnv(env), { timeoutMs: 60_000 });

      case "GET git":
        return gitStatus();
      case "POST git/visibility":
        return { visibility: await visibility() };

      case "GET schedule":
        return schedule();
      case "POST schedule": {
        const req = ScheduleRequest.parse(body);
        if (platform !== "darwin") throw new HttpError(501, "Installing the schedule needs launchd (macOS). Add the cron line instead.", "UNSUPPORTED");
        needStore("schedule its nightly sleep");
        if ("remove" in req) {
          const job = await sleepJob(3, 30);
          if (job) await removeSchedule(job.label, ld);
          return schedule();
        }
        const job = (await sleepJob(req.hour, req.minute))!;
        if (job.github && !githubToken(await readEnvFile(envFile())))
          throw new HttpError(409, `The nightly job reads HIPPO_GITHUB_TOKEN from ${envFile()}: open the repo again with "make default" and the token first.`, "TOKEN_REQUIRED");
        await installSchedule(job, ld);
        return schedule();
      }

      case "POST jobs": {
        const req = JobRequest.parse(body);
        const a = needStore(req.kind === "reindex" ? "rebuild its index" : "run the curator");
        if (req.kind === "sleep-dry-run") {
          return startJob("sleep-dry-run", async (log) => {
            const cfg = llmConfigFromEnv(env);
            log(`🌙 dry run with ${cfg.provider}:${cfg.model} (nothing is written)`);
            const r = await sleep({ store: a.store, llm: aiSdkLLM(cfg), searcher: a.index?.index.searcher, limit: req.limit ?? 3, dryRun: true, log });
            for (const w of r.warnings) log(`⚠ ${w}`);
            return `Dry run: ${r.consolidated.length} consolidated, ${r.failed.length} failed, ${r.remaining} left in the inbox. Nothing was written.`;
          });
        }
        return startJob("reindex", async (log) => {
          const key = indexKey(a.target.kind === "github" ? { github: a.target.repo } : { dir: a.vault.dir });
          const own = a.index ?? (await openIndex(key, env));
          try {
            log(`↻ rebuilding ${own.path}`);
            await own.index.rebuild();
            const stats = await own.index.sync(await a.service!.vault());
            const { edges } = await own.index.counts();
            const embedded = own.options.embedder ? `; embedded ${stats.embedded ?? 0} with ${own.options.embedder.id}${own.index.lastEmbedError ? ` (${own.index.lastEmbedError.message})` : ""}` : "";
            return `Indexed ${stats.added} notes and ${edges} relations${embedded}.`;
          } finally {
            if (!a.index) own.close();
          }
        });
      }

      case "POST remote/check": {
        const { url } = z.object({ url: RemoteUrl }).parse(body);
        const get = (path: string) => fetchFn(`${url}${path}`, { redirect: "manual", signal: AbortSignal.timeout(5000), headers: { accept: "application/json, text/plain" } });
        const [home, oauth, session] = await Promise.allSettled([get("/"), get("/.well-known/oauth-authorization-server"), get("/dashboard/api/session")]);
        const text = async (r: PromiseSettledResult<Response>) => (r.status === "fulfilled" ? await r.value.text().catch(() => "") : "");
        const isJson = (r: PromiseSettledResult<Response>) => r.status === "fulfilled" && /json/.test(r.value.headers.get("content-type") ?? "");
        const mcp = home.status === "fulfilled" && home.value.ok && /Hippocampus MCP/i.test(await text(home));
        const hasOAuth = oauth.status === "fulfilled" && oauth.value.ok && isJson(oauth) && /authorization_endpoint/.test(await text(oauth));
        const dashboard = session.status === "fulfilled" && (session.value.ok || session.value.status === 401) && isJson(session);
        const failed = [home, oauth, session].every((r) => r.status === "rejected") ? (home as PromiseRejectedResult).reason : undefined;
        return { mcp, oauth: hasOAuth, dashboard, ...(failed ? { error: `Couldn't reach ${url}: ${message(failed)}` } : !mcp ? { error: `${url} doesn't look like a Hippocampus server` } : {}) };
      }
      case "POST remote": {
        const req = RemoteRequest.parse(body);
        const e = req.embed ?? {};
        const embed = { HIPPO_EMBED_PROVIDER: setting(e.provider), HIPPO_EMBED_BASE_URL: setting(e.baseURL), HIPPO_EMBED_MODEL: setting(e.model), HIPPO_EMBED_API_KEY: e.apiKey };
        await save({ HIPPO_WORKER_URL: setting(req.workerUrl), ...embed });
        // The index embeds with these settings: reopen so they apply now.
        if (Object.values(embed).some((v) => v !== undefined)) await runtime.reopen();
        return { ok: true };
      }
    }
    if (path === "tokens" || path.startsWith("tokens/")) throw new HttpError(501, "Agent tokens are minted on the Worker (its Session Zero), not here.", "UNSUPPORTED");
    if (method === "GET" && path.startsWith("jobs/")) {
      const job = jobs.get(path.slice("jobs/".length));
      if (!job) throw new HttpError(404, "No such job", "NOT_FOUND");
      return job;
    }
    throw new HttpError(404, `No such setup route: ${method} ${path}`, "NOT_FOUND");
  }

  return { kind: "local", status, handle: (method, path, body) => handle(method, path, body) };
}

// ── Checklist items ──────────────────────────────────────────────────────────

function vaultItem(a: ActiveVault | undefined, v: LocalVaultStatus | undefined, cfg: HippoConfig | undefined, error: string | undefined): SetupItem {
  const base = { id: "vault", title: "Vault", how: "performed" as const };
  if (!a) return { ...base, state: "todo", detail: "Create a new vault, open one on this machine, or use a GitHub repo." };
  const where = a.vault.dir ?? (a.vault.repo ? `${a.vault.repo}#${a.vault.branch ?? "main"} on GitHub` : a.vault.url ?? "demo");
  if (v?.version === "older") return { ...base, state: "error", detail: `${where} uses format v${cfg?.version}; this tool needs v${CURRENT_VAULT_VERSION}. Run \`hippo migrate\`.` };
  if (v?.version === "newer") return { ...base, state: "error", detail: `${where} uses format v${cfg?.version}, newer than this tool (v${CURRENT_VAULT_VERSION}). Upgrade Hippocampus.` };
  if (error) return { ...base, state: "error", detail: `${where}: ${error}` };
  return { ...base, state: "done", detail: `${where}${v?.isDefault ? " (opens by default)" : ""}` };
}

function partyItem(a: ActiveVault | undefined, ov: Overview | undefined, members: number, unknown: string[]): SetupItem {
  const base = { id: "party", title: "Party", how: "performed" as const };
  if (!a || !ov) return { ...base, state: "na", detail: "Needs a vault." };
  if (!members) return { ...base, state: "todo", detail: "Add your agents: one party note each, with a lane and the domains it's the authority on." };
  if (unknown.length) return { ...base, state: "warn", detail: `${members} agents. Writing without a party note (their word counts as rumor): ${unknown.join(", ")}` };
  return { ...base, state: "done", detail: `${members} agents: ${ov.party.map((p) => p.slug).join(", ")}` };
}

function secretsItem(a: ActiveVault | undefined, s: SecretsStatus): SetupItem {
  const base = { id: "secrets", title: "Secrets key", how: "performed" as const };
  if (!a) return { ...base, state: "na", detail: "Needs a vault." };
  if (!a.store) return { ...base, state: "na", detail: "Secret facts are encrypted where the vault lives." };
  if (!s.recipient) return { ...base, state: "todo", detail: "No key yet: agents can't store secret facts (passport numbers, IBANs) until there is one." };
  if (!s.identity) return { ...base, state: "warn", detail: `The vault has a key, but its identity isn't on this machine (${s.identityFile}). Restore it from your backup to read secrets.` };
  if (!s.matches) return { ...base, state: "warn", detail: `The identity at ${s.identityFile} doesn't match the vault's key.` };
  return { ...base, state: "done", detail: `The identity on this machine matches the vault's key. Keep a backup of ${s.identityFile}.` };
}

function llmItem(a: ActiveVault | undefined, llm: LlmSettings, chosen: boolean): SetupItem {
  const base = { id: "llm", title: "Curator model", how: "performed" as const };
  const hosted = llm.provider === "anthropic" || llm.provider === "xai";
  if (a?.mode === "mcp") return { ...base, state: "optional", detail: "The curator runs where the vault lives." };
  if (hosted && llm.apiKey === "unset") return { ...base, state: "warn", detail: `${llm.provider} · ${llm.model}: no API key` };
  const configured = chosen || hosted;
  return { ...base, state: configured ? "done" : "todo", detail: `${llm.provider} · ${llm.model}${configured ? "" : " (the default; pick yours and test it)"}` };
}

function gitItem(a: ActiveVault | undefined, g: GitStatus | undefined): SetupItem {
  const base = { id: "git", title: "Private GitHub repo", how: "guided" as const };
  if (!a || a.target.kind === "mcp" || a.target.kind === "demo") return { ...base, state: "na", detail: a ? "The vault's repo is managed where it lives." : "Needs a vault." };
  if (a.target.kind === "github") return { ...base, state: "done", detail: `${a.vault.repo} on GitHub, used through the API` };
  if (!g?.repo) return { ...base, state: "todo", detail: "Not a git repository yet: run `git init` in the vault." };
  if (!g.remote) return { ...base, state: "todo", detail: "No remote yet: create an empty private repo on GitHub and push the vault to it." };
  const sync = [g.ahead ? `${g.ahead} to push` : "", g.behind ? `${g.behind} to pull` : "", g.dirty ? `${g.dirty} uncommitted` : ""].filter(Boolean).join(", ");
  return { ...base, state: g.upstream ? "done" : "warn", detail: `${g.remote.host}/${g.remote.path}${g.branch ? ` · ${g.branch}` : ""}${g.upstream ? "" : " · not pushed yet"}${sync ? ` · ${sync}` : ""}` };
}

function agentsItem(a: ActiveVault | undefined, members: number): SetupItem {
  const base = { id: "agents", title: "Connect agents", how: "guided" as const };
  if (!a) return { ...base, state: "na", detail: "Needs a vault." };
  if (!members) return { ...base, state: "todo", detail: "Add party members first; each gets its own connect command." };
  return { ...base, state: "done", detail: `Connect commands ready for ${members} party members` };
}

function scheduleItem(a: ActiveVault | undefined, s: ScheduleStatus, overridden: string[]): SetupItem {
  const base = { id: "schedule", title: "Nightly sleep", how: (s.supported ? "performed" : "guided") as SetupItem["how"] };
  if (!a || a.target.kind === "mcp" || a.target.kind === "demo") return { ...base, state: "na", detail: a ? "Sleep runs where the vault lives." : "Needs a vault." };
  const shellOnly = overridden.length ? ` Your shell sets ${overridden.join(", ")}; the nightly job won't see that, so save the model here too.` : "";
  if (!s.supported) return { ...base, state: "todo", detail: `Add the cron line to your crontab (crontab -e).${shellOnly}` };
  if (!s.installed) return { ...base, state: "todo", detail: `Not scheduled.${shellOnly}` };
  const when = `Every night at ${pad(s.hour ?? 0)}:${pad(s.minute ?? 0)}`;
  if (!s.loaded) return { ...base, state: "warn", detail: `${when}, but launchd hasn't loaded ${s.label}. Install it again.` };
  return { ...base, state: overridden.length ? "warn" : "done", detail: `${when}.${shellOnly}` };
}
