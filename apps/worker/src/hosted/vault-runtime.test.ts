import { AuditError, CURRENT_VAULT_VERSION, buildVaultFiles, migrate, withTrailers } from "@hippocampus/core";
import type { Question } from "@hippocampus/curator/relay";
import { nodeSqlStorage } from "@hippocampus/index/testing";
import { gitBlobSha } from "@hippocampus/store-github";
import { SEEDS, TEMPLATE } from "@hippocampus/template";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeAll, describe, expect, it } from "vitest";
import { V1_FILES } from "../../../../packages/core/src/__fixtures__/v1-vault.ts";
import { GitHubApp } from "./github-app.ts";
import type { Quotas } from "./quotas.ts";
import { APP, appKeyPair, hostedGitHub } from "./testing.ts";
import { HostedVault, VaultRuntime, type DashboardUser, type VaultGrant, type VaultMeta } from "./vault-runtime.ts";
import { ProviderStop, ScriptedLLM, priceOf, type LLM, type Meter, type StepMix } from "@hippocampus/curator";
import { BUSY_RETRY_MS, type HostedCuratorDeps } from "./hosted-curator.ts";
import { LlmAccess } from "./llm-access.ts";
import { monthSpend } from "./llm-spend.ts";
import { Registry } from "./registry.ts";
import { registryDb } from "./testing.ts";

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

