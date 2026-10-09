import { HippoService, Vault } from "@hippocampus/core";
import { MemoryRunStore, SLEEP_PROCEDURE, SleepRelay, type Question } from "@hippocampus/curator";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { createHippoServer, type Scope } from "./server.ts";

const now = () => new Date("2026-09-27T21:00:00.000Z");

async function connect(o: { agent?: string; scopes?: Scope[] } = {}) {
  const store = fixtureStore({
    "inbox/home-finder/2026-09-27T120000-landlord.md": "---\nagent: home-finder\nkind: fact\nat: 2026-09-27T12:00:00Z\n---\nNew landlord is João Silva.\n",
  });
  const relay = new SleepRelay({ open: async (at) => ({ vault: await Vault.load(store, { now: () => at }), store }), runs: new MemoryRunStore(), clock: now });
  const server = createHippoServer({ service: new HippoService(store), agent: o.agent, scopes: o.scopes, relay });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content[0]!.text;
    return { text, isError: r.isError, json: () => JSON.parse(text) };
  };
  return { client, call, store };
}

/** What a careful agent would say about the landlord episode. */
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

describe("sleep over MCP", () => {
  it("offers the sleep tools and prompt only with the curate scope", async () => {
    const { client } = await connect({ agent: "archivist" });
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["sleep_start", "sleep_answer", "sleep_skip", "sleep_status", "sleep_abort"]));
    expect((await client.listTools()).tools.find((t) => t.name === "sleep_start")!.description).toContain("secret values too");
    expect(client.getInstructions()).toContain("sleep_start");
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["sleep"]);
    const prompt = await client.getPrompt({ name: "sleep" });
    expect((prompt.messages[0]!.content as { text: string }).text).toBe(`${SLEEP_PROCEDURE}\n\nStart by calling sleep_start with your model name.`);

    const agentOnly = await connect({ agent: "home-finder", scopes: ["read", "remember"] });
    expect((await agentOnly.client.listTools()).tools.map((t) => t.name).filter((t) => t.startsWith("sleep_"))).toEqual([]);
    expect((await agentOnly.client.listPrompts()).prompts).toEqual([]);
    expect(agentOnly.client.getInstructions()).not.toContain("sleep");
  });

  it("runs a night's sleep, one batch of questions per call", async () => {
    const { call, store } = await connect({ agent: "archivist" });
    let step = (await call("sleep_start", { model: "test-model", curator: "someone-else" })).json();
    expect(step).toMatchObject({ state: "ask", progress: { done: 0, total: 1 }, procedure: SLEEP_PROCEDURE });
    expect(step.questions[0]).toMatchObject({ name: "mentions", schema: { type: "object" } });
    expect(step.questions[0].prompt).toContain("New landlord is João Silva.");

    // One run at a time; the second caller learns whose it is.
    const busy = await call("sleep_start", { model: "other" });
    expect(busy.isError).toBe(true);
    expect(busy.json()).toMatchObject({ status: { run: { id: step.run, curator: "archivist", model: "test-model", live: true } } });

    // A wrong answer is data, not an error: fix it and resend.
    const wrong = await call("sleep_answer", { run: step.run, answers: [{ question_id: step.questions[0].id, value: '{"entities": 3}' }] });
    expect(wrong.isError).toBeFalsy();
    expect(wrong.json().rejected).toEqual([{ questionId: step.questions[0].id, issues: expect.stringContaining("entities") }]);

    while (step.state === "ask") {
      const answers = step.questions.map((q: Question) => ({ question_id: q.id, value: JSON.stringify(answer(q)) }));
      const r = await call("sleep_answer", { run: step.run, answers });
      expect(r.isError).toBeFalsy();
      step = r.json();
      expect(step.rejected).toBeUndefined();
    }
    expect(step.report).toMatchObject({ curator: "archivist", model: "test-model", consolidated: [{ agent: "home-finder", created: ["joao-silva"] }], remaining: 0 });
    expect(await store.list("inbox")).toEqual([]);
    expect(await store.read("characters/joao-silva.md")).toContain("The player's landlord in Lisbon.");
    expect((await call("sleep_status")).json()).toEqual({ history: [expect.objectContaining({ id: step.run, outcome: "done", consolidated: 1 })] });
  });

  it("skips, aborts, and refuses a run that isn't open", async () => {
    const { call, store } = await connect();
    const step = (await call("sleep_start", { model: "test-model" })).json();
    expect((await call("sleep_status")).json().run).toMatchObject({ id: step.run, curator: "curator-agent", live: true });
    expect((await call("sleep_skip", { run: "run-elsewhere", reason: "x" })).text).toMatch(/^Error: run "run-elsewhere" isn't the open sleep run/);

    const done = (await call("sleep_skip", { run: step.run, reason: "not sure who this is" })).json();
    expect(done).toMatchObject({ state: "done", report: { skipped: [{ reason: "not sure who this is" }], remaining: 1 } });
    expect(await store.list("inbox")).toHaveLength(1);

    const again = (await call("sleep_start", { model: "test-model" })).json();
    expect((await call("sleep_abort", { run: again.run })).json()).toMatchObject({ history: [{ id: again.run, outcome: "aborted" }, { id: step.run, outcome: "done" }] });
    expect((await call("sleep_answer", { run: again.run, answers: [] })).isError).toBe(true);
  });
});
