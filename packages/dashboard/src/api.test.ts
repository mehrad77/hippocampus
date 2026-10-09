import { AuditError, HippoService, VaultVersionError, parseDoc } from "@hippocampus/core";
import { afterAll, describe, expect, it } from "vitest";
import { SECRET_PLAINTEXT, now, richStore } from "./__fixtures__/vault.ts";
import { createDashboardApi, type DashboardApiOptions } from "./api.ts";
import { LOCAL_COOKIE, MAX_BODY, localGuard, localSignIn, type Guard } from "./http.ts";
import { serviceSource } from "./service-source.ts";
import type { SetupPort } from "./setup.ts";
import type { CuratorStatus, DashboardSource } from "./source.ts";

const BASE = "/dashboard/api";
const ORIGIN = "http://127.0.0.1:4100";
const bodies: string[] = [];

afterAll(() => {
  const all = bodies.join("\n");
  expect(all).not.toContain(SECRET_PLAINTEXT);
  expect(all).not.toContain("secret://");
});

const letIn: Guard = () => ({ user: { login: "player" } });

function harness(
  opts: { source?: (full: DashboardSource) => DashboardSource | undefined; setup?: SetupPort; guard?: Guard } & Pick<DashboardApiOptions, "setupKind" | "report"> = {},
) {
  const store = richStore();
  const service = new HippoService(store, { now });
  const full = serviceSource(service, { mode: "local", vault: { kind: "dir", dir: "/vaults/lisbon-arc" } });
  const source = opts.source ? opts.source(full) : full;
  const api = createDashboardApi({ basePath: BASE, source: () => source, setup: opts.setup, guard: opts.guard ?? letIn, setupKind: opts.setupKind, report: opts.report });
  const send = async (method: string, path: string, init: { body?: string; json?: unknown; headers?: Record<string, string> } = {}) => {
    const body = init.json !== undefined ? JSON.stringify(init.json) : init.body;
    const headers = { ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...init.headers };
    const res = await api(new Request(`${ORIGIN}${path.startsWith("/") ? path : `${BASE}/${path}`}`, { method, headers, body }));
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
  };
  return {
    store,
    get: (path: string, headers?: Record<string, string>) => send("GET", path, { headers }),
    post: (path: string, json: unknown, headers?: Record<string, string>) => send("POST", path, { json, headers }),
    send,
  };
}

describe("dashboard API: reads", () => {
  it("session describes the source, user and capabilities", async () => {
    const { get } = harness();
    const r = await get("session");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.body).toEqual({
      mode: "local",
      vault: { kind: "dir", dir: "/vaults/lisbon-arc" },
      campaign: "lisbon-arc",
      human: "player",
      actor: { kind: "human", id: "player" },
      user: { login: "player" },
      capabilities: { rule: true, quest: true, remember: true, party: true, introductions: true, curator: false, setup: "none" },
    });
  });

  it("serves every read model", async () => {
    const { get } = harness();
    const overview = await get("overview");
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ campaign: "lisbon-arc", today: "2026-09-27", counts: { inbox: 3, disputes: 1 } });
    expect(overview.body.inbox.find((e: { id: string }) => e.id === "ep-in2")).toMatchObject({ text: null, secret: true });

    const catalog = await get("catalog");
    expect(catalog.body.entities.map((e: { slug: string }) => e.slug)).toEqual(expect.arrayContaining(["migration-agency", "passport", "harbor-cafe"]));

    expect((await get("graph")).body.edges).toEqual([
      { from: "migration-agency", rel: "handles", to: "residence-permit" },
      { from: "residency-agent", rel: "leads", to: "residence-permit" },
    ]);

    const entity = await get(`entity?ref=${encodeURIComponent("Lisbon Migration")}`);
    expect(entity.body).toMatchObject({ card: { slug: "migration-agency" }, disputes: [{ slug: "dispute-migration-agency-office-address" }] });
    const passport = await get("entity?ref=passport");
    expect(passport.body.facts[0]).toMatchObject({ field: "number", value: null, secret: true });
    expect(passport.body.pending).toEqual([expect.objectContaining({ id: "ep-in2", text: null })]);

    expect((await get("chronicle")).body).toMatchObject({ month: "2026-09", months: ["2026-09"], days: [{ date: "2026-09-25" }] });
    expect((await get("chronicle?month=2026-08")).body).toMatchObject({ month: "2026-08", days: [] });

    const search = await get("search?q=agency&limit=2");
    expect(search.status).toBe(200);
    expect(search.body.entities[0]).toMatchObject({ slug: "migration-agency" });
    expect(search.body.entities.length).toBeLessThanOrEqual(2);

    expect((await get("overview/")).status).toBe(200);
  });

  it("validates query parameters and reports unknown entities", async () => {
    const { get } = harness();
    expect(await get("entity")).toMatchObject({ status: 400, body: { code: "INVALID" } });
    expect(await get("search?q=")).toMatchObject({ status: 400, body: { code: "INVALID" } });
    expect(await get("search?q=agency&limit=99")).toMatchObject({ status: 400, body: { code: "INVALID" } });
    const missing = await get("entity?ref=migration-agencyy");
    expect(missing).toMatchObject({ status: 400, body: { code: "VAULT" } });
    expect(missing.body.error).toContain("did you mean [[migration-agency]]");
  });
});

