import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnvOrigins } from "../env-file.ts";
import { assetRoot } from "../paths.ts";
import type { Launchd } from "../schedule.ts";
import { localSetup } from "./local-setup.ts";
import { DashboardRuntime } from "./runtime.ts";
import { launchToken, startDashboardServer, type DashboardServer } from "./server.ts";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = Record<string, unknown>>(): T;
}

/** node:http, so the test controls Host, Origin and Cookie exactly. */
function call(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((done, fail) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...(body ? { "content-type": "application/json" } : {}), ...opts.headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body: text, json: () => JSON.parse(text) }));
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}

const TOKEN = "test-launch-token-0123456789abcdefghijklmnopqrstuvwxyz";

describe("hippo dashboard server", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  let runtime: DashboardRuntime;
  let srv: DashboardServer;
  let cookie: string;
  const get = (path: string, headers: Record<string, string> = {}) => call(srv.port, "GET", path, { headers: { cookie, ...headers } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(srv.port, "POST", path, { body, headers: { cookie, origin: `http://127.0.0.1:${srv.port}`, ...headers } });

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "hippo-dash-"));
    // Never the real home: settings, identity and index cache all live in the temp dir.
    env = { PATH: process.env.PATH, HIPPO_CONFIG_DIR: join(tmp, "config"), XDG_CACHE_HOME: join(tmp, "cache") };
    const root = join(tmp, "ui");
    mkdirSync(join(root, "council"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<h1>home</h1>");
    writeFileSync(join(root, "404.html"), "<h1>lost</h1>");
    writeFileSync(join(root, "council", "index.html"), "<h1>council</h1>");
    writeFileSync(join(tmp, "secret.txt"), "outside the UI");
    const ld: Launchd = { agentsDir: join(tmp, "LaunchAgents"), domain: "gui/0", run: async () => ({ code: 113, out: "" }) };

    runtime = new DashboardRuntime({ env, index: true, assets: assetRoot() });
    const setup = localSetup({
      runtime,
      origins: new EnvOrigins(new Set(), new Set()),
      env,
      assets: assetRoot(),
      cli: { nodePath: "/opt/node/bin/node", cliPath: "/opt/hippocampus/dist/main.js" },
      platform: "linux",
      launchd: ld,
    });
    srv = await startDashboardServer({ port: 0, token: TOKEN, runtime, setup, staticRoot: root });
    cookie = "";
  });

  afterAll(async () => {
    await srv?.close();
    await runtime?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("only answers loopback Hosts and signed-in browsers", async () => {
    expect((await call(srv.port, "GET", "/dashboard/api/session", { headers: { host: `attacker.example:${srv.port}` } })).status).toBe(421);
    const anonymous = await call(srv.port, "GET", "/dashboard/api/session");
    expect(anonymous.status).toBe(401);
    expect(anonymous.json().code).toBe("LOCAL_TOKEN");

    expect((await call(srv.port, "GET", "/dashboard/auth/local?token=wrong")).status).toBe(401);
    const signIn = await call(srv.port, "GET", `/dashboard/auth/local?token=${TOKEN}`);
    expect(signIn.status).toBe(302);
    expect(signIn.headers.location).toBe("/dashboard/");
    cookie = String(signIn.headers["set-cookie"]).split(";")[0]!;
    expect(cookie).toMatch(/^hippo_local=/);
    expect(signIn.headers["set-cookie"]?.[0]).toContain("HttpOnly");

    const session = await get("/dashboard/api/session");
    expect(session.status).toBe(200);
    expect(session.json()).toMatchObject({ mode: "setup", capabilities: { setup: "local" } });
  });

  it("creates a vault in Session Zero and switches to it without a restart", async () => {
    const dir = join(tmp, "vaults", "lisbon-arc");
    const body = { action: "create", dir, campaign: "lisbon-arc", human: "player", timezone: "Europe/Lisbon", domains: ["residency", "housing"], seed: "example-relocation", makeDefault: true };
    expect((await post("/dashboard/api/setup/vault", body, { origin: "http://attacker.example" })).status).toBe(403);
    expect((await call(srv.port, "POST", "/dashboard/api/setup/vault", { body, headers: { origin: `http://127.0.0.1:${srv.port}` } })).status).toBe(401);

    const created = await post("/dashboard/api/setup/vault", body);
    expect(created.status).toBe(200);
    expect(created.json()).toEqual({ ok: true });

    const session = (await get("/dashboard/api/session")).json();
    expect(session).toMatchObject({ mode: "local", campaign: "lisbon-arc", vault: { kind: "dir", dir } });
    expect((await get("/dashboard/api/overview")).json<{ party: unknown[] }>().party.length).toBeGreaterThan(0);

    const envFile = join(tmp, "config", "env");
    expect(readFileSync(envFile, "utf8")).toContain(`HIPPO_VAULT=${dir}`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);

    const status = (await get("/dashboard/api/setup/status")).json<{ items: { id: string; state: string }[]; vault: { isDefault: boolean }; agents: { agent: string; snippets: { code: string }[] }[]; schedule: { cron: string } }>();
    expect(status.items.map((i) => i.id)).toEqual(["vault", "party", "secrets", "llm", "git", "agents", "schedule", "remote"]);
    expect(status.items.find((i) => i.id === "vault")?.state).toBe("done");
    expect(status.vault.isDefault).toBe(true);
    const residency = status.agents.find((a) => a.agent === "residency-agent");
    expect(residency?.snippets[0]?.code).toBe(`claude mcp add hippocampus -- npx -y @mehrad77/hippocampus -v ${dir} serve --agent residency-agent`);
    expect(status.schedule.cron).toContain(`--vault ${dir} sleep`);

    // A second create on the same folder is refused, and bad input is a 400.
    expect((await post("/dashboard/api/setup/vault", body)).status).toBe(400);
    expect((await post("/dashboard/api/setup/vault", { ...body, dir: "relative/path" })).status).toBe(400);
  });

  it("saves LLM settings to the user env file but never sends the key back", async () => {
    const saved = await post("/dashboard/api/setup/llm", { provider: "openai-compatible", model: "qwen/qwen3.5-9b", baseURL: "http://127.0.0.1:1234/v1", apiKey: "sk-test-never-echoed" });
    expect(saved.status).toBe(200);
    expect(saved.body).not.toContain("sk-test-never-echoed");
    expect(saved.json()).toEqual({ provider: "openai-compatible", model: "qwen/qwen3.5-9b", baseURL: "http://127.0.0.1:1234/v1", apiKey: "set", overriddenBy: [] });
    expect((await get("/dashboard/api/setup/status")).body).not.toContain("sk-test-never-echoed");
    expect(readFileSync(join(tmp, "config", "env"), "utf8")).toContain("HIPPO_LLM_API_KEY=sk-test-never-echoed");

    const kept = (await post("/dashboard/api/setup/llm", { provider: "lmstudio", model: "qwen/qwen3.5-9b" })).json();
    expect(kept).toMatchObject({ provider: "lmstudio", apiKey: "set" });
    expect((await post("/dashboard/api/setup/llm", { provider: "lmstudio", model: "qwen/qwen3.5-9b", apiKey: null })).json()).toMatchObject({ apiKey: "unset" });
  });

  it("creates the secrets key once and runs a reindex job", async () => {
    const keyed = await post("/dashboard/api/setup/secrets", {});
    expect(keyed.json<{ recipient: string; identityFile: string }>()).toMatchObject({ recipient: expect.stringMatching(/^age1/), identityFile: join(tmp, "config", "age-identity.txt") });
    expect((await post("/dashboard/api/setup/secrets", {})).json()).toMatchObject({ code: "IDENTITY_EXISTS" });
    expect((await post("/dashboard/api/setup/secrets", { reuseExisting: true })).status).toBe(200);

    const { id } = (await post("/dashboard/api/setup/jobs", { kind: "reindex" })).json<{ id: string }>();
    let job: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      job = (await get(`/dashboard/api/setup/jobs/${id}`)).json();
      if (job.state !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(job).toMatchObject({ state: "done", summary: expect.stringMatching(/^Indexed \d+ notes/) });
    expect((await get("/dashboard/api/setup/jobs/nope")).status).toBe(404);
    expect((await get("/dashboard/api/setup/tokens")).status).toBe(501);
    expect((await get("/dashboard/api/setup/no-such-route")).status).toBe(404);
  });

  it("serves the built UI, its 404 page, and nothing outside it", async () => {
    expect((await get("/")).headers.location).toBe("/dashboard/");
    expect((await get("/dashboard/")).body).toBe("<h1>home</h1>");
    expect((await get("/dashboard/council")).body).toBe("<h1>council</h1>");
    const missing = await get("/dashboard/no-such-page");
    expect(missing.status).toBe(404);
    expect(missing.body).toBe("<h1>lost</h1>");
    for (const path of ["/dashboard/..%2fsecret.txt", "/dashboard/%2e%2e/secret.txt", "/dashboard/../secret.txt", "/secret.txt"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain("outside the UI");
    }
  });
});

describe("launch token", () => {
  it("is generated once, private, and reused", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hippo-token-"));
    try {
      const file = join(tmp, "dashboard-token");
      const first = await launchToken(file);
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(await launchToken(file)).toBe(first);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("port", () => {
  it("moves to the next free port when the chosen one is taken", async () => {
    const runtime = new DashboardRuntime({ env: {}, index: false, assets: assetRoot() });
    const first = await startDashboardServer({ port: 0, token: TOKEN, runtime });
    try {
      const second = await startDashboardServer({ port: first.port, token: TOKEN, runtime });
      expect(second.port).toBeGreaterThan(first.port);
      expect(second.signInUrl).toBe(`http://127.0.0.1:${second.port}/dashboard/auth/local?token=${TOKEN}`);
      await second.close();
      await expect(startDashboardServer({ port: first.port, tries: 1, token: TOKEN, runtime })).rejects.toThrow(/choose one with --port/);
    } finally {
      await first.close();
    }
  });
});

describe("without a built UI", () => {
  it("explains how to build it", async () => {
    const runtime = new DashboardRuntime({ env: {}, index: false, assets: assetRoot() });
    const srv = await startDashboardServer({ port: 0, token: TOKEN, runtime });
    try {
      const res = await call(srv.port, "GET", "/dashboard/");
      expect(res.status).toBe(503);
      expect(res.body).toContain("pnpm --filter @hippocampus/dashboard-ui build");
    } finally {
      await srv.close();
    }
  });
});
