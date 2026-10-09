import { AuditError, buildVaultFiles, withTrailers } from "@hippocampus/core";
import type { Question } from "@hippocampus/curator/relay";
import { nodeSqlStorage } from "@hippocampus/index/testing";
import { gitBlobSha } from "@hippocampus/store-github";
import { SEEDS, TEMPLATE } from "@hippocampus/template";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeAll, describe, expect, it } from "vitest";
import { GitHubApp } from "./github-app.ts";
import type { Quotas } from "./quotas.ts";
import { APP, appKeyPair, hostedGitHub } from "./testing.ts";
import { HostedVault, VaultRuntime, type DashboardUser, type VaultGrant, type VaultMeta } from "./vault-runtime.ts";

let keys: Awaited<ReturnType<typeof appKeyPair>>;
beforeAll(async () => {
  keys = await appKeyPair();
});

const START = new Date("2026-10-01T09:00:00.000Z").getTime();
const ORIGIN = "https://hippo.test";
const OWNER: DashboardUser = { login: "player", account: { status: "approved", admin: false } };

const AGENT_KEY: VaultGrant = { scopes: ["read", "remember", "quest"], via: "key", keyKind: "agent" };
const CURATOR_KEY: VaultGrant = { scopes: ["read", "curate"], via: "key", keyKind: "curator" };
const bound = (agent: string, scopes: VaultGrant["scopes"] = ["read", "remember", "quest"]): VaultGrant => ({ agent, scopes, via: "key", keyKind: "bound" });

/** A Durable Object's storage on node:sqlite, with the alarm and deleteAll it also has. */
function objectStorage() {
  const s = nodeSqlStorage();
  let alarm: number | null = null;
  const tables = () => s.sql.exec("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray() as { name: string; sql: string }[];
  return Object.assign(s, {
    tables: () => tables().map((t) => t.name),
    alarm: () => alarm,
    async setAlarm(t: number) {
      alarm = t;
    },
    async getAlarm() {
      return alarm;
    },
    async deleteAlarm() {
      alarm = null;
    },
    async deleteAll() {
      // Virtual tables first: dropping one drops its shadow tables.
      const all = tables().sort((a, b) => Number(/VIRTUAL/i.test(b.sql)) - Number(/VIRTUAL/i.test(a.sql)));
      for (const t of all) s.sql.exec(`DROP TABLE IF EXISTS "${t.name}"`).toArray();
    },
  });
}

async function setup(o: { quotas?: Partial<Quotas>; storage?: ReturnType<typeof objectStorage> } = {}) {
  let t = START;
  const clock = () => new Date(t);
  const github = await hostedGitHub(keys);
  const { gh } = github;
  gh.now = clock;
  const files = await buildVaultFiles(TEMPLATE, { seed: SEEDS["example-relocation"], now: clock() });
  // job-scout hasn't joined yet, so it can introduce itself.
  delete files["party/job-scout.md"];
  const repo = gh.at("player/vault");
  await repo.push(files, "main", "chore: initialize vault [skip ci]\n\nHippo-Actor: bootstrap");
  const installation = gh.addInstallation({ account: { id: 4242, login: "player", type: "User" }, repos: ["player/vault"] });
  const app = new GitHubApp({ appId: APP.id, privateKey: keys.privateKeyPem, apiUrl: "https://api.github.test", fetch: github.fetch, now: clock });
  const storage = o.storage ?? objectStorage();
  const meta: VaultMeta = { vaultId: "01JVAULTPLAYER0000000000000", fullName: "player/vault", branch: "main", repoId: 9001, installationId: installation.id };
  const deps = { app, apiUrl: "https://api.github.test", webUrl: "https://github.test", fetch: github.fetch, clock, quotas: o.quotas, log: () => undefined };
  const runtime = new VaultRuntime({ ...deps, storage, meta });

  const connect = async (grant: VaultGrant, rt: { mcp: VaultRuntime["mcp"] } = runtime) => {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: (url, init) => rt.mcp(new Request(url, init), grant) });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = r.content[0]!.text;
      return { text, isError: r.isError, json: () => JSON.parse(text) };
    };
    return { client, call };
  };
  const api = async (method: string, path: string, body?: unknown, rt: { dashboard: VaultRuntime["dashboard"] } = runtime) => {
    const init: RequestInit = body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    const res = await rt.dashboard(new Request(`${ORIGIN}/dashboard/api/${path}`, init), OWNER);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const mints = () => gh.calls.filter((c) => /^POST \/app\/installations\/\d+\/access_tokens$/.test(c)).length;
  const writes = () => gh.calls.filter((c) => c.startsWith("POST git/") || c.startsWith("PATCH git/")).length;
  return { gh, repo, app, storage, meta, deps, runtime, connect, api, mints, writes, advance: (ms: number) => (t += ms) };
}

