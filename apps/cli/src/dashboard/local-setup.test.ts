import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvOrigins } from "../env-file.ts";
import { assetRoot } from "../paths.ts";
import { initVault } from "../vault-setup.ts";
import { localSetup } from "./local-setup.ts";
import { DashboardRuntime } from "./runtime.ts";

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const route = routes[url];
    if (!route) throw new TypeError("fetch failed: connection refused");
    return route(url, init);
  };
  return { fetch: fn as typeof fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("local setup routes that reach the network", () => {
  let tmp: string;
  let runtime: DashboardRuntime;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hippo-local-setup-"));
  });
  afterEach(async () => {
    await runtime?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function setupWith(routes: Record<string, Route>, env: Record<string, string | undefined> = {}) {
    const f = fakeFetch(routes);
    const fullEnv = { HIPPO_CONFIG_DIR: join(tmp, "config"), XDG_CACHE_HOME: join(tmp, "cache"), ...env };
    runtime = new DashboardRuntime({ env: fullEnv, index: false, assets: assetRoot() });
    const setup = localSetup({ runtime, origins: new EnvOrigins(new Set(), new Set()), env: fullEnv, assets: assetRoot(), cli: { nodePath: "/opt/node/bin/node", cliPath: "/opt/hippocampus/dist/main.js" }, platform: "linux", fetch: f.fetch });
    return { setup, calls: f.calls };
  }

  it("lists the models of the local servers that answer", async () => {
    const { setup } = await setupWith({ "http://127.0.0.1:1234/v1/models": () => json({ data: [{ id: "qwen/qwen3.5-9b" }, { id: "text-embedding-bge-m3" }] }) });
    expect(await setup.handle("GET", "llm/models", undefined, new URL("http://x"))).toEqual({
      servers: [{ name: "LM Studio", url: "http://127.0.0.1:1234/v1", models: ["qwen/qwen3.5-9b", "text-embedding-bge-m3"] }],
    });
  });

  it("checks whether the vault's GitHub remote is public, without credentials", async () => {
    const dir = join(tmp, "vault");
    await initVault({ target: dir, assets: assetRoot() });
    execFileSync("git", ["remote", "add", "origin", "https://player:ghp_secret123@github.com/player/lisbon-arc.git"], { cwd: dir });
    let visible = true;
    const { setup, calls } = await setupWith({ "https://api.github.com/repos/player/lisbon-arc": () => (visible ? json({ private: false }) : json({ message: "Not Found" }, 404)) });
    await runtime.open({ kind: "dir", dir });
    const url = new URL("http://x");
    expect(await setup.handle("POST", "git/visibility", {}, url)).toEqual({ visibility: "public" });
    visible = false;
    expect(await setup.handle("POST", "git/visibility", {}, url)).toEqual({ visibility: "private" });
    expect(calls.join(" ")).not.toContain("ghp_secret123");
    const git = (await setup.handle("GET", "git", undefined, url)) as { remote: unknown };
    expect(git.remote).toEqual({ name: "origin", host: "github.com", path: "player/lisbon-arc" });
  });

  it("recognizes a Hippocampus Worker and saves it with the embedding settings", async () => {
    const worker = "https://hippocampus.example.workers.dev";
    const { setup } = await setupWith({
      [`${worker}/`]: () => new Response("Hippocampus MCP server. Connect an MCP client to /mcp.\n"),
      [`${worker}/.well-known/oauth-authorization-server`]: () => json({ authorization_endpoint: `${worker}/authorize` }),
      [`${worker}/dashboard/api/session`]: () => json({ error: "Sign in", code: "SIGN_IN" }, 401),
    });
    const url = new URL("http://x");
    expect(await setup.handle("POST", "remote/check", { url: `${worker}/` }, url)).toEqual({ mcp: true, oauth: true, dashboard: true });
    expect(await setup.handle("POST", "remote/check", { url: "https://elsewhere.example" }, url)).toMatchObject({ mcp: false, error: expect.stringContaining("Couldn't reach") });
    await expect(setup.handle("POST", "remote/check", { url: "http://hippocampus.example" }, url)).rejects.toThrow();

    expect(await setup.handle("POST", "remote", { workerUrl: worker, embed: { provider: "ollama", model: "bge-m3", apiKey: "embed-key-12345" } }, url)).toEqual({ ok: true });
    const status = await setup.status();
    expect(status).toMatchObject({ kind: "local", remote: { workerUrl: worker, embed: { provider: "ollama", model: "bge-m3" } } });
    expect(JSON.stringify(status)).not.toContain("embed-key-12345");
    expect(status.items.find((i) => i.id === "remote")?.state).toBe("done");
  });

  it("refuses vault actions that need a vault, and remote-only routes", async () => {
    const { setup } = await setupWith({});
    const url = new URL("http://x");
    await expect(setup.handle("POST", "secrets", {}, url)).rejects.toMatchObject({ status: 409, code: "NO_VAULT" });
    await expect(setup.handle("POST", "jobs", { kind: "reindex" }, url)).rejects.toMatchObject({ status: 409 });
    await expect(setup.handle("POST", "schedule", { hour: 3, minute: 30 }, url)).rejects.toMatchObject({ status: 501 });
    await expect(setup.handle("GET", "tokens", undefined, url)).rejects.toMatchObject({ status: 501 });
    await expect(setup.handle("POST", "vault", { action: "github", repo: "player/lisbon-arc" }, url)).rejects.toMatchObject({ status: 400, code: "TOKEN_REQUIRED" });
    await expect(setup.handle("POST", "vault", { action: "open", dir: join(tmp, "nothing-here") }, url)).rejects.toMatchObject({ status: 400, code: "NOT_A_VAULT" });
    const status = await setup.status();
    expect(status.vault).toBeUndefined();
    expect(status.items.find((i) => i.id === "vault")?.state).toBe("todo");
    expect(status.defaults.seeds).toContain("example-relocation");
  });
});