describe("dashboard API: actions", () => {
  it("rule: the chosen claim becomes canon by the human", async () => {
    const { post, store } = harness();
    const r = await post("actions/rule", { dispute: "dispute-migration-agency-office-address", claim: 1 });
    expect(r).toMatchObject({ status: 200, body: { dispute: "dispute-migration-agency-office-address", entity: "migration-agency", field: "office_address", value: "Belém", secret: false } });
    const fm = parseDoc((await store.read("factions/migration-agency.md"))!).data as { facts: Record<string, Record<string, unknown>> };
    expect(fm.facts.office_address).toMatchObject({ value: "Belém", status: "canon", by: "player" });
    expect(parseDoc((await store.read("disputes/dispute-migration-agency-office-address.md"))!).data).toMatchObject({ status: "resolved" });
    expect(await post("actions/rule", { dispute: "dispute-migration-agency-office-address", claim: 0 })).toMatchObject({ status: 400, body: { code: "VAULT" } });
  });

  it("quest: ticks a clock and reopens an objective", async () => {
    const { post, store } = harness();
    const r = await post("actions/quest", { quest: "residence-permit", reopen: ["health insurance"], clock: { name: "Paperwork", tick: 1 } });
    expect(r).toMatchObject({ status: 200, body: { quest: "[[residence-permit]]", changes: ["○ Get health insurance", "clock Paperwork 3/6"] } });
    const raw = (await store.read("quests/residence-permit.md"))!;
    expect(raw).toContain("- [ ] Get health insurance");
    expect(parseDoc(raw).data).toMatchObject({ clocks: [{ name: "Paperwork", segments: 6, filled: 3 }], updated_by: "player" });
  });

  it("remember: writes an episode to the human's inbox", async () => {
    const { post, store } = harness();
    const r = await post("actions/remember", { text: "Harbor Cafe opens at 8 on weekdays.", kind: "observation", about: ["[[harbor-cafe]]"] });
    expect(r.status).toBe(200);
    expect(r.body.path).toMatch(/^inbox\/player\/.+\.md$/);
    const ep = parseDoc((await store.read(r.body.path))!);
    expect(ep.data).toMatchObject({ id: r.body.id, agent: "player", kind: "observation", about: ["[[harbor-cafe]]"] });
    expect(ep.body).toContain("Harbor Cafe opens at 8 on weekdays.");
  });

  it("party: adds a party note", async () => {
    const { post, store, get } = harness();
    const r = await post("actions/party", { id: "job-scout", title: "Job Scout", lane: "career", authority: ["career"] });
    expect(r).toMatchObject({ status: 200, body: { slug: "job-scout", path: "party/job-scout.md" } });
    expect(parseDoc((await store.read("party/job-scout.md"))!).data).toMatchObject({ type: "party", title: "Job Scout", authority: ["career"] });
    expect((await get("overview")).body.attention.unknownAgents).toEqual([]);
  });
});

