import { HippoService } from "@hippocampus/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createHippoServer, type Scope } from "../../mcp/src/server.ts";
import { SECRET_PLAINTEXT, now, richStore } from "./__fixtures__/vault.ts";
import { createDashboardApi } from "./api.ts";
import { HttpError, errorResponse } from "./http.ts";
import { mcpSource } from "./mcp-source.ts";
import { serviceSource } from "./service-source.ts";
import { capabilities, type DashboardSource } from "./source.ts";

const MCP_URL = "https://hippo.example/mcp";
const roundTrip = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

async function linked(opts: { agent?: string; scopes?: Scope[] } = {}) {
  const store = richStore();
  const service = new HippoService(store, { now });
  const server = createHippoServer({ service, ...opts });
  const client = new Client({ name: "parity", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { store, local: serviceSource(service, { mode: "local", vault: { kind: "memory" } }), remote: await mcpSource(client, { url: MCP_URL }) };
}

/** Both sources' error, as the API would answer it. */
async function failure(p: Promise<unknown>) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  const res = errorResponse(err);
  return { status: res.status, body: await res.json() };
}

describe("MCP source parity", () => {
  it("returns exactly what the local service returns", async () => {
    const { local, remote } = await linked({ agent: "residency-agent" });
    const reads: [string, (s: DashboardSource) => Promise<unknown>][] = [
      ["overview", (s) => s.overview()],
      ["catalog", (s) => s.catalog()],
      ["graph", (s) => s.graph()],
      ["entity by slug", (s) => s.entity("migration-agency")],
      ["entity by alias", (s) => s.entity("Lisbon Migration")],
      ["entity by link", (s) => s.entity("[[residence-permit]]")],
      ["secret entity", (s) => s.entity("passport")],
      ["party entity", (s) => s.entity("residency-agent")],
      ["chronicle (latest)", (s) => s.chronicle()],
      ["chronicle (month)", (s) => s.chronicle("2026-09")],
      ["chronicle (empty month)", (s) => s.chronicle("2026-08")],
      ["search", (s) => s.search("agency")],
      ["search with spaces", (s) => s.search("Lisbon Migration & passport")],
      ["search with a limit", (s) => s.search("residency", 3)],
      ["search with limit 1", (s) => s.search("agency", 1)],
      ["search with limit 20", (s) => s.search("agency", 20)],
    ];
    for (const [name, read] of reads) expect(roundTrip(await read(remote)), name).toEqual(roundTrip(await read(local)));
  });

  it("fails the same way", async () => {
    const { local, remote } = await linked({ agent: "residency-agent" });
    const missing = await failure(remote.entity("migration-agencyy"));
    expect(missing).toEqual(await failure(local.entity("migration-agencyy")));
    expect(missing).toMatchObject({ status: 400, body: { code: "VAULT" } });
  });

  it("never carries the secret over the wire", async () => {
    const { remote } = await linked({ agent: "residency-agent" });
    const all = JSON.stringify([await remote.overview(), await remote.entity("passport"), await remote.search("passport")]);
    expect(all).not.toContain(SECRET_PLAINTEXT);
    expect(all).not.toContain("secret://");
  });

  it("identifies as the token's agent", async () => {
    const { remote } = await linked({ agent: "Residency-Agent", scopes: ["read"] });
    expect(await remote.info()).toEqual({
      mode: "mcp",
      vault: { kind: "mcp", url: MCP_URL },
      name: "lisbon-arc",
      campaign: "lisbon-arc",
      human: "player",
      humans: ["player"],
      actor: { kind: "agent", id: "residency-agent" },
    });
  });

  it("offers only what the agent's scopes allow, and never the human's actions", async () => {
    const caps = async (opts: { agent?: string; scopes?: Scope[] }) => capabilities((await linked(opts)).remote, "none");
    const none = { rule: false, goal: false, quest: false, proposal: false, retract: false, remember: false, confidential: false, data: false, party: false, domains: false, authority: false, names: false, handOver: false, introductions: false, curator: false, upgrade: false, setup: "none" };
    expect(await caps({ agent: "residency-agent" })).toEqual({ ...none, goal: true, quest: true, remember: true, confidential: true, data: true });
    expect(await caps({ agent: "residency-agent", scopes: ["read"] })).toEqual(none);
    expect(await caps({ agent: "residency-agent", scopes: ["read", "remember"] })).toEqual({ ...none, remember: true, confidential: true, data: true });
    expect(await caps({ agent: "residency-agent", scopes: ["read", "goal"] })).toEqual({ ...none, goal: true, quest: true });
    // Keys from before goals carry `quest`.
    expect(await caps({ agent: "residency-agent", scopes: ["read", "quest"] })).toEqual({ ...none, goal: true, quest: true });
    // Unbound, every write would need an agent id the dashboard can't choose.
    expect(await caps({})).toEqual(none);
    expect(capabilities((await linked()).local, "none")).toEqual({ rule: true, goal: true, quest: true, proposal: true, retract: true, remember: true, confidential: true, data: true, party: true, domains: true, authority: true, names: false, handOver: false, introductions: true, curator: false, upgrade: false, setup: "none" });
  });

  it("files writes under the agent", async () => {
    const { remote, store } = await linked({ agent: "residency-agent" });
    const r = await remote.remember!({ text: "Agency confirmed the appointment by email.", kind: "fact", about: ["[[migration-agency]]"] });
    expect(r.path).toMatch(/^inbox\/residency-agent\/.+\.md$/);
    expect(await store.read(r.path)).toContain("Agency confirmed the appointment by email.");

    expect(await remote.quest!("residence-permit", { reopen: ["health insurance"], clock: { name: "Paperwork", tick: 1 } })).toEqual({
      quest: "[[residence-permit]]",
      changes: ["○ Get health insurance", "progress 3/6"],
    });
    expect(await store.read("goals/residence-permit.md")).toContain("updated_by: residency-agent");

    expect(await remote.goal!("residence-permit", { progress: { tick: 1 }, counterparty: "[[migration-agency]]" })).toEqual({
      goal: "[[residence-permit]]",
      changes: expect.arrayContaining(["progress 4/6"]),
    });
    expect(await store.read("goals/residence-permit.md")).toContain("counterparty: \"[[migration-agency]]\"");

    const err = await remote.quest!("no-such-quest", { status: "done" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, code: "VAULT", message: 'no goal "no-such-quest"' });
  });

  it("uses update_quest on a server from before goals", async () => {
    const store = richStore();
    const service = new HippoService(store, { now });
    const server = createHippoServer({ service, agent: "residency-agent" });
    const client = new Client({ name: "parity", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    // An old server: no update_goal, and whoami without `humans` or `name`.
    const listTools = client.listTools.bind(client);
    client.listTools = async (...args) => {
      const r = await listTools(...args);
      return { ...r, tools: r.tools.filter((t) => t.name !== "update_goal") };
    };
    const readResource = client.readResource.bind(client);
    client.readResource = async (...args) => {
      const r = await readResource(...args);
      if (args[0].uri !== "hippo://dashboard/whoami") return r;
      const { humans: _h, name: _n, ...old } = JSON.parse((r.contents[0] as { text: string }).text);
      return { ...r, contents: [{ ...r.contents[0]!, text: JSON.stringify(old) }] };
    };
    const remote = await mcpSource(client);
    expect(await remote.info()).toMatchObject({ name: "lisbon-arc", humans: ["player"] });
    expect(await remote.goal!("residence-permit", { progress: { tick: 1 }, due: "2026-12-01" })).toEqual({ goal: "[[residence-permit]]", changes: expect.arrayContaining(["progress 3/6"]) });
    await expect(remote.goal!("residence-permit", { repeat: { every: "1m" } })).rejects.toMatchObject({ status: 501 });
  });

  it("says when a server's remember predates confidential episodes and data, and refuses them rather than dropping them", async () => {
    const store = richStore();
    const server = createHippoServer({ service: new HippoService(store, { now }), agent: "residency-agent" });
    const client = new Client({ name: "parity", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const listTools = client.listTools.bind(client);
    client.listTools = async (...args) => {
      const r = await listTools(...args);
      const old = (t: (typeof r.tools)[number]) => {
        const { confidential: _c, data: _d, ...properties } = t.inputSchema.properties ?? {};
        return { ...t, inputSchema: { ...t.inputSchema, properties } };
      };
      return { ...r, tools: r.tools.map((t) => (t.name === "remember" ? old(t) : t)) };
    };
    const remote = await mcpSource(client);
    expect(capabilities(remote, "none")).toMatchObject({ remember: true, confidential: false, data: false });
    await expect(remote.remember!({ text: "The agency's private line.", confidential: true })).rejects.toMatchObject({ status: 501, code: "UNSUPPORTED" });
    await expect(remote.remember!({ text: "Rent paid.", kind: "fact", data: { amount: 900 } })).rejects.toMatchObject({ status: 501, message: expect.stringContaining("data") });
    expect((await remote.remember!({ text: "Agency confirmed the appointment by email." })).path).toMatch(/^inbox\/residency-agent\//);
  });

  it("serves the API over MCP", async () => {
    const { remote } = await linked({ agent: "residency-agent", scopes: ["read", "remember"] });
    const api = createDashboardApi({ basePath: "/dashboard/api", source: () => remote, guard: () => ({}) });
    const get = async (path: string) => (await api(new Request(`http://127.0.0.1:4100/dashboard/api/${path}`))).json();
    expect(await get("session")).toMatchObject({ mode: "mcp", actor: { kind: "agent", id: "residency-agent" }, capabilities: { rule: false, goal: false, quest: false, remember: true, party: false } });
    expect(await get("entity?ref=passport")).toMatchObject({ card: { slug: "passport" } });
    const rule = await api(
      new Request("http://127.0.0.1:4100/dashboard/api/actions/rule", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dispute: "dispute-migration-agency-office-address", claim: 0 }) }),
    );
    expect(rule.status).toBe(501);
  });
});
