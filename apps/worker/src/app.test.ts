import { HippoService } from "@hippocampus/core";
import { HippoIndex } from "@hippocampus/index";
import { nodeSqlite } from "@hippocampus/index/node";
import { GitHubStore, MemoryBlobCache, SnapshotCache } from "@hippocampus/store-github";
import { FakeGitHub } from "@hippocampus/store-github/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../../packages/core/src/__fixtures__/vault.ts";
import { createApp } from "./app.ts";
import { hashToken, newToken, type Grant } from "./auth.ts";
import { ScribeQueue, ScribeStore } from "./scribe.ts";

const now = () => new Date("2026-09-27T21:00:00.000Z");

async function setup() {
  const gh = await FakeGitHub.create(Object.fromEntries(fixtureStore().files));
  const blobs = new MemoryBlobCache();
  const snapshots = new SnapshotCache();
  const github = () => new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch, cache: blobs, snapshots });
  const scribe = new ScribeQueue(github());
  const index = await HippoIndex.open(nodeSqlite(":memory:"));
  const grants = new Map<string, Grant>();
  const app = createApp({
    tokens: { get: async (hash) => grants.get(hash) ?? null },
    service: () => new HippoService(new ScribeStore(github(), scribe), { now, searcher: index.searcher }),
  });
  const mint = async (agent: string, scopes: Grant["scopes"]) => {
    const token = newToken();
    grants.set(await hashToken(token), { agent, scopes });
    return token;
  };
  const connect = async (token: string) => {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL("https://hippo.test/mcp"), {
      fetch: (url, init) => app(new Request(url, init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0]!.text, isError: r.isError };
    };
    return { client, call };
  };
  return { gh, app, mint, connect };
}

describe("Worker app", () => {
  it("rejects requests without a known token", async () => {
    const { app, mint } = await setup();
    const post = (headers: Record<string, string>) => app(new Request("https://hippo.test/mcp", { method: "POST", headers, body: "{}" }));
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer hippo_not-a-real-token" })).status).toBe(401);
    expect((await post({ authorization: "Bearer something-else" })).headers.get("www-authenticate")).toContain("Bearer");
    const token = await mint("campus-agent", ["read"]);
    expect((await app(new Request("https://hippo.test/mcp", { headers: { authorization: `Bearer ${token}` } }))).status).toBe(405);
    expect((await app(new Request("https://hippo.test/elsewhere"))).status).toBe(404);
  });

  it("serves MCP as the token's agent and commits through the Scribe", async () => {
    const { gh, mint, connect } = await setup();
    const { call } = await connect(await mint("campus-agent", ["read", "remember"]));
    expect((await call("onboard")).text).toContain("You are Campus Agent");
    const r = await call("remember", { text: "Harbor University library card ready for pickup", agent: "someone-else" });
    expect(r.isError).toBeFalsy();
    expect(gh.log()[0]!.message).toMatch(/^remember\(campus-agent\): ep-/);
    expect((await call("recall", { query: "library card" })).text).toContain("ready for pickup");
  });

  it("hides tools outside the token's scopes", async () => {
    const { gh, mint, connect } = await setup();
    const { client, call } = await connect(await mint("campus-agent", ["read"]));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("remember");
    expect(tools).not.toContain("update_quest");
    expect((await call("remember", { text: "x" })).isError).toBe(true);
    expect(gh.log()).toHaveLength(1);
  });

  it("serializes concurrent writers into separate commits", async () => {
    const { gh, mint, connect } = await setup();
    const a = await connect(await mint("campus-agent", ["remember"]));
    const b = await connect(await mint("home-finder", ["remember"]));
    await Promise.all([a.call("remember", { text: "Enrolment opens 2026-10-01" }), b.call("remember", { text: "Viewing on Friday" })]);
    expect(gh.log().map((c) => c.message.split(":")[0])).toEqual(expect.arrayContaining(["remember(campus-agent)", "remember(home-finder)"]));
    expect(Object.keys(gh.files()).filter((p) => p.startsWith("inbox/"))).toHaveLength(2);
  });

  it("never overwrites a human edit that landed after the agent read the quest", async () => {
    const { gh, mint, connect } = await setup();
    const { call } = await connect(await mint("residency-agent", ["read", "quest"]));
    gh.beforeRefUpdate = async () => {
      gh.beforeRefUpdate = undefined;
      const quest = gh.files()["quests/residence-permit.md"]!;
      await gh.push({ "quests/residence-permit.md": quest.replace("deadline: 2026-11-30", "deadline: 2026-12-15") });
    };
    const r = await call("update_quest", { quest: "residence-permit", complete: ["Get health insurance"] });
    expect(r.isError).toBeFalsy();
    const quest = gh.files()["quests/residence-permit.md"]!;
    expect(quest).toContain("deadline: 2026-12-15");
    expect(quest).toContain("- [x] Get health insurance");
    // The first attempt collided with the human's edit and was redone on top of it.
    expect(gh.log().map((c) => c.message.split(":")[0])).toEqual(["quest(residence-permit)", "human edit", "init"]);
  });
});
