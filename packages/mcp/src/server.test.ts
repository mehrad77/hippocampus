import { HippoService } from "@hippocampus/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { createHippoServer, type Scope } from "./server.ts";

async function connect(agent?: string, scopes?: Scope[]) {
  const store = fixtureStore();
  const server = createHippoServer({ service: new HippoService(store), agent, scopes });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]!.text, isError: r.isError };
  };
  return { client, call, store };
}

describe("MCP server", () => {
  it("lists the agent tools and the handbook resource", async () => {
    const { client } = await connect("residency-agent");
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["ask_canon", "briefing", "get", "neighbors", "onboard", "recall", "remember", "update_quest"]);
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(["hippo://handbook"]);
    const res = await client.readResource({ uri: "hippo://handbook" });
    expect((res.contents[0] as { text: string }).text).toContain("Player's Handbook");
  });

  it("round-trips remember → recall with a bound identity", async () => {
    const { call, store } = await connect("residency-agent");
    expect((await call("onboard")).text).toContain("You are Residency Agent");
    const r = await call("remember", { text: "Insurance policy from Acme Health starts 2026-10-01", kind: "fact" });
    expect(r.isError).toBeFalsy();
    expect((await store.list("inbox/residency-agent")).length).toBe(1);
    expect((await call("recall", { query: "acme health insurance" })).text).toContain("2026-10-01");
  });

  it("requires an agent id when the connection is not bound", async () => {
    const { call } = await connect();
    expect((await call("remember", { text: "x" })).isError).toBe(true);
    expect((await call("remember", { text: "x", agent: "campus-agent" })).isError).toBeFalsy();
  });

  it("returns helpful errors for unknown entities", async () => {
    const { call } = await connect("campus-agent");
    const r = await call("get", { entity: "migration agencyy" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("did you mean [[migration-agency]]");
  });

  it("only exposes what the connection's scopes allow", async () => {
    const readOnly = await connect("campus-agent", ["read"]);
    const tools = (await readOnly.client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("remember");
    expect(tools).not.toContain("update_quest");
    expect(tools).toContain("recall");
    expect((await readOnly.call("remember", { text: "x" })).isError).toBe(true);
    expect(await readOnly.store.list("inbox")).toEqual([]);

    const writeOnly = await connect("campus-agent", ["remember"]);
    expect((await writeOnly.client.listTools()).tools.map((t) => t.name)).toEqual(["remember"]);
    await expect(writeOnly.client.readResource({ uri: "hippo://handbook" })).rejects.toThrow();
    await expect(writeOnly.client.readResource({ uri: "hippo://dashboard/overview" })).rejects.toThrow(/not found/);
    await expect(writeOnly.client.readResource({ uri: "hippo://dashboard/whoami" })).rejects.toThrow(/not found/);
  });

  it("reopens quest objectives", async () => {
    const { call } = await connect("residency-agent");
    expect((await call("update_quest", { quest: "residence-permit", complete: ["health insurance"] })).text).toContain("✓ Get health insurance");
    const r = await call("update_quest", { quest: "residence-permit", reopen: ["health insurance"] });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("○ Get health insurance");
    expect((await call("get", { entity: "residence-permit" })).text).toContain("- done: false\n    text: Get health insurance");
  });
});

describe("dashboard resources", () => {
  const read = async (client: Client, uri: string) => {
    const res = await client.readResource({ uri });
    const content = res.contents[0] as { mimeType: string; text: string };
    expect(content.mimeType).toBe("application/json");
    return JSON.parse(content.text) as Record<string, unknown>;
  };

  it("serves JSON read models with the read scope, outside resources/list", async () => {
    const { client } = await connect("campus-agent", ["read"]);
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(["hippo://handbook"]);
    expect(await read(client, "hippo://dashboard/whoami")).toEqual({ agent: "campus-agent", scopes: ["read"], campaign: "lisbon-arc", human: "player" });
    expect(await read(client, "hippo://dashboard/overview")).toMatchObject({ campaign: "lisbon-arc", counts: { quests: { active: 1 } } });
    expect(((await read(client, "hippo://dashboard/catalog")).entities as { slug: string }[]).map((e) => e.slug)).toContain("migration-agency");
    expect(await read(client, "hippo://dashboard/graph")).toMatchObject({ nodes: expect.any(Array), edges: [{ from: "residency-agent", rel: "leads", to: "residence-permit" }] });
    expect(await read(client, "hippo://dashboard/entity/residence-permit")).toMatchObject({ card: { slug: "residence-permit" }, quest: { owner: { slug: "residency-agent" } } });
    expect(await read(client, "hippo://dashboard/chronicle/latest")).toMatchObject({ days: [] });
    expect(await read(client, "hippo://dashboard/chronicle/2026-08")).toMatchObject({ month: "2026-08", days: [] });
  });

  it("decodes template parameters", async () => {
    const { client } = await connect("campus-agent");
    const hits = await read(client, `hippo://dashboard/search?q=${encodeURIComponent("Lisbon Migration")}`);
    expect((hits.entities as { slug: string }[])[0]?.slug).toBe("migration-agency");
    expect((await read(client, "hippo://dashboard/search?q=Lisbon+Migration")).entities).toEqual(hits.entities);
    expect((await read(client, "hippo://dashboard/search?q=residency&limit=1")).entities).toHaveLength(1);
    await expect(client.readResource({ uri: "hippo://dashboard/search?q=residency&limit=99" })).rejects.toThrow(/limit must be/);
    const byAlias = await read(client, `hippo://dashboard/entity/${encodeURIComponent("[[Lisbon Migration]]")}`);
    expect(byAlias).toMatchObject({ card: { slug: "migration-agency", title: "Agência de Migração" } });
  });

  it("reports everything for an unbound local connection, and errors for unknown views and entities", async () => {
    const { client } = await connect();
    expect(await read(client, "hippo://dashboard/whoami")).toEqual({ agent: null, scopes: ["read", "remember", "quest"], campaign: "lisbon-arc", human: "player" });
    await expect(client.readResource({ uri: "hippo://dashboard/secrets" })).rejects.toThrow(/no dashboard view "secrets"/);
    await expect(client.readResource({ uri: "hippo://dashboard/entity/nobody-here" })).rejects.toMatchObject({ code: -32602, data: { code: "VAULT" } });
  });
});