describe("dashboard API: introductions", () => {
  it("approve seats the agent with the human's choices", async () => {
    const { post, get, store } = harness();
    await new HippoService(store, { now }).introduce("job-scout", { title: "Job Scout", lane: "Part-time work", host: "Claude Desktop", about: "I watch job boards." });
    expect((await get("overview")).body.attention).toMatchObject({
      unknownAgents: [],
      introductions: [{ agent: "job-scout", title: "Job Scout", lane: "Part-time work", host: "Claude Desktop", about: "I watch job boards." }],
    });
    const r = await post("actions/introduction", { agent: "job-scout", decision: "approve", lane: "Career", authority: ["career"] });
    expect(r).toMatchObject({ status: 200, body: { decision: "approve", agent: "job-scout", path: "party/job-scout.md" } });
    expect(parseDoc((await store.read("party/job-scout.md"))!).data).toMatchObject({ type: "party", title: "Job Scout", lane: "Career", authority: ["career"], host: "Claude Desktop" });
    expect((await get("overview")).body.attention).toMatchObject({ unknownAgents: [], introductions: [] });
    expect(await post("actions/introduction", { agent: "job-scout", decision: "approve" })).toMatchObject({ status: 400, body: { code: "VAULT" } });
  });

  it("dismiss removes the introduction, and the agent is a stranger again", async () => {
    const { post, get, store } = harness();
    await new HippoService(store, { now }).introduce("job-scout", { title: "Job Scout" });
    expect(await post("actions/introduction", { agent: "job-scout", decision: "dismiss" })).toMatchObject({ status: 200, body: { decision: "dismiss", agent: "job-scout" } });
    expect((await get("overview")).body.attention).toMatchObject({ unknownAgents: ["job-scout"], introductions: [] });
    expect(await post("actions/introduction", { agent: "job-scout", decision: "dismiss" })).toMatchObject({ status: 400, body: { code: "VAULT" } });
    expect(await post("actions/introduction", { agent: "job-scout", decision: "maybe" })).toMatchObject({ status: 400, body: { code: "INVALID" } });
    expect(await post("actions/introduction", { agent: "job-scout", decision: "approve", authority: "career" })).toMatchObject({ status: 400, body: { code: "INVALID" } });
  });
});

describe("dashboard API: errors", () => {
  it("refuses bodies that aren't small JSON objects of the right shape", async () => {
    const { send, post } = harness();
    expect(await send("POST", "actions/remember", { body: "text=hi", headers: { "content-type": "application/x-www-form-urlencoded" } })).toMatchObject({
      status: 415,
      body: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });
    expect(await send("POST", "actions/remember", { body: "text", headers: { "content-type": "text/plain" } })).toMatchObject({ status: 415 });
    const huge = JSON.stringify({ text: "x".repeat(MAX_BODY) });
    expect(await send("POST", "actions/remember", { body: huge, headers: { "content-type": "application/json" } })).toMatchObject({ status: 413, body: { code: "TOO_LARGE" } });
    expect(await send("POST", "actions/remember", { body: "{nope", headers: { "content-type": "application/json" } })).toMatchObject({ status: 400, body: { code: "INVALID" } });
    const invalid = await post("actions/rule", { claim: "first" });
    expect(invalid).toMatchObject({ status: 400, body: { code: "INVALID" } });
    expect(invalid.body.error).toMatch(/dispute/);
    expect(await post("actions/quest", { quest: "residence-permit", status: "abandoned" })).toMatchObject({ status: 400, body: { code: "INVALID" } });
    expect(await post("actions/party", { id: "Bad Id", title: "x" })).toMatchObject({ status: 400, body: { code: "VAULT" } });
  });

  it("404 for unknown routes, 405 for other methods", async () => {
    const { get, send, post } = harness();
    expect(await get("nope")).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect(await post("actions/nope", {})).toMatchObject({ status: 404 });
    expect(await post("overview", {})).toMatchObject({ status: 404 });
    expect(await get("actions/rule")).toMatchObject({ status: 404 });
    expect(await get("/elsewhere/overview")).toMatchObject({ status: 404 });
    expect(await send("PUT", "overview")).toMatchObject({ status: 405, body: { code: "METHOD" } });
    expect(await send("DELETE", "actions/rule")).toMatchObject({ status: 405 });
  });

  it("409 NO_VAULT and a setup session while there is no vault", async () => {
    const { get, post } = harness({ source: () => undefined });
    expect(await get("overview")).toMatchObject({ status: 409, body: { code: "NO_VAULT" } });
    expect(await post("actions/remember", { text: "hi" })).toMatchObject({ status: 409, body: { code: "NO_VAULT" } });
    expect((await get("session")).body).toEqual({
      mode: "setup",
      user: { login: "player" },
      capabilities: { rule: false, quest: false, remember: false, party: false, introductions: false, curator: false, setup: "none" },
    });
    expect(await get("setup/status")).toMatchObject({ status: 501, body: { code: "UNSUPPORTED" } });
  });

  it("routes setup to its port", async () => {
    const calls: string[] = [];
    const setup: SetupPort = {
      kind: "local",
      // Only routing is under test, so a bare status will do.
      status: async () => ({ kind: "local", items: [] }) as never,
      handle: async (method, path, body) => {
        calls.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);
        return path === "llm" ? { provider: "lmstudio" } : undefined;
      },
    };
    const { get, post } = harness({ source: () => undefined, setup });
    expect((await get("session")).body.capabilities.setup).toBe("local");
    expect((await get("setup")).body).toMatchObject({ kind: "local" });
    expect((await get("setup/status")).body).toMatchObject({ kind: "local" });
    expect((await get("setup/llm")).body).toEqual({ provider: "lmstudio" });
    expect((await post("setup/schedule", { hour: 3 })).body).toEqual({ ok: true });
    expect(calls).toEqual(["GET llm null", 'POST schedule {"hour":3}']);
  });

  it("501 when the source lacks a capability", async () => {
    const { get, post } = harness({ source: (full) => ({ ...full, rule: undefined, addParty: undefined, introduction: undefined }) });
    expect((await get("session")).body.capabilities).toEqual({ rule: false, quest: true, remember: true, party: false, introductions: false, curator: false, setup: "none" });
    expect(await post("actions/rule", { dispute: "dispute-migration-agency-office-address", claim: 0 })).toMatchObject({ status: 501, body: { code: "UNSUPPORTED" } });
    expect(await post("actions/party", { id: "job-scout", title: "Job Scout" })).toMatchObject({ status: 501 });
    expect(await post("actions/introduction", { agent: "job-scout", decision: "dismiss" })).toMatchObject({ status: 501 });
    expect(await get("curator")).toMatchObject({ status: 501, body: { code: "UNSUPPORTED" } });
    expect(await post("actions/curator", { abort: "run-01" })).toMatchObject({ status: 501 });
  });

  it("a vault that can't load still gets a session that explains why", async () => {
    const { get } = harness({
      source: (full) => ({
        ...full,
        info: () => Promise.reject(new VaultVersionError("this vault is format 9; update hippo")),
      }),
    });
    expect((await get("session")).body).toMatchObject({ mode: "setup", error: { code: "VERSION", message: "this vault is format 9; update hippo" } });
  });
});

