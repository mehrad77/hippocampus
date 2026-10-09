// End-to-end smoke test of the hosted Worker in the real Workers runtime (workerd, via `wrangler dev
// --local`), against scripts/fake-github.ts. The unit tests run the same code in Node, so this is
// what catches what only workerd does: bundling, bindings, D1, the Durable Object's RPC and storage,
// and the MCP SDK under Workers' fetch. It never talks to Cloudflare or GitHub.
//
//   pnpm --filter @hippocampus/dashboard-ui build     # once: the Worker serves the built UI
//   pnpm --filter @hippocampus/worker smoke           # or `pnpm smoke:worker` from the root
//
// Everything lives in a temp dir (settings, wrangler state, logs), so apps/worker/.dev.vars and
// .wrangler/ are never touched. Only fictional people and data from seeds/example-relocation.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const WORKER_DIR = resolve(import.meta.dirname, "..");
const UI_BUILD = resolve(WORKER_DIR, "../dashboard/dist/dashboard/index.html");
const WRANGLER = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin/wrangler.js");
const PLAYER = { login: "player", id: 4242, repo: 9001 };
const GM = { login: "game-master", id: 7, repo: 9002 };

// ── Processes ────────────────────────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "hippo-smoke-"));
const children: ChildProcess[] = [];
/** The last lines each child printed, for the failure report. */
const logs = new Map<string, string[]>();

/** Ports nobody's using right now: each is bound, read and released. */
async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => ok(port));
    });
  });
}

/** Without Cloudflare credentials or telemetry, so nothing here can reach an account even by mistake. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(tmp, "wrangler-logs"), NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CLOUDFLARE_ACCOUNT_ID", "CF_API_TOKEN", "CF_ACCOUNT_ID"]) delete env[k];
  return env;
}

/** A child in its own process group, so stopping it also stops what it started (wrangler's workerd). */
function start(name: string, args: string[], { logStdout = true } = {}): ChildProcess {
  const child = spawn(process.execPath, args, { cwd: WORKER_DIR, env: childEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  logs.set(name, lines);
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) lines.push(line);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  };
  if (logStdout) child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);
  children.push(child);
  return child;
}

/** Runs a command to the end and returns its stdout. With `secret`, stdout stays out of the failure report. */
async function run(name: string, args: string[], { secret = false } = {}): Promise<string> {
  const child = start(name, args, { logStdout: !secret });
  let out = "";
  child.stdout!.on("data", (c: Buffer) => (out += c.toString("utf8")));
  const code = await new Promise<number | null>((ok) => child.once("exit", ok));
  if (code !== 0) throw new Error(`${name} exited with ${code}`);
  return out;
}

function stopAll(): void {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

/** Polls until `url` answers at all, or fails as soon as `child` exits. */
async function waitFor(url: string, child: ChildProcess, name: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`${name} exited with ${child.exitCode} before it was ready`);
    try {
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`${name} wasn't ready after ${timeoutMs / 1000}s`);
}

// ── Steps ────────────────────────────────────────────────────────────────────────────────────────

let passed = 0;
/** What the running step found worth printing next to its name. */
let detail = "";
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  detail = "";
  try {
    const result = await fn();
    passed++;
    console.log(`✓ ${name}${detail ? `: ${detail}` : ""} (${Date.now() - started}ms)`);
    return result;
  } catch (err) {
    console.log(`✗ ${name}: ${(err as Error).message}`);
    throw err;
  }
}

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

// ── A browser: a cookie jar for the Worker, and redirects followed by hand ───────────────────────

interface Visited {
  res: Response;
  /** Every URL visited, the last one included. */
  chain: string[];
}