async function setup(
  o: {
    quotas?: Partial<Quotas>;
    storage?: ReturnType<typeof objectStorage>;
    edit?: (files: Record<string, string>) => void;
    files?: Record<string, string>;
    migrate?: typeof migrate;
    hosted?: (clock: () => Date) => HostedCuratorDeps | Promise<HostedCuratorDeps>;
  } = {},
) {
  let t = START;
  const clock = () => new Date(t);
  const github = await hostedGitHub(keys);
  const { gh } = github;
  gh.now = clock;
  const files = o.files ? { ...o.files } : await buildVaultFiles(TEMPLATE, { seed: SEEDS["example-relocation"], now: clock() });
  // job-scout hasn't joined yet, so it can introduce itself.
  delete files["party/job-scout.md"];
  o.edit?.(files);
  const repo = gh.at("player/vault");
  await repo.push(files, "main", "chore: initialize vault [skip ci]\n\nHippo-Actor: bootstrap");
  const installation = gh.addInstallation({ account: { id: 4242, login: "player", type: "User" }, repos: ["player/vault"] });
  const app = new GitHubApp({ appId: APP.id, privateKey: keys.privateKeyPem, apiUrl: "https://api.github.test", fetch: github.fetch, now: clock });
  const storage = o.storage ?? objectStorage();
  const meta: VaultMeta = { vaultId: "01JVAULTPLAYER0000000000000", fullName: "player/vault", branch: "main", repoId: 9001, installationId: installation.id };
  const logged: string[] = [];
  const hosted = await o.hosted?.(clock);
  const deps = {
    app,
    apiUrl: "https://api.github.test",
    webUrl: "https://github.test",
    fetch: github.fetch,
    clock,
    quotas: o.quotas,
    log: (line: string) => void logged.push(line),
    migrate: o.migrate,
    ...(hosted ? { hosted } : {}),
  };
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
  return { gh, repo, app, storage, meta, deps, runtime, connect, api, mints, writes, logged, clock, advance: (ms: number) => (t += ms) };
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

  it("keeps a shared key off agent names another connection holds", async () => {
    const { repo, connect, runtime, api } = await setup();
    const shared = await connect({ ...AGENT_KEY, credential: "key:shared" });
    const other = await connect({ ...AGENT_KEY, credential: "key:other-shared" });
    const homeFinder = await connect({ ...bound("home-finder"), credential: "key:home-finder-laptop" });
    const say = (c: typeof shared, agent: string) => c.call("remember", { agent, text: "Viewing booked for the Alfama flat on Friday." });

    // The first to write as a name holds it.
    expect((await say(shared, "transit-scout")).isError).toBeFalsy();
    expect((await say(shared, "transit-scout")).isError).toBeFalsy();
    const taken = await say(other, "transit-scout");
    expect(taken.isError).toBe(true);
    expect(taken.text).toMatch(/connected through another app or key/);

    // A bound key always writes as its agent, and takes the name from a shared key.
    expect((await say(shared, "home-finder")).isError).toBeFalsy();
    expect((await homeFinder.call("remember", { text: "The landlord prefers email." })).isError).toBeFalsy();
    expect((await say(shared, "home-finder")).isError).toBe(true);

    // Revoked, the bound key lets go. But home-finder is responsible for housing: another connection
    // can't just take the released name until the person hands it over.
    expect(await runtime.releaseClaims(["key:home-finder-laptop"])).toBe(1);
    const pinned = await say(other, "home-finder");
    expect(pinned.isError).toBe(true);
    expect(pinned.text).toMatch(/responsible for part of this vault and its app was disconnected/);
    expect((await api("GET", "names")).body).toMatchObject({ names: expect.arrayContaining([{ agent: "home-finder", state: "released" }, { agent: "campus-agent", state: "free" }]) });
    expect((await api("POST", "actions/hand-over", { agent: "home-finder" })).status).toBe(200);
    expect((await say(other, "home-finder")).isError).toBeFalsy();
    expect((await say(shared, "home-finder")).isError).toBe(true);
    expect((await api("GET", "names")).body).toMatchObject({ names: expect.arrayContaining([{ agent: "home-finder", state: "held" }]) });
    expect((await api("POST", "actions/hand-over", { agent: "nobody-here" })).status).toBe(400);
    // A responsible name nobody has held yet, and a new one, are first come, first served.
    expect((await say(shared, "residency-agent")).isError).toBeFalsy();
    expect((await say(other, "brand-new-agent")).isError).toBeFalsy();
    expect(repo.log().filter((c) => c.message.startsWith("remember(")).length).toBe(7);
  });

  it("lets an agent introduce itself", async () => {
    const { repo, connect } = await setup();
    const { call } = await connect(AGENT_KEY);
    const r = await call("introduce", { agent: "job-scout", title: "Job Scout", lane: "Part-time work in Lisbon" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("Introduced as job-scout");
    expect(repo.files()["party/job-scout.md"]).toContain("lane: Part-time work in Lisbon");
    expect(repo.files()["party/job-scout.md"]).not.toContain("authority");
    expect(trailers(repo.log()[0]!.message)).toContain("Hippo-Actor: agent:job-scout");
  });

  it("lets one shared key (a Grok bot, say) introduce several agents, each filed and signed as itself", async () => {
    const { repo, connect } = await setup();
    const bot = await connect({ ...AGENT_KEY, credential: "key:grok-bot" });
    for (const [agent, title, lane] of [
      ["grok-bot-trip-planner", "Trip Planner", "Plans trips and bookings"],
      ["grok-bot-budget-keeper", "Budget Keeper", "Tracks spending"],
    ] as const) {
      const r = await bot.call("introduce", { agent, title, lane, host: "Grok bot (xAI API)" });
      expect(r.isError, agent).toBeFalsy();
      expect((await bot.call("remember", { agent, text: `${title} is checking in.` })).isError, agent).toBeFalsy();
    }
    const files = Object.keys(repo.files());
    for (const agent of ["grok-bot-trip-planner", "grok-bot-budget-keeper"]) {
      expect(files, agent).toContain(`party/${agent}.md`);
      expect(files.filter((p) => p.startsWith(`inbox/${agent}/`)), agent).toHaveLength(1);
    }
    expect(repo.log().map((c) => trailers(c.message).find((t) => t.startsWith("Hippo-Actor")))).toEqual(
      expect.arrayContaining(["Hippo-Actor: agent:grok-bot-trip-planner", "Hippo-Actor: agent:grok-bot-budget-keeper"]),
    );
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

describe("VaultRuntime: an app's curating switch", () => {
  const APP: VaultGrant = { scopes: ["read", "remember", "goal", "curate"], via: "oauth", credential: "oauth:claude", curate: false };
  it("holds the app's curate scope back until the owner switches it on, and tells the agent how", async () => {
    const { connect, runtime } = await setup();
    const tools = async (grant: VaultGrant) => (await (await connect(grant)).client.listTools()).tools.map((t) => t.name);
    const off = await connect(APP);
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain("sleep_start");
    expect(off.client.getInstructions()).toMatch(/turned "May curate" off.*Setup → Connected apps/);
    expect((await off.call("onboard", { agent: "residency-agent" })).text).toMatch(/can't run sleep right now.*Setup → Connected apps/);

    await runtime.setCurate("oauth:claude", true);
    const on = await connect(APP);
    expect((await on.client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["sleep_start", "sleep_answer", "sleep_skip"]));
    expect(on.client.getInstructions()).toContain("sleep_start");
    expect((await on.call("onboard", { agent: "residency-agent" })).text).not.toContain("can't run sleep");

    // The switch beats what the app was connected with, in both directions.
    await runtime.setCurate("oauth:claude", false);
    expect(await tools({ ...APP, curate: true })).not.toContain("sleep_start");
    expect(await tools({ ...APP, credential: "oauth:other", curate: true })).toContain("sleep_start");
  });

  it("lists what was switched, forgets it with the connection, and says who can curate when the app can't", async () => {
    const { connect, runtime } = await setup();
    await runtime.setCurate("oauth:claude", true);
    expect(await runtime.curation(["oauth:claude", "oauth:never"])).toEqual({ "oauth:claude": true });
    await runtime.releaseClaims(["oauth:claude"]);
    expect(await runtime.curation(["oauth:claude"])).toEqual({});

    // A member's app never had the scope: only an owner can let an app curate.
    const member = await connect({ scopes: ["read", "remember", "goal"], via: "oauth", credential: "oauth:member" });
    expect(member.client.getInstructions()).toMatch(/only a vault's owner can let an app curate/);
    // A key with no curate scope points at the curator key.
    const key = await connect(AGENT_KEY);
    expect(key.client.getInstructions()).toMatch(/no curator key.*Nightly curation/);
    // A curator key gets the usual instructions and nothing about not curating.
    const curator = await connect(CURATOR_KEY);
    expect(curator.client.getInstructions()).not.toContain("can't run sleep");
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
    expect((err as AuditError).violations).toContainEqual({ path: note, rule: "agents may only edit goal notes" });

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

  it("keeps a renamed inbox folder out of the object's SQLite too", async () => {
    const { repo, connect, api, storage } = await setup({
      edit: (files) => {
        files["_hippo/config.yaml"] += "\nfolders:\n  inbox: memos\n";
      },
    });
    await (await connect(bound("home-finder"))).call("remember", { text: "Viewing in Alfama on Friday at 18:00." });
    expect((await api("GET", "overview")).status).toBe(200);

    const stored = new Set((storage.sql.exec("SELECT sha FROM blobs").toArray() as { sha: string }[]).map((r) => r.sha));
    const memos = Object.entries(repo.files()).filter(([p]) => p.startsWith("memos/") && p.endsWith(".md") && !p.endsWith("README.md"));
    expect(memos.length).toBeGreaterThan(0);
    for (const [, content] of memos) expect(stored.has(await gitBlobSha(content))).toBe(false);
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
  it("refuses memories past the inbox limit", async () => {
    const { repo, connect } = await setup({ quotas: { pendingEpisodes: 1 } });
    const { call } = await connect(AGENT_KEY);
    expect((await call("remember", { agent: "home-finder", text: "Viewing on Friday." })).isError).toBeFalsy();
    const full = await call("remember", { agent: "home-finder", text: "Viewing on Saturday." });
    expect(full.isError).toBe(true);
    expect(full.text).toContain("The inbox already holds 1 memories waiting for sleep");
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
      name: "lisbon-arc",
      campaign: "lisbon-arc",
      human: "player",
      humans: ["player"],
      actor: { kind: "human", id: "player" },
      user: { login: "player" },
      account: { status: "approved", admin: false },
      capabilities: { rule: true, goal: true, quest: true, proposal: true, retract: true, remember: true, confidential: true, data: true, party: true, domains: true, secrets: true, reveal: true, authority: true, names: true, handOver: true, introductions: true, curator: true, upgrade: true, setup: "hosted" },
    });

    const r = await api("POST", "actions/remember", { text: "My residence card arrives next week." });
    expect(r.status).toBe(200);
    expect(r.body.path).toMatch(/^inbox\/player\//);
    expect(trailers(repo.log()[0]!.message)).toContain("Hippo-Actor: human");
    expect(await api("POST", "actions/domain", { ids: ["pets"] })).toMatchObject({ status: 200, body: { added: ["pets"] } });
    expect(repo.log()[0]!.message).toMatch(/^config\(player via @player\): add domain pets/);
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

describe("VaultRuntime: dashboard humans", () => {
  const twoHumans = (files: Record<string, string>) => {
    files["_hippo/config.yaml"] = files["_hippo/config.yaml"]!.replace(/^humans:\n(?:\s+- .*\n)+/m, "humans:\n  - { id: player }\n  - { id: flatmate, github: Flatmate-GH }\n");
  };
  const as = async (runtime: VaultRuntime, login: string) => {
    const res = await runtime.dashboard(new Request(`${ORIGIN}/dashboard/api/session`), { login, account: { status: "approved", admin: false } });
    return (await res.json()) as { humans: string[]; actor: { kind: string; id: string } };
  };

  it("acts as the human whose github: is the signed-in login, else the primary human", async () => {
    const { runtime } = await setup({ edit: twoHumans });
    const flatmate = await as(runtime, "flatmate-gh");
    expect(flatmate.humans).toEqual(["player", "flatmate"]);
    expect(flatmate.actor).toEqual({ kind: "human", id: "flatmate" });
    expect((await as(runtime, "player")).actor).toEqual({ kind: "human", id: "player" });
    expect((await as(runtime, "someone-else")).actor).toEqual({ kind: "human", id: "player" });
  });

  it("acts as a shared vault's member by their seat, never the primary human, and keeps viewers to reading", async () => {
    const { runtime, repo } = await setup({ edit: twoHumans });
    const user = (role: "member" | "viewer", human?: string): DashboardUser => ({ login: "someone-else", account: { status: "approved", admin: false }, role, ...(human ? { human } : {}) });
    const session = async (u: DashboardUser) => {
      const res = await runtime.dashboard(new Request(`${ORIGIN}/dashboard/api/session`), u);
      return { status: res.status, body: (await res.json()) as { actor?: { id: string }; capabilities?: Record<string, unknown>; code?: string } };
    };
    const member = await session(user("member", "flatmate"));
    expect(member.body.actor).toEqual({ kind: "human", id: "flatmate" });
    expect(member.body.capabilities).toMatchObject({ remember: true, domains: true, secrets: false, reveal: false, upgrade: false, curator: false });
    // Their human was taken out of the config: no seat, no fallback to the primary human.
    expect(await session(user("member", "nobody"))).toMatchObject({ status: 403, body: { code: "NO_HUMAN" } });
    expect(await session(user("member"))).toMatchObject({ status: 403 });
    const post = (path: string, body: unknown, u: DashboardUser) =>
      runtime.dashboard(new Request(`${ORIGIN}/dashboard/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), u);
    expect((await post("actions/domain", { ids: ["side-project"] }, user("member", "flatmate"))).status).toBe(200);
    // The secrets key decides who can read the vault's secrets: a member can't set or replace it.
    expect((await post("actions/secrets", { recipient: `age1${"q".repeat(58)}`, replace: true }, user("member", "flatmate"))).status).toBe(501);
    expect(repo.files()["_hippo/config.yaml"]).not.toContain("age1qqqq");
    // Nor read the ciphertext, or rotate it: the key, and so the secrets, are the owner's.
    const read = await runtime.dashboard(new Request(`${ORIGIN}/dashboard/api/secrets`), user("member", "flatmate"));
    expect(read.status).toBe(501);
    expect((await post("actions/rotate-secrets", { recipient: `age1${"q".repeat(58)}`, files: [] }, user("member", "flatmate"))).status).toBe(501);
    expect(repo.files()["_hippo/config.yaml"]).toMatch(/^domains: \[.*side-project\]$/m);

    const viewer = await session(user("viewer", "flatmate"));
    expect(viewer.body.capabilities).toMatchObject({ remember: false, rule: false, goal: false, party: false, domains: false, secrets: false, reveal: false });
    expect((await runtime.dashboard(new Request(`${ORIGIN}/dashboard/api/secrets`), user("viewer", "flatmate"))).status).toBe(501);
    const write = await runtime.dashboard(new Request(`${ORIGIN}/dashboard/api/actions/remember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) }), user("viewer", "flatmate"));
    expect(write.status).toBe(501);
    expect((await post("actions/domain", { ids: ["garden"] }, user("viewer", "flatmate"))).status).toBe(501);
    const before = repo.log().length;
    expect(await runtime.linkHuman("flatmate", { github: "someone-else" }, "@player")).toEqual({ changed: true });
    expect(repo.log()).toHaveLength(before + 1);
    expect(repo.files()["_hippo/config.yaml"]).toContain("github: someone-else");
  });
});

describe("VaultRuntime: an older vault waits for its owner's Upgrade", () => {
  const isMigration = (c: { message: string }) => c.message.startsWith("chore: migrate vault to format");
  const upgrade = (api: Awaited<ReturnType<typeof setup>>["api"]) => api("POST", "actions/upgrade-vault", {});

  it("migrates nothing on read: data, MCP and the consent page answer VAULT_UPGRADE_NEEDED, the session still loads", async () => {
    const { repo, api, connect, runtime, writes } = await setup({ files: V1_FILES });
    const overview = await api("GET", "overview");
    expect(overview.status).toBe(409);
    expect(overview.body).toEqual({ code: "VAULT_UPGRADE_NEEDED", error: expect.stringContaining("dashboard") });
    expect((await api("GET", "catalog")).body.code).toBe("VAULT_UPGRADE_NEEDED");
    expect((await api("POST", "actions/remember", { text: "My residence card arrives next week." })).status).toBe(501);

    const session = await api("GET", "session");
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ mode: "worker", actor: { kind: "human", id: "player" }, capabilities: { upgrade: true, remember: false } });

    const mcp = await runtime.mcp(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" }), AGENT_KEY);
    expect(mcp.status).toBe(409);
    expect(await mcp.json()).toMatchObject({ code: "VAULT_UPGRADE_NEEDED" });
    expect(await connect(AGENT_KEY).catch((e: unknown) => e)).toBeInstanceOf(Error);
    await expect(runtime.party()).rejects.toMatchObject({ code: "VAULT_UPGRADE_NEEDED" });

    expect(writes()).toBe(0);
    expect(repo.log()).toHaveLength(1);
  });

  it("upgrades once when the owner clicks, as the migration actor, leaving the inbox alone", async () => {
    const { repo, api, connect, logged } = await setup({ files: V1_FILES });
    const r = await upgrade(api);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ upgraded: true, from: 1, to: CURRENT_VAULT_VERSION, notes: expect.any(Array) });
    expect(r.body.changed).toBeGreaterThan(0);

    const log = repo.log();
    expect(log).toHaveLength(2);
    const [commit] = log;
    expect(commit!.message.split("\n")[0]).toBe(`chore: migrate vault to format v${CURRENT_VAULT_VERSION}`);
    expect(trailers(commit!.message)).toEqual(["Hippo-Actor: migration"]);
    // The vault's CI validates the migrated tree.
    expect(commit!.message).not.toContain("[skip ci]");
    expect(commit!.author).toEqual({ name: "Hippocampus", email: "hippocampus@users.noreply.github.com" });

    const files = repo.files();
    expect(files["_hippo/config.yaml"]).toMatch(new RegExp(`^version: ${CURRENT_VAULT_VERSION}$`, "m"));
    expect(files["goals/residence-permit.md"]).toContain("type: goal");
    expect(files["quests/residence-permit.md"]).toBeUndefined();
    for (const [path, content] of Object.entries(V1_FILES)) if (path.startsWith("inbox/") || path.startsWith("disputes/")) expect(files[path]).toBe(content);

    // Everything works now, and another click changes nothing.
    expect((await api("GET", "overview")).status).toBe(200);
    expect((await (await connect(AGENT_KEY)).call("onboard", { agent: "residency-agent" })).isError).toBeFalsy();
    expect((await upgrade(api)).body).toMatchObject({ upgraded: false, from: CURRENT_VAULT_VERSION, to: CURRENT_VAULT_VERSION });
    expect(repo.log().filter(isMigration)).toHaveLength(1);
    expect(logged.some((l) => l.includes('"route":"vault/upgrade"') && l.includes('"status":200'))).toBe(true);
  });

  it("upgrades once when clicks arrive together", async () => {
    const { repo, api } = await setup({ files: V1_FILES });
    const results = await Promise.all([upgrade(api), upgrade(api), upgrade(api)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(repo.log().filter(isMigration)).toHaveLength(1);
  });

  it("answers 409 CONFLICT when someone pushed meanwhile, and upgrades on the next click", async () => {
    let pushed = false;
    const ctx: { repo?: Awaited<ReturnType<typeof setup>>["repo"] } = {};
    const racing: typeof migrate = async (store, config, opts) => {
      const result = await migrate(store, config, opts);
      if (!pushed) {
        pushed = true;
        await ctx.repo!.push({ "_hippo/config.yaml": `${V1_FILES["_hippo/config.yaml"]}\n# edited on GitHub\n` }, "main", "docs: note\n\nHippo-Actor: human");
      }
      return result;
    };
    const { repo, api, logged } = await setup({ files: V1_FILES, migrate: racing });
    ctx.repo = repo;
    const refused = await upgrade(api);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("CONFLICT");
    expect(repo.log().filter(isMigration)).toHaveLength(0);
    expect(logged).toContainEqual(expect.stringContaining('"code":"CONFLICT"'));
    expect((await api("GET", "overview")).body.code).toBe("VAULT_UPGRADE_NEEDED");

    expect((await upgrade(api)).status).toBe(200);
    expect(repo.log().filter(isMigration)).toHaveLength(1);
    expect(repo.files()["_hippo/config.yaml"]).toContain("# edited on GitHub");
  });

  it("refuses an upgrade the audit doesn't allow with the `hippo migrate` hint, and nothing but the code in the log", async () => {
    const forged: typeof migrate = async (store, config, opts) => {
      const result = await migrate(store, config, opts);
      return { ...result, changes: [...result.changes, { path: "inbox/game-master/2026-09-27T100000-arrival.md", content: "---\nagent: game-master\n---\nRewritten.\n" }] };
    };
    const { repo, api, logged, writes } = await setup({ files: V1_FILES, migrate: forged });
    const refused = await upgrade(api);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "VAULT_UPGRADE_REFUSED" });
    expect(JSON.stringify(refused.body)).toContain("hippo migrate");
    expect(JSON.stringify(refused.body)).not.toContain("inbox/");
    expect(writes()).toBe(0);
    expect(repo.log()).toHaveLength(1);
    const lines = logged.filter((l) => l.includes("vault/upgrade"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(Object.keys(JSON.parse(l)).sort()).toEqual(["code", "ms", "route", "status", "vault"]);
  });

  it("aborts a sleep run that was open across the upgrade", async () => {
    const { repo, connect, deps, storage, meta } = await setup();
    await (await connect(bound("home-finder"))).call("remember", { text: "New landlord is João Silva." });
    const step = (await (await connect(CURATOR_KEY)).call("sleep_start", { model: "test-model" })).json();
    expect(step.state).toBe("ask");

    // The repo goes back to a v1 vault (as if restored), and the object restarts.
    const now = repo.files();
    await repo.push({ ...Object.fromEntries(Object.keys(now).map((p) => [p, null])), ...V1_FILES }, "main", "chore: restore\n\nHippo-Actor: human");
    const restarted = new VaultRuntime({ ...deps, storage, meta });
    const post = (path: string) => restarted.dashboard(new Request(`${ORIGIN}/dashboard/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), OWNER);
    expect((await restarted.dashboard(new Request(`${ORIGIN}/dashboard/api/overview`), OWNER)).status).toBe(409);
    expect((await restarted.relay.status()).run).toBeDefined();

    expect((await post("actions/upgrade-vault")).status).toBe(200);
    const { run, history } = await restarted.relay.status();
    expect(run).toBeUndefined();
    expect(history[0]).toMatchObject({ id: step.run, outcome: "aborted" });
    expect(repo.log().filter(isMigration)).toHaveLength(1);
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

describe("VaultRuntime: hosted curation with the owner's key", () => {
  const TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
  const MODEL_KEY = "sk-ant-test-landlord-0000";
  const MIX: StepMix = { mentions: "claude-haiku-5-5", match: "claude-haiku-5-5", claims: "claude-haiku-5-5", summary: "claude-haiku-5-5" };
  const VAULT_ID = "01JVAULTPLAYER0000000000000";
  const ACCOUNT = 4242;
  const HOUR = 3;
  /** START is 09:00 UTC; the vault's first night is the next day at 03:00. */
  const FIRST_NIGHT = Date.parse("2026-10-02T03:00:00.000Z");

  /** A careful model, paid for through the meter as a real one would be. */
  const careful = ({ meter, mix }: { meter: Meter; mix: StepMix }): LLM => {
    const llm = new ScriptedLLM();
    for (const name of ["mentions", "match", "claims", "summary"]) llm.respond(name, () => answer({ name } as Question));
    return llm.bill(meter, priceOf("anthropic", mix.mentions)!, { input: 1000, output: 200 });
  };

  async function world(o: { answerer?: HostedCuratorDeps["answerer"]; monthCapUsd?: number; runCapUsd?: number } = {}) {
    let db!: Awaited<ReturnType<typeof registryDb>>;
    let access!: LlmAccess;
    let models = 0;
    const s = await setup({
      hosted: async (clock) => {
        db = await registryDb();
        const registry = new Registry(db, clock);
        await registry.signIn({ id: ACCOUNT, login: "player" }, { admin: true });
        const { vault } = await registry.claimVault({ accountId: ACCOUNT, installationId: 1, repoId: 9001, fullName: "player/vault", branch: "main" });
        // The registry's vault under the id this object is named by; nothing else refers to it yet.
        await db.all("PRAGMA foreign_keys = OFF");
        await db.all("UPDATE vaults SET id = ?, status = 'ready' WHERE id = ?", [VAULT_ID, vault.id]);
        await db.all("PRAGMA foreign_keys = ON");
        access = new LlmAccess(db, TOKEN_KEY, clock);
        await access.save(ACCOUNT, { provider: "anthropic", steps: MIX, key: MODEL_KEY, monthCapMicros: (o.monthCapUsd ?? 5) * 1e6, runCapMicros: (o.runCapUsd ?? 1) * 1e6 });
        return {
          access,
          db,
          accountOf: async (id: string) => (id === VAULT_ID ? ACCOUNT : undefined),
          answerer: (a) => {
            models++;
            expect(a.key).toBe(MODEL_KEY);
            return (o.answerer ?? careful)(a);
          },
        };
      },
    });
    const remember = async (text = "New landlord is João Silva.") => (await s.connect(bound("home-finder"))).call("remember", { text });
    const schedule = async (hour: number | null = HOUR) => {
      await access.setSchedule(VAULT_ID, hour);
      return s.runtime.setHostedSchedule(hour);
    };
    /** To the night, and the alarm goes off. */
    const night = async () => {
      s.advance(FIRST_NIGHT - s.clock().getTime());
      await s.runtime.alarm();
    };
    const hostedLines = () => s.logged.filter((l) => l.includes("curator/hosted")).map((l) => JSON.parse(l) as Record<string, unknown>);
    const onboard = async () => (await (await s.connect(AGENT_KEY)).call("onboard", { agent: "residency-agent" })).text;
    return { ...s, db: () => db, access: () => access, models: () => models, remember, schedule, night, hostedLines, onboard };
  }

  it("runs the night itself when memories wait: commits as the hosted curator, through the audit, and pays from the account", async () => {
    const w = await world();
    await w.remember();
    expect(await w.schedule()).toMatchObject({ enabled: true, hourUtc: HOUR, nextRun: new Date(FIRST_NIGHT).toISOString() });
    expect(w.storage.alarm()).toBe(FIRST_NIGHT);

    await w.night();
    const { run, history } = await w.runtime.relay.status();
    expect(run).toBeUndefined();
    expect(history[0]).toMatchObject({ curator: "hosted", outcome: "done", consolidated: 1, model: "anthropic:claude-haiku-5-5" });
    expect(history[0]!.cost!.micros).toBeGreaterThan(0);
    expect(await monthSpend(w.db(), ACCOUNT, w.clock())).toBe(history[0]!.cost!.micros);

    // Every curated commit went through the audited store as the curator, signed as the hosted run.
    const files = w.repo.files();
    expect(Object.keys(files).filter((p) => p.startsWith("inbox/"))).toEqual(["inbox/README.md"]);
    expect(files["characters/joao-silva.md"]).toContain("The player's landlord in Lisbon.");
    const curated = w.repo.log().filter((c) => c.message.startsWith("chore(sleep)"));
    expect(curated.length).toBeGreaterThan(1);
    for (const c of curated) expect(trailers(c.message)).toEqual(expect.arrayContaining(["Hippo-Actor: curator", "Hippo-Curator: hosted", "Hippo-Model: anthropic:claude-haiku-5-5"]));

    // Logged by route, status, cost and a hashed vault id: no memory, no key.
    const lines = w.hostedLines();
    expect(lines.map((l) => l.route)).toEqual(["curator/hosted night", "curator/hosted"]);
    expect(lines[1]).toMatchObject({ status: 200, micros: history[0]!.cost!.micros });
    for (const l of w.logged) {
      expect(l).not.toContain("João");
      expect(l).not.toContain(MODEL_KEY);
      expect(l).not.toContain(VAULT_ID);
    }
    // Tomorrow's night is on the books.
    expect(await w.runtime.hostedCurator()).toMatchObject({ enabled: true, nextRun: "2026-10-03T03:00:00.000Z", lastRun: { outcome: "done", consolidated: 1 } });
  });

  it("drives a long night in slices, each re-armed a second later", async () => {
    const w = await world();
    for (const text of ["New landlord is João Silva.", "The landlord prefers rent by bank transfer.", "The landlord's agency is in Alfama."]) await w.remember(text);
    await w.schedule();
    await w.night();
    // Rulings, then the first two episodes: three units, and the run waits for its next slice.
    expect((await w.runtime.relay.status()).run).toMatchObject({ curator: "hosted" });
    expect(w.storage.alarm()).toBe(w.clock().getTime() + 1000);
    expect(w.hostedLines().at(-1)).toMatchObject({ route: "curator/hosted", status: 202 });
    w.advance(1000);
    await w.runtime.alarm();
    const { run, history } = await w.runtime.relay.status();
    expect(run).toBeUndefined();
    expect(history[0]).toMatchObject({ curator: "hosted", outcome: "done" });
    expect(history[0]!.consolidated + history[0]!.failed).toBe(3);
  });

  it("skips a night with nothing waiting, and books the next", async () => {
    const w = await world();
    await w.schedule();
    await w.night();
    expect((await w.runtime.relay.status()).history).toEqual([]);
    expect(w.models()).toBe(0);
    expect(w.hostedLines()).toEqual([expect.objectContaining({ route: "curator/hosted night", code: "IDLE" })]);
    expect((await w.runtime.hostedCurator()).nextRun).toBe(new Date(FIRST_NIGHT + 24 * 3600_000).toISOString());
  });

  it("waits on an agent's open run, trying again in 30 minutes", async () => {
    const w = await world();
    await w.remember();
    await w.schedule();
    w.advance(FIRST_NIGHT - w.clock().getTime() - 60_000);
    const agent = (await (await w.connect(CURATOR_KEY)).call("sleep_start", { model: "test-model", curator: "archivist", force: true })).json();
    expect(agent.state).toBe("ask");
    w.advance(60_000);
    await w.runtime.alarm();
    expect((await w.runtime.relay.status()).run).toMatchObject({ curator: "archivist" });
    expect(w.hostedLines().at(-1)).toMatchObject({ code: "BUSY" });
    expect((await w.runtime.hostedCurator()).nextRun).toBe(new Date(FIRST_NIGHT + BUSY_RETRY_MS).toISOString());
  });

  it("honours a paused account: no run, and agents hear that a standby runs", async () => {
    const w = await world();
    await w.remember();
    await w.schedule();
    await w.access().pause(ACCOUNT, "auth");
    await w.night();
    expect((await w.runtime.relay.status()).history).toEqual([]);
    expect(w.hostedLines().at(-1)).toMatchObject({ code: "PAUSED" });
    expect(await w.onboard()).toContain("Nightly curation: Hippocampus runs it at 03:00 UTC, but it is paused: the model key was refused; a standby curator will run if one is set up.");
  });

  it("pauses the account when the month's budget is reached, not when the run's is", async () => {
    // A month cap below one call's worst case: the first call is refused.
    const w = await world({ monthCapUsd: 0.0001 });
    await w.remember();
    await w.schedule();
    await w.night();
    expect((await w.runtime.relay.status()).history[0]).toMatchObject({ curator: "hosted", outcome: "aborted", stop: "budget", consolidated: 0 });
    expect(Object.keys(w.repo.files()).filter((p) => p.startsWith("inbox/home-finder/"))).toHaveLength(1);
    expect((await w.access().settings(ACCOUNT))!.paused).toBe("budget:2026-10");
    expect(w.hostedLines().at(-1)).toMatchObject({ code: "BUDGET" });
  });

  it("passes over a memory too large for the run's cap until the cap is raised, without pausing", async () => {
    const w = await world({ runCapUsd: 0.0001 });
    await w.remember();
    await w.schedule();
    await w.night();
    const [first] = (await w.runtime.relay.status()).history;
    expect(first).toMatchObject({ outcome: "done", consolidated: 0, tooLarge: [expect.stringMatching(/^ep-/)] });
    expect((await w.access().settings(ACCOUNT))!.paused).toBeUndefined();

    // The next run leaves it out: nothing else waits, so there's no run at all.
    expect(await w.runtime.runHostedCuratorNow()).toMatchObject({ code: "IDLE" });
    // A higher cap lets it back in.
    await w.access().save(ACCOUNT, { provider: "anthropic", steps: MIX, monthCapMicros: 5e6, runCapMicros: 1e6 });
    expect(await w.runtime.runHostedCuratorNow()).toMatchObject({ run: expect.stringMatching(/^run-/) });
    expect(w.storage.alarm()).toBe(w.clock().getTime());
    await w.runtime.alarm();
    expect((await w.runtime.relay.status()).history[0]).toMatchObject({ outcome: "done", consolidated: 1 });
  });

  it("pauses the account when the provider refuses the key, leaving the memory in the inbox", async () => {
    const refusing = (): LLM => ({
      name: "refused",
      object: async () => {
        throw new ProviderStop("auth", 401);
      },
    });
    const w = await world({ answerer: refusing });
    await w.remember();
    await w.schedule();
    await w.night();
    expect((await w.runtime.relay.status()).history[0]).toMatchObject({ outcome: "aborted", stop: "auth", failed: 0 });
    expect((await w.access().settings(ACCOUNT))!.paused).toBe("auth");
    expect(Object.keys(w.repo.files()).filter((p) => p.startsWith("inbox/home-finder/"))).toHaveLength(1);
  });

  it("closes an open hosted run at its next alarm once the operator switches it off, and starts none", async () => {
    const on = await world();
    await on.remember();
    expect(await on.runtime.runHostedCuratorNow()).toMatchObject({ run: expect.stringMatching(/^run-/) });

    // The same object after a deploy without HIPPO_HOSTED_CURATOR=on.
    const off = new VaultRuntime({ ...on.deps, hosted: { ...on.deps.hosted!, off: true }, storage: on.storage, meta: on.meta });
    await off.alarm();
    const { run, history } = await off.relay.status();
    expect(run).toBeUndefined();
    expect(history[0]).toMatchObject({ curator: "hosted", outcome: "aborted" });
    expect(on.models()).toBe(0);
    expect(await off.runHostedCuratorNow()).toMatchObject({ code: "OFF" });
  });

  it("re-arms a lost alarm for the Cron's backstop, and leaves a good one alone", async () => {
    const w = await world();
    await w.schedule();
    await w.storage.deleteAlarm();
    expect(await w.runtime.ensureAlarm()).toBe(true);
    expect(w.storage.alarm()).toBe(FIRST_NIGHT);
    expect(await w.runtime.ensureAlarm()).toBe(false);
    // Switched off in the registry: the night is dropped, and nothing is armed for it.
    await w.access().setSchedule(VAULT_ID, null);
    await w.storage.deleteAlarm();
    expect(await w.runtime.ensureAlarm()).toBe(false);
    expect(w.storage.alarm()).toBeNull();
  });

  it("tells a standby curator it isn't needed while hosted curation is healthy, records each check-in, and runs it when paused", async () => {
    const w = await world();
    await w.remember();
    await w.schedule();
    const curator = await w.connect(CURATOR_KEY);
    const skipped = (await curator.call("sleep_start", { model: "test-model", curator: "claude-code-curator" })).json();
    expect(skipped).toMatchObject({ state: "not_needed", reason: "hosted" });
    expect((await w.runtime.relay.status()).run).toBeUndefined();
    expect(await w.runtime.hostedCurator()).toMatchObject({ standby: { curator: "claude-code-curator", at: w.clock().toISOString(), decision: "hosted" } });

    await w.access().pause(ACCOUNT, "credit");
    const ran = (await curator.call("sleep_start", { model: "test-model", curator: "claude-code-curator" })).json();
    expect(ran.state).toBe("ask");
    expect(await w.runtime.hostedCurator()).toMatchObject({ standby: { curator: "claude-code-curator", decision: "needed" } });
    expect(await w.onboard()).toContain("paused: the model provider's credit ran out; the standby curator claude-code-curator will run.");
  });

  it("leaves a vault without hosted curation as it was: an empty inbox still runs, and agents hear who curates", async () => {
    const w = await world();
    expect(await w.onboard()).toContain("No curator yet: 0 memories waiting.");
    await w.remember();
    expect(await w.onboard()).toContain("No curator yet: 1 memory waiting.");

    const curator = await w.connect(CURATOR_KEY);
    let step = (await curator.call("sleep_start", { model: "test-model", curator: "archivist" })).json();
    expect(step.state).toBe("ask");
    while (step.state === "ask") step = (await curator.call("sleep_answer", { run: step.run, answers: step.questions.map((q: Question) => ({ question_id: q.id, value: JSON.stringify(answer(q)) })) })).json();
    expect(step.state).toBe("done");
    // Nothing waits now, and the vault has no hosted curation: the run still happens, as before.
    expect((await curator.call("sleep_start", { model: "test-model", curator: "archivist" })).json().state).not.toBe("not_needed");
    expect(await w.runtime.hostedCurator()).toEqual({ enabled: false });
    expect(await w.onboard()).toContain("Nightly curation: the curator archivist runs it (last run 2026-10-01).");
  });

  it("says when Hippocampus curates, in every agent's onboard", async () => {
    const w = await world();
    await w.remember();
    await w.schedule();
    await w.night();
    expect(await w.onboard()).toContain("Nightly curation: Hippocampus runs it at 03:00 UTC (last run 2026-10-02).");
  });
});
