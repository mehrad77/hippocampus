import { HippoService } from "@hippocampus/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { createHippoServer } from "./server.ts";

async function connect(agent?: string) {
  const store = fixtureStore();
  const server = createHippoServer({ service: new HippoService(store), agent });
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
});