const trailers = (message: string) => message.slice(message.lastIndexOf("\n\n") + 2).split("\n");

/** What a careful curator would answer about the landlord episode. */
function answer(q: Question): unknown {
  switch (q.name) {
    case "mentions":
      return { entities: [{ name: "João Silva", type: "character", aliases: [], domains: ["housing"] }] };
    case "match":
      return { match: "new" };
    case "claims":
      return { facts: [{ entity: "joao-silva", field: "role", value: "landlord", secret: false }], relations: [], quests: [] };
    default:
      return { summary: "The player's landlord in Lisbon." };
  }
}

describe("VaultRuntime: MCP", () => {
  it("files an any-agent key's memory under the agent it names, and nobody else", async () => {
    const { repo, connect } = await setup();
    const { call } = await connect(AGENT_KEY);
    expect((await call("onboard", { agent: "residency-agent" })).text).toContain("Residency Agent");

    const r = await call("remember", { agent: "residency-agent", text: "The permit office moved its appointments to Thursdays." });
    expect(r.isError).toBeFalsy();
    const log = repo.log();
    expect(log).toHaveLength(2);
    expect(log[0]!.message).toMatch(/^remember\(residency-agent\): ep-/);
    expect(trailers(log[0]!.message)).toContain("Hippo-Actor: agent:residency-agent");
    expect(Object.keys(repo.files()).filter((p) => p.startsWith("inbox/residency-agent/"))).toHaveLength(1);

    for (const agent of ["player", "human", undefined]) {
      const refused = await call("remember", { ...(agent ? { agent } : {}), text: "Pretending to be someone else." });
      expect(refused.isError).toBe(true);
    }
    expect(repo.log()).toHaveLength(2);
  });

  it("lets an agent introduce itself", async () => {
    const { repo, connect } = await setup();
    const { call } = await connect(AGENT_KEY);
    const r = await call("introduce", { agent: "job-scout", title: "Job Scout", lane: "Part-time work in Lisbon" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("Introduced as job-scout");
    expect(Object.keys(repo.files()).filter((p) => p.startsWith("inbox/job-scout/_introduction-"))).toHaveLength(1);
    expect(trailers(repo.log()[0]!.message)).toContain("Hippo-Actor: agent:job-scout");
  });

  it("binds a bound key's memories to its agent, whatever the call says", async () => {
    const { repo, connect } = await setup();
    const { call } = await connect(bound("home-finder"));
    expect((await call("remember", { agent: "residency-agent", text: "Viewing in Alfama on Friday at 18:00." })).isError).toBeFalsy();
    expect(trailers(repo.log()[0]!.message)).toContain("Hippo-Actor: agent:home-finder");
    expect(Object.keys(repo.files()).filter((p) => p.startsWith("inbox/"))).toEqual(["inbox/README.md", expect.stringMatching(/^inbox\/home-finder\//)]);
  });

  it("gives a read-only key no way to write", async () => {
    const { repo, connect } = await setup();
    const { client, call } = await connect(bound("campus-agent", ["read"]));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("recall");
    expect(tools).not.toContain("remember");
    expect(tools.filter((t) => t.startsWith("sleep_"))).toEqual([]);
    expect((await call("remember", { text: "x" })).isError).toBe(true);
    expect(repo.log()).toHaveLength(1);
  });

  it("commits concurrent writers one at a time", async () => {
    const { repo, connect } = await setup();
    const [a, b] = await Promise.all([connect(bound("campus-agent")), connect(bound("home-finder"))]);
    const results = await Promise.all([a.call("remember", { text: "Enrolment opens on 2026-10-15." }), b.call("remember", { text: "Viewing on Friday at 18:00." })]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(repo.log().map((c) => c.message.split(":")[0])).toEqual(expect.arrayContaining(["remember(campus-agent)", "remember(home-finder)"]));
    expect(Object.keys(repo.files()).filter((p) => /^inbox\/[^/]+\/[^_]/.test(p))).toHaveLength(2);
  });

  it("answers anything but POST with 405", async () => {
    const { runtime } = await setup();
    expect((await runtime.mcp(new Request(`${ORIGIN}/mcp`), AGENT_KEY)).status).toBe(405);
  });
});

describe("VaultRuntime: sleep through a curator key", () => {
  it("runs a whole night over MCP, committing as the curator, with status and abort on the dashboard", async () => {
    const { repo, connect, api, storage } = await setup();
    const agent = await connect(bound("home-finder"));
    await agent.call("remember", { text: "New landlord is João Silva." });

    const { client, call } = await connect(CURATOR_KEY);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["sleep_start", "sleep_answer", "sleep_abort"]));
    let step = (await call("sleep_start", { model: "test-model", curator: "archivist" })).json();
    expect(step).toMatchObject({ state: "ask", progress: { done: 0, total: 1 } });
    const live = (await api("GET", "curator")).body;
    expect(live.run).toMatchObject({ id: step.run, curator: "archivist", live: true });
    expect(storage.alarm()).toBe(Date.parse(live.run.leaseUntil) + 1000);

    while (step.state === "ask") {
      const answers = step.questions.map((q: Question) => ({ question_id: q.id, value: JSON.stringify(answer(q)) }));
      const r = await call("sleep_answer", { run: step.run, answers });
      expect(r.isError).toBeFalsy();
      step = r.json();
      expect(step.rejected).toBeUndefined();
    }
    expect(step.report).toMatchObject({ curator: "archivist", consolidated: [{ agent: "home-finder", created: ["joao-silva"] }], remaining: 0 });

    const files = repo.files();
    expect(Object.keys(files).filter((p) => p.startsWith("inbox/"))).toEqual(["inbox/README.md"]);
    expect(files["characters/joao-silva.md"]).toContain("The player's landlord in Lisbon.");
    const curated = repo.log().filter((c) => c.message.startsWith("chore(sleep)"));
    expect(curated.length).toBeGreaterThan(0);
    for (const c of curated) expect(trailers(c.message)).toEqual(expect.arrayContaining(["Hippo-Actor: curator", "Hippo-Curator: archivist", "Hippo-Model: test-model"]));

    const status = await api("GET", "curator");
    expect(status.body).toEqual({ history: [expect.objectContaining({ id: step.run, curator: "archivist", outcome: "done", consolidated: 1, commits: curated.length })] });

    // A run the human stops from the dashboard.
    await agent.call("remember", { text: "The landlord prefers rent by bank transfer." });
    const again = (await call("sleep_start", { model: "test-model", curator: "archivist" })).json();
    const aborted = await api("POST", "actions/curator", { abort: again.run });
    expect(aborted.status).toBe(200);
    expect(aborted.body.run).toBeUndefined();
    expect(aborted.body.history.map((h: { outcome: string }) => h.outcome)).toEqual(["aborted", "done"]);
    expect((await api("POST", "actions/curator", { abort: "run-elsewhere" })).status).toBe(400);
  });

  it("finishes a run whose curator went quiet when the alarm fires", async () => {
    const { connect, runtime, advance, storage } = await setup();
    await (await connect(bound("home-finder"))).call("remember", { text: "New landlord is João Silva." });
    const { call } = await connect(CURATOR_KEY);
    const step = (await call("sleep_start", { model: "test-model" })).json();
    expect(storage.alarm()).not.toBeNull();

    await runtime.alarm();
    expect((await runtime.relay.status()).run).toMatchObject({ id: step.run, live: true });

    advance(16 * 60_000);
    await runtime.alarm();
    const { run, history } = await runtime.relay.status();
    expect(run).toBeUndefined();
    expect(history[0]).toMatchObject({ id: step.run, outcome: "expired", remaining: 1 });
  });
});

describe("VaultRuntime: writes are audited", () => {
  const agent = { kind: "agent", agent: "residency-agent", scopes: ["read", "remember", "quest"] } as const;

  it("refuses a forged change set before it reaches GitHub", async () => {
    const { repo, runtime, writes } = await setup();
    const store = runtime.store(agent);
    const note = "factions/migration-agency.md";
    const forged = (actor: string) => ({ message: withTrailers("chore: tidy up", { "Hippo-Actor": actor }) });

    const err = await store.apply!([{ path: note, content: "---\ntype: faction\n---\n# Gone\n" }], forged("agent:residency-agent")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect((err as AuditError).violations).toContainEqual({ path: note, rule: "agents may only edit quest notes" });

    // Claims the principal can't make: another agent, the human, the curator, or none at all.
    for (const meta of [forged("agent:home-finder"), forged("human"), forged("curator"), { message: "chore: tidy up" }]) {
      const e = await store.apply!([{ path: "inbox/residency-agent/2026-10-01T090000-x.md", content: "---\nagent: residency-agent\n---\nx\n" }], meta).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AuditError);
      expect((e as AuditError).violations[0]!.path).toBe("(commit)");
    }
    expect(writes()).toBe(0);
    expect(repo.log()).toHaveLength(1);
  });
});

describe("VaultRuntime: storage", () => {
  it("keeps inbox blobs out of the object's SQLite", async () => {
    const { repo, connect, api, storage } = await setup();
    await (await connect(bound("home-finder"))).call("remember", { text: "Viewing in Alfama on Friday at 18:00." });
    expect((await api("GET", "overview")).status).toBe(200);

    const stored = new Set((storage.sql.exec("SELECT sha FROM blobs").toArray() as { sha: string }[]).map((r) => r.sha));
    expect(stored.size).toBeGreaterThan(10);
    const inbox = Object.entries(repo.files()).filter(([p]) => p.startsWith("inbox/"));
    expect(inbox.length).toBe(2);
    for (const [, content] of inbox) expect(stored.has(await gitBlobSha(content))).toBe(false);
    expect(stored.has(await gitBlobSha(repo.files()["party/home-finder.md"]!))).toBe(true);
  });

  it("reuses the stored installation token across restarts, and mints anew after a 401", async () => {
    const { gh, storage, deps, meta, runtime, mints, api } = await setup();
    expect((await api("GET", "overview")).status).toBe(200);
    expect(mints()).toBe(1);
    const [first] = storage.sql.exec("SELECT token FROM tokens").toArray() as { token: string }[];
    expect([...gh.tokens.get(first!.token)!.repos!]).toEqual(["player/vault"]);
    expect(gh.tokens.get(first!.token)!.permissions).toEqual({ contents: "write", metadata: "read" });

    // The object restarts: same storage, new runtime.
    const restarted = new VaultRuntime({ ...deps, storage, meta });
    expect((await api("GET", "overview", undefined, restarted)).status).toBe(200);
    expect(mints()).toBe(1);

    // The token stops working (revoked, or expired early): the next request mints a fresh one and carries on.
    gh.tokens.delete(first!.token);
    expect((await api("GET", "catalog", undefined, runtime)).status).toBe(200);
    expect(mints()).toBe(2);
    const [second] = storage.sql.exec("SELECT token FROM tokens").toArray() as { token: string }[];
    expect(second!.token).not.toBe(first!.token);
  });
});

describe("VaultRuntime: quotas", () => {
  it("refuses memories past the inbox limit, and introductions past theirs", async () => {
    const { repo, connect } = await setup({ quotas: { pendingEpisodes: 1, pendingIntroductions: 0 } });
    const { call } = await connect(AGENT_KEY);
    expect((await call("remember", { agent: "home-finder", text: "Viewing on Friday." })).isError).toBeFalsy();
    const full = await call("remember", { agent: "home-finder", text: "Viewing on Saturday." });
    expect(full.isError).toBe(true);
    expect(full.text).toContain("The inbox already holds 1 memories waiting for sleep");
    const intro = await call("introduce", { agent: "job-scout", title: "Job Scout" });
    expect(intro.isError).toBe(true);
    expect(intro.text).toContain("introductions are already waiting");
    expect(repo.log()).toHaveLength(2);
  });

  it("caps sleep runs per day", async () => {
    const { connect, advance } = await setup({ quotas: { sleepRunsPerDay: 1 } });
    await (await connect(bound("home-finder"))).call("remember", { text: "New landlord is João Silva." });
    const { call } = await connect(CURATOR_KEY);
    const first = (await call("sleep_start", { model: "test-model" })).json();
    await call("sleep_abort", { run: first.run });
    const refused = await call("sleep_start", { model: "test-model" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("started 1 sleep runs today");
    advance(24 * 3600_000);
    expect((await call("sleep_start", { model: "test-model" })).isError).toBeFalsy();
  });

  it("answers 413 VAULT_TOO_LARGE for a vault past the size limit", async () => {
    const { runtime, api } = await setup({ quotas: { vaultFiles: 10 } });
    const overview = await api("GET", "overview");
    expect(overview.status).toBe(413);
    expect(overview.body.code).toBe("VAULT_TOO_LARGE");
    expect((await api("GET", "session")).body.error).toMatchObject({ code: "VAULT_TOO_LARGE" });

    const rpc = (method: string, params: unknown) =>
      runtime.mcp(
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
        AGENT_KEY,
      );
    const listed = await rpc("tools/list", {});
    expect(listed.status).toBe(200);
    const recall = await rpc("tools/call", { name: "recall", arguments: { query: "permit" } });
    expect(recall.status).toBe(413);
    expect(await recall.json()).toMatchObject({ code: "VAULT_TOO_LARGE" });

    const bytes = await setup({ quotas: { vaultBytes: 2_000 } });
    expect((await bytes.api("GET", "overview")).body.code).toBe("VAULT_TOO_LARGE");
  });
});

describe("VaultRuntime: dashboard", () => {
  it("describes a hosted session, and acts as the human", async () => {
    const { repo, api } = await setup();
    const session = await api("GET", "session");
    expect(session.status).toBe(200);
    expect(session.body).toEqual({
      mode: "worker",
      vault: { kind: "github", repo: "player/vault", branch: "main", url: "https://github.test/player/vault" },
      campaign: "lisbon-arc",
      human: "player",
      actor: { kind: "human", id: "player" },
      user: { login: "player" },
      account: { status: "approved", admin: false },
      capabilities: { rule: true, quest: true, remember: true, party: true, introductions: true, curator: true, setup: "hosted" },
    });

    const r = await api("POST", "actions/remember", { text: "My residence card arrives next week." });
    expect(r.status).toBe(200);
    expect(r.body.path).toMatch(/^inbox\/player\//);
    expect(trailers(repo.log()[0]!.message)).toContain("Hippo-Actor: human");
    expect((await api("POST", "setup/vault", {})).status).toBe(501);
  });

  it("lists the party and seats an agent for the consent page", async () => {
    const { repo, runtime } = await setup();
    const party = await runtime.party();
    expect(party.map((p) => p.id)).toEqual(["archivist", "campus-agent", "game-master", "home-finder", "residency-agent"]);
    expect(party.find((p) => p.id === "home-finder")!.title).toBe("Home Finder");

    expect(await runtime.addParty({ id: "job-scout", title: "Job Scout", authority: ["career"] }, "@player")).toEqual({ slug: "job-scout" });
    expect(repo.files()["party/job-scout.md"]).toContain("career");
    expect(repo.log()[0]!.message).toMatch(/^party\(player via @player\): add job-scout/);
    expect(trailers(repo.log()[0]!.message)).toContain("Hippo-Actor: human");
    await expect(runtime.addParty({ id: "player", title: "Player" }, "@player")).rejects.toThrow(/is the human, not an agent/);
  });
});

describe("HostedVault: the object's lifecycle", () => {
  const ask = (host: HostedVault) => host.dashboard(new Request(`${ORIGIN}/dashboard/api/overview`), OWNER);

  it("refuses until configured and while disconnected, and forgets everything when destroyed", async () => {
    const { storage, deps, meta } = await setup();
    const host = new HostedVault(storage, deps);
    const before = await ask(host);
    expect(before.status).toBe(503);
    expect(await before.json()).toMatchObject({ code: "VAULT_NOT_CONFIGURED" });
    expect((await host.mcp(new Request(`${ORIGIN}/mcp`, { method: "POST" }), AGENT_KEY)).status).toBe(503);
    await expect(host.party()).rejects.toThrow(/^VAULT_NOT_CONFIGURED/);
    await expect(host.configure({ ...meta, fullName: "not a repo" })).rejects.toThrow(/owner\/name/);

    await host.configure(meta);
    await host.configure(meta);
    expect((await ask(host)).status).toBe(200);
    expect(await host.party()).toHaveLength(5);

    await host.disconnect("uninstalled");
    const gone = await ask(host);
    expect(gone.status).toBe(503);
    expect(await gone.json()).toMatchObject({ code: "VAULT_DISCONNECTED", reason: "uninstalled" });
    await expect(host.addParty({ id: "job-scout", title: "Job Scout" }, "@player")).rejects.toThrow(/^VAULT_DISCONNECTED/);
    await host.alarm();

    // Reconnecting picks up where it left off.
    await host.configure(meta);
    expect((await host.dashboard(new Request(`${ORIGIN}/dashboard/api/search?q=permit`), OWNER)).status).toBe(200);
    expect(storage.tables()).toEqual(expect.arrayContaining(["blobs", "tokens", "vault_meta", "sleep_run", "docs"]));

    await host.destroy();
    expect(storage.tables()).toEqual([]);
    expect(storage.alarm()).toBeNull();
    expect((await ask(host)).status).toBe(503);
  });

  it("answers 500 MISCONFIGURED when its settings can't be built, without logging why", async () => {
    const { storage, meta } = await setup();
    const host = new HostedVault(storage, () => {
      throw new Error("The hosted app needs GITHUB_APP_PRIVATE_KEY");
    });
    await host.configure(meta);
    const res = await ask(host);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "MISCONFIGURED" });
  });
});