describe("dashboard API: hosted", () => {
  const STATUS: CuratorStatus = {
    run: { id: "run-01", curator: "archivist", model: "test-model", started: "2026-09-27T21:00:00.000Z", leaseUntil: "2026-09-27T21:15:00.000Z", live: true, progress: { done: 1, total: 3, unit: "ep:ep-in1" } },
    history: [],
  };
  const withCurator = (calls: string[]) => (full: DashboardSource): DashboardSource => ({
    ...full,
    curator: {
      status: async () => STATUS,
      abort: async (run, via) => {
        calls.push(`${run} ${via}`);
        return { history: [{ ...STATUS.run!, ended: "2026-09-27T21:05:00.000Z", outcome: "aborted", consolidated: 1, failed: 0, skipped: 0, summaries: 0, remaining: 2, commits: 1 }] };
      },
    },
  });
  const owner: Guard = () => ({ user: { login: "player" }, account: { status: "approved", admin: true } });

  it("session reports the hosted setup, the account and the curator", async () => {
    const { get } = harness({ source: withCurator([]), guard: owner, setupKind: "hosted" });
    expect((await get("session")).body).toMatchObject({
      user: { login: "player" },
      account: { status: "approved", admin: true },
      capabilities: { curator: true, setup: "hosted" },
    });
    const waiting = harness({ source: () => undefined, guard: () => ({ user: { login: "player" }, account: { status: "waitlisted", admin: false } }), setupKind: "hosted" });
    expect((await waiting.get("session")).body).toMatchObject({ mode: "setup", account: { status: "waitlisted" }, capabilities: { setup: "hosted" } });
  });

  it("serves the curator's status and aborts a run as the signed-in user", async () => {
    const calls: string[] = [];
    const { get, post } = harness({ source: withCurator(calls), guard: owner });
    expect(await get("curator")).toMatchObject({ status: 200, body: STATUS });
    const aborted = await post("actions/curator", { abort: "run-01" });
    expect(aborted).toMatchObject({ status: 200, body: { history: [{ id: "run-01", outcome: "aborted" }] } });
    expect(calls).toEqual(["run-01 @player"]);
    expect(await post("actions/curator", { abort: "" })).toMatchObject({ status: 400, body: { code: "INVALID" } });
    expect(await post("actions/curator", {})).toMatchObject({ status: 400 });
  });

  it("answers an audit refusal with 409 and its violations, and hands unexpected errors to the reporter", async () => {
    const reported: unknown[] = [];
    const { get, post } = harness({
      source: (full) => ({
        ...full,
        remember: () => Promise.reject(new AuditError([{ path: "factions/migration-agency.md", rule: "agents may only edit quest notes" }])),
        overview: () => Promise.reject(new Error("could not parse: Lisbon Migration office")),
      }),
      report: (err) => reported.push(err),
    });
    expect(await post("actions/remember", { text: "x" })).toMatchObject({
      status: 409,
      body: { code: "AUDIT", violations: [{ path: "factions/migration-agency.md", rule: "agents may only edit quest notes" }] },
    });
    const failed = await get("overview");
    expect(failed).toMatchObject({ status: 500, body: { code: "INTERNAL" } });
    expect(JSON.stringify(failed.body)).not.toContain("Lisbon");
    expect(reported).toHaveLength(1);
  });
});