function browser(origin: string, github: string, login: string) {
  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = c.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const gone = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || pair.slice(at + 1) === "";
      if (gone) jar.delete(name);
      else jar.set(name, pair.slice(at + 1));
    }
  };

  /** One request, then redirects; the fake GitHub is told who's at the keyboard (`--choose`). */
  async function visit(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}): Promise<Visited> {
    let url = new URL(path, origin);
    let method = init.method ?? "GET";
    let body = init.json === undefined ? undefined : JSON.stringify(init.json);
    const chain: string[] = [];
    for (let hops = 0; hops < 10; hops++) {
      if (url.origin === github) url.searchParams.set("as", login);
      chain.push(url.href);
      const headers = new Headers(init.headers);
      if (body !== undefined) headers.set("content-type", "application/json");
      if (url.origin === origin && jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      const res = await fetch(url, { method, headers, body, redirect: "manual" });
      if (url.origin === origin) keep(res);
      const location = res.headers.get("location");
      if (res.status < 300 || res.status > 399 || !location) return { res, chain };
      await res.body?.cancel();
      url = new URL(location, url);
      method = "GET";
      body = undefined;
    }
    throw new Error(`too many redirects from ${path}`);
  }

  const api = async <T = unknown>(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) => {
    const { res } = await visit(`/dashboard/api/${path}`, init);
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body: body as T };
  };
  /** A same-origin write, as the dashboard sends it. */
  const post = <T = unknown>(path: string, json: unknown) => api<T>(path, { method: "POST", json, headers: { origin } });

  return { visit, api, post, cookies: () => [...jar.keys()] };
}

// ── MCP ──────────────────────────────────────────────────────────────────────────────────────────

interface ToolText {
  text: string;
  isError: boolean;
}

async function mcpClient(origin: string, token: string) {
  const client = new Client({ name: "hippocampus-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", origin), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolText> => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true };
  };
  const tools = async () => (await client.listTools()).tools.map((t) => t.name);
  const whoami = async () => {
    const r = await client.readResource({ uri: "hippo://dashboard/whoami" });
    const first = r.contents[0] as { text?: string } | undefined;
    return JSON.parse(first?.text ?? "{}") as { agent: string | null; scopes: string[]; campaign: string; human: string };
  };
  return { client, call, tools, whoami, close: () => client.close() };
}

interface Question {
  id: string;
  name: string;
  schema: JsonSchema;
}
type SleepStep = { run: string; state: "ask"; questions: Question[]; rejected?: { questionId: string; issues: string }[] } | { run: string; state: "done"; report: Record<string, unknown> };
interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  minLength?: number;
  minimum?: number;
  minItems?: number;
  items?: JsonSchema;
}

/**
 * The least answer a question's schema accepts: nothing found, nothing claimed, "new" over a guess.
 * The smoke test checks the plumbing, not the curator's judgment, so it never invents content.
 */
function minimal(schema: JsonSchema): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum.includes("new") ? "new" : schema.enum[0];
  const alt = schema.anyOf?.[0] ?? schema.oneOf?.[0];
  if (alt) return minimal(alt);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object":
      return Object.fromEntries((schema.required ?? []).map((k) => [k, minimal(schema.properties?.[k] ?? {})]));
    case "array":
      return schema.minItems && schema.items ? Array.from({ length: schema.minItems }, () => minimal(schema.items!)) : [];
    case "string":
      return "x".repeat(schema.minLength ?? 0);
    case "number":
    case "integer":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

const answerFor = (q: Question) => (q.name === "mentions" ? { entities: [] } : minimal(q.schema));

