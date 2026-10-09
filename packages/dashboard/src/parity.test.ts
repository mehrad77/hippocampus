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
    expect(await remote.info()).toEqual({ mode: "mcp", vault: { kind: "mcp", url: MCP_URL }, campaign: "lisbon-arc", human: "player", actor: { kind: "agent", id: "residency-agent" } });
  });

  it("offers only what the agent's scopes allow, and never the human's actions", async () => {
    const caps = async (opts: { agent?: string; scopes?: Scope[] }) => capabilities((await linked(opts)).remote, "none");
    const none = { rule: false, quest: false, remember: false, party: false, introductions: false, curator: false, setup: "none" };
    expect(await caps({ agent: "residency-agent" })).toEqual({ ...none, quest: true, remember: true });
    expect(await caps({ agent: "residency-agent", scopes: ["read"] })).toEqual(none);
    expect(await caps({ agent: "residency-agent", scopes: ["read", "remember"] })).toEqual({ ...none, remember: true });
    expect(await caps({ agent: "residency-agent", scopes: ["read", "quest"] })).toEqual({ ...none, quest: true });
    // Unbound, every write would need an agent id the dashboard can't choose.
    expect(await caps({})).toEqual(none);
    expect(capabilities((await linked()).local, "none")).toEqual({ rule: true, quest: true, remember: true, party: true, introductions: true, curator: false, setup: "none" });
  });

  it("files writes under the agent", async () => {
    const { remote, store } = await linked({ agent: "residency-agent" });
    const r = await remote.remember!({ text: "Agency confirmed the appointment by email.", kind: "fact", about: ["[[migration-agency]]"] });
    expect(r.path).toMatch(/^inbox\/residency-agent\/.+\.md$/);
    expect(await store.read(r.path)).toContain("Agency confirmed the appointment by email.");

    expect(await remote.quest!("residence-permit", { reopen: ["health insurance"], clock: { name: "Paperwork", tick: 1 } })).toEqual({
      quest: "[[residence-permit]]",
      changes: ["○ Get health insurance", "clock Paperwork 3/6"],
    });
    expect(await store.read("quests/residence-permit.md")).toContain("updated_by: residency-agent");

    const err = await remote.quest!("no-such-quest", { status: "done" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, code: "VAULT", message: 'no quest "no-such-quest"' });
  });

  it("serves the API over MCP", async () => {
    const { remote } = await linked({ agent: "residency-agent", scopes: ["read", "remember"] });
    const api = createDashboardApi({ basePath: "/dashboard/api", source: () => remote, guard: () => ({}) });
    const get = async (path: string) => (await api(new Request(`http://127.0.0.1:4100/dashboard/api/${path}`))).json();
    expect(await get("session")).toMatchObject({ mode: "mcp", actor: { kind: "agent", id: "residency-agent" }, capabilities: { rule: false, quest: false, remember: true, party: false } });
    expect(await get("entity?ref=passport")).toMatchObject({ card: { slug: "passport" } });
    const rule = await api(
      new Request("http://127.0.0.1:4100/dashboard/api/actions/rule", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dispute: "dispute-migration-agency-office-address", claim: 0 }) }),
    );
    expect(rule.status).toBe(501);
  });
});