describe("local guard", () => {
  const TOKEN = "launch-token-for-tests";
  const guarded = () => harness({ guard: localGuard({ port: 4100, token: TOKEN }) });
  const ok = { host: "127.0.0.1:4100", cookie: `${LOCAL_COOKIE}=${TOKEN}` };

  it("421 for a Host that isn't this machine's port (DNS rebinding)", async () => {
    const { get } = guarded();
    expect(await get("overview", { ...ok, host: "attacker.example:4100" })).toMatchObject({ status: 421, body: { code: "MISDIRECTED" } });
    expect(await get("overview", { ...ok, host: "127.0.0.1:4200" })).toMatchObject({ status: 421 });
    expect(await get("overview", { ...ok, host: "localhost:4100" })).toMatchObject({ status: 200 });
    expect(await get("overview", { ...ok, host: "[::1]:4100" })).toMatchObject({ status: 200 });
  });

  it("403 for cross-origin writes", async () => {
    const { post } = guarded();
    const body = { text: "From somewhere else." };
    expect(await post("actions/remember", body, { ...ok, origin: "https://attacker.example" })).toMatchObject({ status: 403, body: { code: "ORIGIN" } });
    expect(await post("actions/remember", body, ok)).toMatchObject({ status: 403 });
    expect(await post("actions/remember", body, { ...ok, origin: "http://127.0.0.1:4100" })).toMatchObject({ status: 200 });
  });

  it("401 without the launch cookie, OK with it", async () => {
    const { get } = guarded();
    expect(await get("overview", { host: ok.host })).toMatchObject({ status: 401, body: { code: "LOCAL_TOKEN" } });
    expect(await get("overview", { host: ok.host, cookie: `${LOCAL_COOKIE}=wrong` })).toMatchObject({ status: 401 });
    expect(await get("overview", { host: ok.host, cookie: `other=1; ${LOCAL_COOKIE}=${TOKEN.slice(0, -1)}` })).toMatchObject({ status: 401 });
    expect(await get("overview", { host: ok.host, cookie: `other=1; ${LOCAL_COOKIE}=${TOKEN}` })).toMatchObject({ status: 200 });
  });

  it("needs no cookie when there is no token", async () => {
    const { get } = harness({ guard: localGuard({ port: 4100 }) });
    expect(await get("overview", { host: ok.host })).toMatchObject({ status: 200 });
  });

  it("sign-in trades the token for a cookie and only redirects inside the dashboard", async () => {
    const signIn = (query: string) => localSignIn(new Request(`${ORIGIN}/dashboard/auth/local?${query}`), { token: TOKEN, basePath: "/dashboard" });
    expect((await signIn("token=nope")).status).toBe(401);
    expect((await signIn("")).status).toBe(401);

    const res = signIn(`token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${LOCAL_COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=2592000$`));

    const next = (n: string) => signIn(`token=${TOKEN}&next=${encodeURIComponent(n)}`).headers.get("location");
    expect(next("/dashboard/council/?tab=disputes")).toBe("/dashboard/council/?tab=disputes");
    expect(next("https://attacker.example/dashboard/")).toBe("/dashboard/");
    expect(next("//attacker.example/dashboard/")).toBe("/dashboard/");
    expect(next("/elsewhere")).toBe("/dashboard/");
    expect(next("/dashboard")).toBe("/dashboard/");

    // The cookie it sets is the one the guard accepts.
    const { get } = guarded();
    expect(await get("overview", { host: ok.host, cookie: cookie.split(";")[0]! })).toMatchObject({ status: 200 });
  });
});