// ── The run ──────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const started = Date.now();
  check(existsSync(UI_BUILD), "the dashboard UI isn't built: run `pnpm --filter @hippocampus/dashboard-ui build` first");
  const [ghPort, workerPort, inspectorPort] = [await freePort(), await freePort(), await freePort()];
  const origin = `http://127.0.0.1:${workerPort}`;
  const github = `http://127.0.0.1:${ghPort}`;
  const state = join(tmp, "state");
  const envFile = join(tmp, "smoke.env");
  const fake = join(WORKER_DIR, "scripts/fake-github.ts");

  await step("settings for the fake GitHub, in a temp dir", async () => {
    // --env-file makes wrangler skip apps/worker/.dev.vars entirely. The settings hold a throwaway key, kept out of the logs anyway.
    writeFileSync(envFile, await run("fake-github --dev-vars", ["--import", "tsx", fake, "--dev-vars", "--port", String(ghPort), "--public-url", origin], { secret: true }), {
      mode: 0o600,
    });
  });
  await step("D1 migrations applied to the temp state", () => run("wrangler d1 migrations", [WRANGLER, "d1", "migrations", "apply", "REGISTRY", "--local", "--persist-to", state]));

  const gh = start("fake-github", ["--import", "tsx", fake, "--port", String(ghPort), "--public-url", origin, "--choose"]);
  const worker = start("wrangler dev", [
    WRANGLER,
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(workerPort),
    "--inspector-port",
    String(inspectorPort),
    "--persist-to",
    state,
    "--env-file",
    envFile,
    "--show-interactive-dev-session=false",
  ]);
  await step("fake GitHub and wrangler dev are up", async () => {
    await waitFor(`${github}/new`, gh, "fake GitHub", 30_000);
    await waitFor(`${origin}/`, worker, "wrangler dev", 120_000);
  });

  // Signed out.
  const player = browser(origin, github, PLAYER.login);
  await step("GET / signed out redirects to the welcome page", async () => {
    const res = await fetch(`${origin}/`, { redirect: "manual" });
    check(res.status === 302, `status ${res.status}`);
    check(res.headers.get("location") === "/dashboard/welcome/", `location ${res.headers.get("location")}`);
  });
  await step("dashboard HTML carries the security headers", async () => {
    const { res } = await player.visit("/dashboard/");
    check(res.status === 200, `status ${res.status}`);
    check(/^text\/html/.test(res.headers.get("content-type") ?? ""), `content-type ${res.headers.get("content-type")}`);
    const want: Record<string, RegExp> = {
      "x-frame-options": /^DENY$/,
      "x-content-type-options": /^nosniff$/,
      "referrer-policy": /^no-referrer$/,
      "content-security-policy": /frame-ancestors 'none'/,
      "cross-origin-opener-policy": /^same-origin$/,
    };
    for (const [h, re] of Object.entries(want)) check(re.test(res.headers.get(h) ?? ""), `${h}: ${res.headers.get(h)}`);
    check(/<html/i.test(await res.text()), "not the built page");
  });
  await step("the API refuses a visitor who isn't signed in (401)", async () => {
    const r = await player.api("session");
    check(r.status === 401, `status ${r.status}`);
  });

  // The admin's onboarding.
  await step("player signs in with GitHub (admin, approved at once)", async () => {
    const { res, chain } = await player.visit("/dashboard/auth/login");
    check(res.status === 200, `ended at ${chain.at(-1)} with ${res.status}`);
    check(chain.some((u) => u.startsWith(`${github}/login/oauth/authorize`)), "never went to GitHub");
    check(player.cookies().includes("hippo_session"), `cookies: ${player.cookies().join(", ")}`);
    const s = await player.api<{ mode: string; account: { status: string; admin: boolean } }>("session");
    check(s.status === 200 && s.body.mode === "setup", `session ${s.status} ${JSON.stringify(s.body)}`);
    check(s.body.account.status === "approved" && s.body.account.admin, `account ${JSON.stringify(s.body.account)}`);
  });
  await step("player installs the GitHub App and lands on the repo picker", async () => {
    const status = await player.api<{ installUrl: string }>("setup/status");
    check(status.body.installUrl.startsWith(`${github}/apps/`), `installUrl ${status.body.installUrl}`);
    const { res, chain } = await player.visit(status.body.installUrl);
    check(chain.some((u) => u.includes("/oauth/github/callback?installation_id=")), "no install callback");
    check(new URL(chain.at(-1)!).pathname === "/dashboard/setup/" && res.status === 200, `ended at ${chain.at(-1)} with ${res.status}`);
  });
  await step("GET setup/repos lists player/vault, private and empty", async () => {
    const r = await player.api<{ repos: { id: number; fullName: string; private: boolean; empty?: boolean }[] }>("setup/repos");
    check(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
    const repo = r.body.repos.find((x) => x.id === PLAYER.repo);
    check(repo?.fullName === "player/vault" && repo.private && repo.empty === true, JSON.stringify(r.body.repos));
  });
  await step("setup writes refuse another Origin (403)", async () => {
    const r = await player.api("setup/init", { method: "POST", json: {}, headers: { origin: "https://evil.example" } });
    check(r.status === 403, `status ${r.status}`);
  });
  await step("POST setup/init bootstraps the vault from the example-relocation seed", async () => {
    const r = await player.post<{ vault: { status: string; fullName: string } }>("setup/init", {
      repoId: PLAYER.repo,
      campaign: "Lisbon relocation",
      human: "player",
      timezone: "Europe/Lisbon",
      domains: ["residency", "housing", "university"],
      seed: "example-relocation",
    });
    check(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
    check(r.body.vault.status === "ready" && r.body.vault.fullName === "player/vault", JSON.stringify(r.body));
  });
  await step("the session and overview now come from the vault's Durable Object", async () => {
    const s = await player.api<{ mode: string }>("session");
    check(s.status === 200 && s.body.mode !== "setup", `session ${s.status} ${JSON.stringify(s.body)}`);
    const o = await player.api<{ campaign: string; counts: { entities: number; inbox: number }; party: { id: string }[] }>("overview");
    check(o.status === 200, `overview ${o.status} ${JSON.stringify(o.body)}`);
    check(o.body.campaign === "Lisbon relocation", `campaign ${o.body.campaign}`);
    check(o.body.counts.entities > 0, "the seed's notes are missing");
  });
  const keys = await step("POST setup/keys mints an agent key and a curator key", async () => {
    const agent = await player.post<{ token: string; kind: string; scopes: string[] }>("setup/keys", { kind: "agent", label: "Smoke agents" });
    const curator = await player.post<{ token: string; kind: string; scopes: string[] }>("setup/keys", { kind: "curator" });
    for (const k of [agent, curator]) check(k.status === 200 && k.body.token?.startsWith("hippo_"), `status ${k.status} ${JSON.stringify({ ...(k.body as object), token: undefined })}`);
    check(curator.body.scopes.includes("curate") && !agent.body.scopes.includes("curate"), "scopes");
    return { agent: agent.body.token, curator: curator.body.token };
  });

  // MCP as an agent.
  await step("MCP without a key, or with a made-up one, is 401", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const none = await fetch(`${origin}/mcp`, { method: "POST", headers, body });
    check(none.status === 401, `no key: ${none.status}`);
    const bogus = await fetch(`${origin}/mcp`, { method: "POST", headers: { ...headers, authorization: `Bearer hippo_${"A".repeat(43)}` }, body });
    check(bogus.status === 401, `bogus key: ${bogus.status}`);
  });
  const agent = await step("agent key: tools/list has remember and introduce, no sleep tools", async () => {
    const m = await mcpClient(origin, keys.agent);
    const tools = await m.tools();
    for (const t of ["onboard", "remember", "introduce", "recall"]) check(tools.includes(t), `missing ${t}: ${tools.join(", ")}`);
    check(!tools.some((t) => t.startsWith("sleep_")), `sleep tools offered: ${tools.join(", ")}`);
    return m;
  });
  await step("an unknown agent onboards, then introduces itself", async () => {
    const onboard = await agent.call("onboard", { agent: "transit-scout" });
    check(!onboard.isError && /introduce/i.test(onboard.text), `onboard: ${onboard.text.slice(0, 200)}`);
    const intro = await agent.call("introduce", { agent: "transit-scout", title: "Transit Scout", lane: "Public transport passes and routes in lisbon", host: "smoke test" });
    check(!intro.isError && intro.text.includes("transit-scout"), `introduce: ${intro.text.slice(0, 200)}`);
  });
  await step("remember as residency-agent, a party member, is stored", async () => {
    const r = await agent.call("remember", { agent: "residency-agent", text: "The migration-agency appointment for the residence permit is on 2026-11-03 in lisbon.", kind: "fact" });
    check(!r.isError && /stored/.test(r.text), `remember: ${r.text.slice(0, 200)}`);
  });
  await step("remember as player, the human, is refused", async () => {
    const r = await agent.call("remember", { agent: "player", text: "The player prefers morning appointments." });
    check(r.isError, `accepted: ${r.text.slice(0, 200)}`);
  });
  await step("recall finds the seed's notes", async () => {
    const r = await agent.call("recall", { query: "migration agency" });
    check(!r.isError && r.text.includes("migration-agency"), `recall: ${r.text.slice(0, 200)}`);
  });

  // Sleep as the curator.
  const inboxBefore = await step("the overview counts the new memories in the inbox", async () => {
    const o = await player.api<{ counts: { inbox: number } }>("overview");
    check(o.status === 200 && o.body.counts.inbox >= 1, `overview ${o.status} ${JSON.stringify(o.body.counts)}`);
    return o.body.counts.inbox;
  });
  const curator = await step("curator key: tools/list has the sleep tools, not remember", async () => {
    const m = await mcpClient(origin, keys.curator);
    const tools = await m.tools();
    for (const t of ["sleep_start", "sleep_answer", "sleep_skip", "sleep_status", "sleep_abort"]) check(tools.includes(t), `missing ${t}: ${tools.join(", ")}`);
    check(!tools.includes("remember"), "remember offered to the curator");
    return m;
  });
  await step("sleep runs to done with minimal answers", async () => {
    const parse = (r: ToolText) => {
      check(!r.isError, r.text.slice(0, 300));
      return JSON.parse(r.text) as SleepStep;
    };
    let s = parse(await curator.call("sleep_start", { model: "smoke-test", curator: "archivist", limit: 20 }));
    let skips = 0;
    let questions = 0;
    for (let rounds = 0; s.state === "ask"; rounds++) {
      check(rounds < 60, "sleep didn't finish in 60 rounds");
      if (s.rejected?.length) {
        // The plumbing works if the server judged the answer; a curator would fix it, this one steps aside.
        s = parse(await curator.call("sleep_skip", { run: s.run, reason: "smoke test" }));
        skips++;
        continue;
      }
      questions += s.questions.length;
      s = parse(await curator.call("sleep_answer", { run: s.run, answers: s.questions.map((q) => ({ question_id: q.id, value: answerFor(q) })) }));
    }
    check(s.state === "done", `state ${(s as { state: string }).state}`);
    const status = JSON.parse((await curator.call("sleep_status")).text) as { run?: unknown; history: { outcome: string }[] };
    const last = status.history[0] as { outcome: string; consolidated?: number; skipped?: number } | undefined;
    check(!status.run && last?.outcome === "done", `status ${JSON.stringify(status)}`);
    check((last.consolidated ?? 0) >= 1, `nothing consolidated: ${JSON.stringify(last)}`);
    detail = `${questions} questions answered, ${skips} skipped, ${last.consolidated} consolidated`;
  });
  await step("the inbox shrank", async () => {
    const o = await player.api<{ counts: { inbox: number } }>("overview");
    check(o.status === 200 && o.body.counts.inbox < inboxBefore, `inbox ${inboxBefore} → ${o.body.counts.inbox}`);
    detail = `${inboxBefore} → ${o.body.counts.inbox}`;
  });

  // A second account: waitlisted, then approved by the admin, then its own vault.
  const gm = browser(origin, github, GM.login);
  await step("game-master signs in and is waitlisted, not admin", async () => {
    const { res, chain } = await gm.visit("/dashboard/auth/login");
    check(res.status === 200, `ended at ${chain.at(-1)} with ${res.status}`);
    const s = await gm.api<{ mode: string; account: { status: string; admin: boolean } }>("session");
    check(s.body.mode === "setup" && s.body.account.status === "waitlisted" && !s.body.account.admin, JSON.stringify(s.body));
  });
  await step("game-master has no vault: overview 409, setup 403, admin 403", async () => {
    const overview = await gm.api("overview");
    check(overview.status === 409, `overview ${overview.status}`);
    const repos = await gm.api("setup/repos");
    check(repos.status === 403, `setup/repos ${repos.status}`);
    const admin = await gm.api("admin/accounts");
    check(admin.status === 403, `admin/accounts ${admin.status}`);
  });
  await step("player, the admin, approves game-master", async () => {
    const list = await player.api<{ accounts: { id: number; status: string }[] }>("admin/accounts?status=waitlisted");
    check(list.body.accounts?.some((a) => a.id === GM.id), JSON.stringify(list.body));
    const r = await player.post<{ account: { status: string } }>("admin/accounts/approve", { id: GM.id });
    check(r.status === 200 && r.body.account.status === "approved", `${r.status} ${JSON.stringify(r.body)}`);
  });
  const gmKey = await step("game-master installs the app, sets up a vault and mints a key", async () => {
    const status = await gm.api<{ installUrl: string }>("setup/status");
    await gm.visit(status.body.installUrl);
    const init = await gm.post<{ vault: { status: string; fullName: string } }>("setup/init", {
      repoId: GM.repo,
      campaign: "Harbor term",
      human: "game-master",
      timezone: "Europe/Lisbon",
      domains: ["university"],
    });
    check(init.status === 200 && init.body.vault.fullName === "game-master/vault" && init.body.vault.status === "ready", `${init.status} ${JSON.stringify(init.body)}`);
    const key = await gm.post<{ token: string }>("setup/keys", { kind: "agent" });
    check(key.status === 200 && key.body.token?.startsWith("hippo_"), `keys ${key.status}`);
    return key.body.token;
  });
  await step("each key sees only its own campaign", async () => {
    const gmAgent = await mcpClient(origin, gmKey);
    try {
      const mine = await agent.whoami();
      const theirs = await gmAgent.whoami();
      check(mine.campaign === "Lisbon relocation" && mine.human === "player", `player's key: ${JSON.stringify(mine)}`);
      check(theirs.campaign === "Harbor term" && theirs.human === "game-master", `game-master's key: ${JSON.stringify(theirs)}`);
      const recall = await gmAgent.call("recall", { query: "migration agency residence permit" });
      check(!recall.isError && !recall.text.includes("migration-agency"), "game-master's key found player's notes");
      const o = await gm.api<{ campaign: string }>("overview");
      check(o.status === 200 && o.body.campaign === "Harbor term", `game-master's overview: ${o.status} ${o.body.campaign}`);
    } finally {
      await gmAgent.close();
    }
  });

  await agent.close();
  await curator.close();
  console.log(`\n${passed} checks passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    console.error(`\n${signal}: stopping the fake GitHub and wrangler dev`);
    stopAll();
    rmSync(tmp, { recursive: true, force: true });
    process.exit(130);
  });

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  if (!interrupted) {
    console.error(`\nSmoke test failed: ${(err as Error).message}`);
    for (const [name, lines] of logs) {
      if (!lines.length) continue;
      console.error(`\n── ${name} (last ${Math.min(lines.length, 40)} lines) ──`);
      console.error(lines.slice(-40).join("\n"));
    }
  }
} finally {
  stopAll();
  // Give workerd a moment to release the state dir before it's removed.
  await new Promise((r) => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
