import { HippoService } from "@hippocampus/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { createHippoServer, normalizeScopes, type Scope } from "./server.ts";

// A residency contact with a confidential phone: residency-agent has authority there, campus-agent doesn't.
const OFFICER = `---\ntype: character\ntitle: Case Officer\ntags: [residency]\nfacts:\n  phone: { value: "+351 900 000 000", confidential: true }\n  office: Alfama\n---\n`;

async function connect(agent?: string, scopes?: Scope[]) {
  const store = fixtureStore({ "characters/case-officer.md": OFFICER });
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
    expect(tools).toEqual(["ask_canon", "briefing", "get", "introduce", "neighbors", "onboard", "recall", "remember", "update_goal", "update_quest"]);
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(["hippo://handbook"]);
    const res = await client.readResource({ uri: "hippo://handbook" });
    expect((res.contents[0] as { text: string }).text).toContain("# 📜 Handbook — ");
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

  it("never files an agent's call as the human", async () => {
    const { call, store } = await connect();
    for (const agent of ["human", "Player", "curator", "Residency Agent"]) {
      const r = await call("remember", { text: "The agency moved to Alfama.", agent });
      expect(r.isError, agent).toBe(true);
      expect(r.text).toMatch(/^Error: /);
    }
    expect((await call("update_quest", { quest: "residence-permit", complete: ["health insurance"], agent: "player" })).isError).toBe(true);
    expect(await store.list("inbox")).toEqual([]);
    expect(await store.read("goals/residence-permit.md")).not.toContain("- [x]");

    const bound = await connect("player");
    expect((await bound.call("remember", { text: "The agency moved to Alfama." })).text).toContain('"player" is the human');
    expect(await bound.store.list("inbox")).toEqual([]);
  });

  it("introduces an outsider, once, and tells a member it's already in", async () => {
    const { call, store } = await connect("job-scout");
    expect((await call("onboard")).text).toContain('introduce({ agent: "job-scout"');
    const r = await call("introduce", { title: "Job Scout", lane: "Part-time work in Lisbon", about: "I watch job boards." });
    expect(r).toEqual({ text: "Introduced as job-scout: waiting for player's approval. Until then your memories count as rumors." });
    await call("introduce", { title: "Job Scout", lane: "Part-time work" });
    expect(await store.list("inbox/job-scout")).toEqual([expect.stringMatching(/^inbox\/job-scout\/_introduction-\w+\.md$/)]);
    expect((await call("onboard")).text).toContain("waiting for player's approval");

    const unbound = await connect();
    expect((await unbound.call("introduce", { title: "Me" })).isError).toBe(true);
    expect((await unbound.call("introduce", { title: "Me", agent: "player" })).text).toContain('"player" is the human');
    expect((await unbound.call("introduce", { title: "Residency", agent: "residency-agent" })).text).toBe("You're already in the party as Residency Agent (party/residency-agent.md). Nothing to do.");
    expect(await unbound.store.list("inbox")).toEqual([]);
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
    expect(tools).not.toContain("update_goal");
    expect(tools).toContain("recall");
    expect((await readOnly.call("remember", { text: "x" })).isError).toBe(true);
    expect(await readOnly.store.list("inbox")).toEqual([]);

    const writeOnly = await connect("campus-agent", ["remember"]);
    expect((await writeOnly.client.listTools()).tools.map((t) => t.name)).toEqual(["remember", "introduce"]);
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

  it("updates goals with update_goal, and update_quest still maps a clock and deadline", async () => {
    const { call, store } = await connect("residency-agent");
    const r = await call("update_goal", { goal: "residence-permit", complete: ["health insurance"], progress: { total: 4, tick: 1 }, due: "2026-12-15", counterparty: "LMA" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("goal: \"[[residence-permit]]\"");
    expect(r.text).toContain("progress 1/4");
    expect(r.text).toContain("counterparty [[migration-agency]]");
    expect(await store.read("goals/residence-permit.md")).toContain("due: 2026-12-15");
    expect((await call("update_goal", { goal: "residence-permit", status: "maybe" })).text).toMatch(/^Error: unknown status "maybe"/);

    const old = await call("update_quest", { quest: "residence-permit", clock: { name: "Paperwork", segments: 4, tick: 1 }, deadline: "2026-12-20" });
    expect(old.isError).toBeFalsy();
    expect(old.text).toContain("quest: \"[[residence-permit]]\"");
    expect(old.text).toContain("progress 2/4");
    expect(await store.read("goals/residence-permit.md")).toContain("due: 2026-12-20");
  });

  it("lets a key with the old quest scope update goals", async () => {
    expect(normalizeScopes(["read", "quest", "goal", "remember"])).toEqual(["read", "remember", "goal"]);
    const { client, call } = await connect("residency-agent", ["read", "quest"]);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["update_goal", "update_quest"]));
    expect(tools).not.toContain("remember");
    expect((await call("update_goal", { goal: "residence-permit", add: ["Pay card fee"] })).text).toContain("+ Pay card fee");
  });

  it("shows confidential values only to a bound caller with authority over them", async () => {
    const masked = "◐ confidential";
    const unbound = await connect();
    const asArg = await unbound.call("get", { entity: "case-officer", agent: "residency-agent" });
    expect(asArg.text).toContain(masked);
    expect(asArg.text).not.toContain("900");
    expect(asArg.text).toContain("Alfama");
    expect((await unbound.call("recall", { query: "case officer" })).text).not.toContain("900");

    const outsider = await connect("campus-agent");
    expect((await outsider.call("get", { entity: "case-officer" })).text).toContain(masked);
    expect((await outsider.call("briefing", { about: "Case Officer" })).text).not.toContain("900");

    const lane = await connect("residency-agent");
    const got = await lane.call("get", { entity: "case-officer" });
    expect(got.text).toContain("+351 900 000 000");
    expect(got.text).toContain("confidential: true");
    expect((await lane.call("recall", { query: "case officer" })).text).toContain("+351 900 000 000");
    expect((await lane.call("briefing", { about: "Case Officer" })).text).toContain("+351 900 000 000");
  });

  it("checks remember against the vault's kinds", async () => {
    const { call } = await connect("residency-agent");
    expect((await call("remember", { kind: "interaction", data: { with: "[[case-officer]]", channel: "call" } })).isError).toBeFalsy();
    expect((await call("remember", { kind: "observation" })).text).toBe("Error: text is required");
    expect((await call("remember", { kind: "interaction" })).text).toBe("Error: a interaction needs text or data");
    const unknown = await call("remember", { text: "Met the officer.", kind: "chat" });
    expect(unknown.isError).toBeFalsy();
    expect(unknown.text).toContain('unknown kind \"chat\"; filed as an observation');
  });

  it("briefs on one person with about", async () => {
    const { call } = await connect("residency-agent");
    const r = await call("briefing", { about: "residency-agent" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("goals:\n  - ref: \"[[residence-permit]]\"");
    expect(r.text).toContain("role: owner");
    expect((await call("briefing", { about: "nobody at all" })).isError).toBe(true);
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
    expect(await read(client, "hippo://dashboard/whoami")).toEqual({ agent: "campus-agent", scopes: ["read"], name: "lisbon-arc", campaign: "lisbon-arc", human: "player", humans: [{ id: "player", domains: [] }] });
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
    expect(await read(client, "hippo://dashboard/whoami")).toEqual({
      agent: null,
      scopes: ["read", "remember", "goal", "quest", "curate"],
      name: "lisbon-arc",
      campaign: "lisbon-arc",
      human: "player",
      humans: [{ id: "player", domains: [] }],
    });
    await expect(client.readResource({ uri: "hippo://dashboard/secrets" })).rejects.toThrow(/no dashboard view "secrets"/);
    await expect(client.readResource({ uri: "hippo://dashboard/entity/nobody-here" })).rejects.toMatchObject({ code: -32602, data: { code: "VAULT" } });
  });
});

describe("MCP input limits and whoami (review fixes)", () => {
  it("refuses an objective longer than one checklist line", async () => {
    const { call, store } = await connect("residency-agent");
    expect((await call("update_goal", { goal: "residence-permit", add: ["x".repeat(301)] })).isError).toBe(true);
    expect(await store.read("goals/residence-permit.md")).not.toContain("x".repeat(301));
    expect((await call("update_goal", { goal: "residence-permit", add: ["x".repeat(300)] })).isError).toBeFalsy();
  });

  it("whoami lists the humans without their GitHub logins", async () => {
    const store = fixtureStore({ "_hippo/config.yaml": (await fixtureStore().read("_hippo/config.yaml"))!.replace("humans: [{ id: player }]", "humans: [{ id: player, github: player-login }]") });
    const server = createHippoServer({ service: new HippoService(store), agent: "residency-agent" });
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.readResource({ uri: "hippo://dashboard/whoami" });
    const text = (res.contents[0] as { text: string }).text;
    expect(text).toContain('"player"');
    expect(text).not.toContain("player-login");
  });
});
