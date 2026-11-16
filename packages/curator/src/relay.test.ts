import { MemoryStore, StoreConflictError, Vault, decryptSecret, humanText, parseDoc, ulid, type Change, type CommitMeta } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { episode, now, script, setup } from "./__fixtures__/night.ts";
import { ScriptedLLM, type LLM } from "./llm.ts";
import { BudgetExhausted, CappedMeter, ProviderStop } from "./meter.ts";
import type { Price } from "./pricing.ts";
import { MemoryRunStore, RunBusyError, SleepRelay, standbyVerdict, type Question, type RelayStep, type SleepGate } from "./relay.ts";
import { CURATOR_AUTHOR, arrivedAt, sleep, waitingWork } from "./sleep.ts";

type Ask = Extract<RelayStep, { state: "ask" }>;

/** The store applies each batch as one commit, recorded. */
function committing(store: MemoryStore, before?: (n: number) => void) {
  const commits: CommitMeta[] = [];
  const atomic = Object.assign(Object.create(store) as MemoryStore, {
    async apply(changes: Change[], meta: CommitMeta) {
      before?.(commits.length);
      commits.push(meta);
      for (const c of changes) "remove" in c ? store.files.delete(c.path) : store.files.set(c.path, c.content);
    },
  });
  return { store: atomic, commits };
}

function relayOver(store: MemoryStore, o: { clock?: () => Date } = {}) {
  const runs = new MemoryRunStore();
  const relay = new SleepRelay({ open: async (at) => ({ vault: await Vault.load(store, { now: () => at }), store }), runs, clock: o.clock ?? now });
  return { relay, runs };
}

/** What an agent sends back: each question put to `agent`, in the order asked. */
async function answers(agent: ScriptedLLM, questions: Question[]) {
  const out: { questionId: string; value: unknown }[] = [];
  for (const q of questions) out.push({ questionId: q.id, value: await agent.object({ name: q.name, schema: z.unknown(), system: q.system, prompt: q.prompt }) });
  return out;
}

/** Answers everything until the run is done, collecting the questions asked and the answers turned down. */
async function runToEnd(relay: SleepRelay, first: RelayStep, agent: ScriptedLLM) {
  const seen: Question[] = [];
  const rejected: string[] = [];
  let step = first;
  while (step.state === "ask") {
    seen.push(...step.questions);
    step = await relay.answer({ runId: step.run, answers: await answers(agent, step.questions) });
    if (step.state === "ask") rejected.push(...(step.rejected ?? []).map((r) => r.questionId));
  }
  if (step.state !== "done") throw new Error(`expected a run, got ${step.state}`);
  return { report: step.report, seen, rejected };
}

const NOTE = /^(characters|factions|locations|items|lore|goals|arcs|party)\//;
const REGION = /%% hippo:begin ([\w-]+) %%\n([\s\S]*?)\n%% hippo:end \1 %%/g;

/**
 * A vault's files, compared for meaning. Committing per unit changes two things about layout, not
 * content: a note's managed regions sit in the order they were first written (the classic run
 * summarizes a new note before its facts were ever rendered), and the review lists orphans in the
 * order notes were loaded. So notes compare by frontmatter, regions and prose, the review by its lines,
 * and secrets by plaintext (age ciphertext is randomized).
 */
async function tree({ store, identity }: { store: MemoryStore; identity: string }) {
  const canon = async (path: string, raw: string): Promise<unknown> => {
    if (path.endsWith(".age")) return decryptSecret(identity, raw);
    if (path === "_hippo/review.md") return raw.split("\n").sort();
    if (!NOTE.test(path)) return raw;
    const { data, body } = parseDoc(raw);
    return { data, regions: Object.fromEntries([...body.matchAll(REGION)].map((m) => [m[1], m[2]])), prose: humanText(body) };
  };
  return Object.fromEntries(await Promise.all([...store.files].map(async ([path, raw]) => [path, await canon(path, raw)] as const)));
}

const asking = (step: RelayStep): Ask => {
  if (step.state !== "ask") throw new Error(`expected questions, got ${JSON.stringify(step)}`);
  return step;
};

describe("sleep relay", () => {
  it("curates exactly like the classic sleep, asking the agent the same questions", async () => {
    const classic = await setup();
    const relayed = { store: new MemoryStore(Object.fromEntries(classic.store.files)), identity: classic.identity };
    const model = script();
    const expected = await sleep({ store: classic.store, llm: model, now });

    const { store, commits } = committing(relayed.store);
    const { relay, runs } = relayOver(store);
    const agent = script();
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    expect(first.procedure).toContain("sleep_answer");
    const { report, seen, rejected } = await runToEnd(relay, first, agent);
    expect(rejected).toEqual([]);

    const call = (c: { name: string; system: string; prompt: string }) => `${c.name}\n${c.system}\n${c.prompt}`;
    expect(agent.calls.map(call).sort()).toEqual(model.calls.map(call).sort());
    // Look-ahead answers were used: each episode's mentions question came up once.
    expect(seen.filter((q) => q.name === "mentions")).toHaveLength(3);

    // The same vault, written in four commits instead of one.
    expect(await tree(relayed)).toEqual(await tree(classic));
    expect(report).toMatchObject({ consolidated: expected.consolidated, failed: [], summaries: expected.summaries, remaining: 0, curator: "archivist", skipped: [] });
    expect(JSON.stringify(report)).not.toContain("U12345678");

    expect(commits).toHaveLength(4);
    for (const c of commits) {
      expect(c.author).toEqual(CURATOR_AUTHOR);
      expect(c.message.split("\n")[0]).toMatch(/^chore\(sleep\): .+ \[skip ci\]$/);
      expect(c.message).toMatch(new RegExp(`\n\nHippo-Actor: curator\nHippo-Curator: archivist\nHippo-Model: scripted\nHippo-Run: ${first.run}$`));
    }
    expect(commits[0]!.message).toMatch(/^chore\(sleep\): ep-\w+ \(residency-agent\) touched migration-agency, passport/);
    expect(commits[3]!.message).toMatch(`chore(sleep): finish run ${first.run} [skip ci]`);
    expect(report.commits).toEqual(commits.map((c) => c.message.split("\n")[0]!.replace(" [skip ci]", "")));

    // Nothing an agent said outlives its unit, and the run is closed.
    for (const unit of new Set(seen.map((q) => q.unit))) expect(await runs.answers(unit)).toEqual([]);
    expect(await relay.status()).toEqual({ history: [expect.objectContaining({ id: first.run, outcome: "done", consolidated: 3, commits: 4 })] });
  });

  it("tells the person what to do next, and why the secret wasn't stored, when the vault has no secrets recipient", async () => {
    const { store } = await setup();
    const config = (await store.read("_hippo/config.yaml"))!;
    await store.write("_hippo/config.yaml", config.replace(/secrets:\n {2}recipient: age1\S+\n$/, ""));
    const { relay } = relayOver(store);
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    const { report } = await runToEnd(relay, first, script());
    expect(report.next).toContainEqual(expect.objectContaining({ code: "secrets-no-recipient", count: 1, fix: expect.stringContaining("Setup") }));
    expect(report.consolidated.flatMap((c) => c.facts).find((f) => f.secret)?.reason).toBe("no secrets recipient configured");
    // The core's hint (with the fix) reaches the report, though each episode ran on its own vault.
    expect(report.warnings).toContainEqual(expect.stringContaining("set secrets.recipient"));
    expect(JSON.stringify(report)).not.toContain("U12345678");
    expect(await store.read("_hippo/review.md")).toContain("What to do next");
  });

  it("has nothing to tell the person when the night went through", async () => {
    const { store } = await setup();
    const { relay } = relayOver(store);
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    const { report } = await runToEnd(relay, first, script());
    expect(report.next.map((n) => n.code)).not.toContain("secrets-no-recipient");
    // What is left is the curator wanting a domain the example vault lacks.
    expect(report.next.map((n) => n.code)).toEqual(["suggested-domains"]);
  });

  it("asks again only what the vault changed", async () => {
    const { store } = await setup();
    const { relay } = relayOver(store);
    const agent = script();
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    expect(first.questions.map((q) => q.name)).toEqual(["mentions", "mentions", "mentions"]);
    const second = asking(await relay.answer({ runId: first.run, answers: await answers(agent, first.questions) }));
    expect(second.questions.map((q) => q.name)).toEqual(["claims"]);
    expect(second.progress).toEqual({ done: 0, total: 3, unit: first.questions[0]!.unit });

    // The human adds a goal meanwhile. Every prompt lists the goals, so the recorded answers no longer fit.
    await store.write("goals/health-insurance.md", "---\ntype: goal\ntitle: Health insurance\nstatus: active\n---\n");
    const claims = await answers(agent, second.questions);
    const third = asking(await relay.answer({ runId: first.run, answers: claims }));
    expect(third.questions.map((q) => [q.unit, q.name])).toEqual(first.questions.map((q) => [q.unit, "mentions"]));
    expect(third.questions.map((q) => q.id)).not.toContain(first.questions[0]!.id);
    expect(third.questions[0]!.prompt).toContain("Health insurance");
    expect(third.rejected).toEqual([{ questionId: second.questions[0]!.id, issues: expect.stringContaining("not an open question") }]);

    // Answered again, the run goes on as if nothing happened.
    const { report, rejected } = await runToEnd(relay, third, script());
    expect(rejected).toEqual([]);
    expect(report).toMatchObject({ failed: [], remaining: 0 });
    expect(report.consolidated).toHaveLength(3);
  });

  it("replays a unit after a conflicting commit, without asking again", async () => {
    const relayed = await setup();
    const { store, commits } = committing(relayed.store, (n) => {
      if (n > 0 || relayed.store.files.has("inbox/job-scout/2026-09-27T130000-fair.md")) return;
      // Another agent's episode lands first.
      relayed.store.files.set("inbox/job-scout/2026-09-27T130000-fair.md", episode("job-scout", "2026-09-27T13:00:00Z", "Career fair at Harbor University on 2026-10-20."));
      throw new StoreConflictError(["inbox/job-scout/2026-09-27T130000-fair.md"]);
    });
    const { relay } = relayOver(store);
    const agent = script();
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    const second = asking(await relay.answer({ runId: first.run, answers: await answers(agent, first.questions) }));
    const third = asking(await relay.answer({ runId: first.run, answers: await answers(agent, second.questions) }));

    // ep 1 committed on the second try and the run moved on to the next episode.
    expect(commits).toHaveLength(1);
    expect(third.progress.done).toBe(1);
    expect(third.questions[0]).toMatchObject({ unit: first.questions[1]!.unit, name: "match" });
    expect(relayed.store.files.get("factions/migration-agency.md")).toContain("2026-10-14T10:30");
    // Not in the pinned batch: it waits for the next run.
    const { report } = await runToEnd(relay, third, agent);
    expect(report.remaining).toBe(1);
    expect(relayed.store.files.has("inbox/job-scout/2026-09-27T130000-fair.md")).toBe(true);
  });

  it("rejects an answer that doesn't fit the schema, and keeps nothing of it", async () => {
    const { store } = await setup();
    const { relay, runs } = relayOver(store);
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    const [q] = first.questions;
    const bad = asking(await relay.answer({ runId: first.run, answers: [{ questionId: q!.id, value: { entities: "none" } }] }));
    expect(bad.rejected).toEqual([{ questionId: q!.id, issues: expect.stringContaining("entities") }]);
    expect(bad.questions[0]!.id).toBe(q!.id);
    expect(await runs.answers(q!.unit)).toEqual([]);

    // A JSON string is fine.
    const good = asking(await relay.answer({ runId: first.run, answers: [{ questionId: q!.id, value: JSON.stringify({ entities: [] }) }] }));
    expect(good.rejected).toBeUndefined();
    expect(good.progress.done).toBe(1);
  });

  it("refuses an answer that carries another episode's secret", async () => {
    const { store } = await setup();
    const { relay } = relayOver(store);
    const agent = script();
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    const second = asking(await relay.answer({ runId: first.run, answers: await answers(agent, first.questions.slice(0, 1)) }));
    const third = asking(await relay.answer({ runId: first.run, answers: await answers(agent, second.questions.slice(0, 1)) }));
    // ep 1 committed, with the passport number as a secret. ep 2 never mentioned it.
    const [mentions] = third.questions;
    expect(mentions!.unit).toBe(first.questions[1]!.unit);
    const leak = { entities: [{ name: "Lisbon Migration Office", type: "faction", aliases: ["U12345678"], domains: [] }] };
    const refused = asking(await relay.answer({ runId: first.run, answers: [{ questionId: mentions!.id, value: leak }] }));
    expect(refused.rejected).toEqual([{ questionId: mentions!.id, issues: expect.stringContaining("secret value from another episode") }]);
    expect(refused.questions[0]!.id).toBe(mentions!.id);

    // Not in a summary either.
    agent.respond("summary", () => ({ summary: "The player's passport, U12345678." }));
    let step: RelayStep = refused;
    while (step.state === "ask" && step.questions[0]!.name !== "summary") step = await relay.answer({ runId: first.run, answers: await answers(agent, step.questions) });
    const summary = asking(step).questions[0]!;
    const again = asking(await relay.answer({ runId: first.run, answers: await answers(agent, [summary]) }));
    expect(again.rejected).toEqual([{ questionId: summary.id, issues: expect.stringContaining("secret value from another episode") }]);
  });

  it("skips an episode, which stays in the inbox, and goes on", async () => {
    const { store } = await setup();
    const { relay } = relayOver(store);
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    const next = asking(await relay.skip({ runId: first.run, reason: "unclear which appointment" }));
    expect(next.questions[0]!.unit).toBe(first.questions[1]!.unit);

    // Only ep 2 and ep 3 are asked about.
    const agent = new ScriptedLLM()
      .push("mentions", { entities: [{ name: "Lisbon Migration Office", type: "faction", aliases: [], domains: [] }] }, { entities: [{ name: "João Silva", type: "character", aliases: [], domains: ["housing"] }] })
      .push("match", { match: "migration-agency" })
      .push("claims", { facts: [], relations: [], quests: [] }, { facts: [{ entity: "joao-silva", field: "phone", value: "+351 900 000 001", secret: false }], relations: [], quests: [] })
      .respond("summary", () => ({ summary: "Part of the move to Lisbon." }));
    const { report, rejected } = await runToEnd(relay, next, agent);
    expect(rejected).toEqual([]);
    expect(report.skipped).toEqual([{ id: first.questions[0]!.unit.slice(3), reason: "unclear which appointment" }]);
    expect(report.consolidated).toHaveLength(2);
    expect(await store.list("inbox")).toEqual(["inbox/residency-agent/2026-09-27T100000-agency.md"]);
    // The review counts what's left in the inbox.
    expect(await store.read("_hippo/review.md")).toContain("2 episodes consolidated, 0 failed, 1 still in the inbox");
  });

  it("skips a summary during the finish, keeping the others", async () => {
    const { store } = await setup();
    const { relay } = relayOver(store);
    const agent = script();
    let step: RelayStep = await relay.start({ curator: "archivist", model: "scripted" });
    while (step.state === "ask" && step.questions[0]!.name !== "summary") step = await relay.answer({ runId: step.run, answers: await answers(agent, step.questions) });
    const skipped = asking(step).questions[0]!.prompt.split(" ")[1]!;
    const next = asking(await relay.skip({ runId: asking(step).run, reason: "nothing worth saying" }));
    expect(next.questions[0]!.prompt).not.toContain(`Entity: ${skipped} `);
    const { report } = await runToEnd(relay, next, agent);
    expect(report.summaries).toHaveLength(3);
    expect(report.summaries).not.toContain(skipped);
    expect(report.warnings).toContain(`summary for ${skipped} skipped: nothing worth saying`);
  });

  it("passes over an episode that left the inbox since the run started", async () => {
    const { store } = await setup();
    const { relay } = relayOver(store);
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    await store.remove("inbox/home-finder/2026-09-27T120000-landlord.md");
    const { report, rejected } = await runToEnd(relay, first, script());
    // The agent had already answered its look-ahead question; that answer has nowhere to go.
    expect(rejected).toEqual([first.questions[2]!.id]);
    expect(report.consolidated.map((c) => c.agent)).toEqual(["residency-agent", "campus-agent"]);
    expect(report).toMatchObject({ failed: [], skipped: [] });
  });

  it("holds one run at a time, and finishes a lapsed one without summaries", async () => {
    let t = now();
    const { store } = await setup();
    const { relay, runs } = relayOver(store, { clock: () => t });
    const agent = script();
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    const busy = await relay.start({ curator: "campus-agent", model: "other" }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(RunBusyError);
    expect((busy as RunBusyError).status.run).toMatchObject({ id: first.run, curator: "archivist", live: true });

    const second = asking(await relay.answer({ runId: first.run, answers: await answers(agent, first.questions) }));
    const third = asking(await relay.answer({ runId: first.run, answers: await answers(agent, second.questions) }));
    // ep 1 is committed and its answers are gone; ep 2's look-ahead answer waits for its unit.
    expect(third.progress.done).toBe(1);
    expect(await runs.answers(first.questions[0]!.unit)).toEqual([]);
    expect(await runs.answers(first.questions[1]!.unit)).toHaveLength(1);

    t = new Date(t.getTime() + 16 * 60_000);
    expect((await relay.status()).run).toMatchObject({ id: first.run, live: false });
    await relay.expire(t);
    expect(await relay.status()).toEqual({ history: [expect.objectContaining({ id: first.run, outcome: "expired", consolidated: 1, summaries: 0, remaining: 2 })] });
    expect(await runs.answers(first.questions[1]!.unit)).toEqual([]);
    expect(await store.list("inbox")).toHaveLength(2);
    expect(await store.read("_hippo/review.md")).toContain("1 episodes consolidated, 0 failed, 2 still in the inbox");
    expect(await store.read("factions/migration-agency.md")).not.toContain("hippo:begin summary");
    await expect(relay.answer({ runId: first.run, answers: [] })).rejects.toThrow(/no sleep run/);

    // The slot is free again.
    expect(asking(await relay.start({ curator: "campus-agent", model: "other" })).progress).toMatchObject({ done: 0, total: 2 });
  });

  it("aborts a run, keeping what it committed", async () => {
    const { store } = await setup();
    const { relay } = relayOver(store);
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    const status = await relay.abort(first.run);
    expect(status).toEqual({ history: [expect.objectContaining({ id: first.run, outcome: "aborted", consolidated: 0, remaining: 3 })] });
    await expect(relay.abort(first.run)).rejects.toThrow(/no sleep run/);
  });

  it("curates an episode of a kind without text from its data alone, asking nothing", async () => {
    const config = (await fixtureStore().read("_hippo/config.yaml"))!.replace(
      "relations:",
      "kinds:\n  call: { behaviour: interaction, text: forbidden, counts_as_contact: true, data: { with: { kind: ref } } }\nrelations:",
    );
    const store = fixtureStore({
      "_hippo/config.yaml": config,
      "inbox/residency-agent/2026-09-27T100000-call.md": '---\nagent: residency-agent\nkind: call\nat: 2026-09-27T10:00:00Z\ndata:\n  with: "[[migration-agency]]"\n---\n',
    });
    const { relay } = relayOver(store);
    const step = await relay.start({ curator: "archivist", model: "scripted" });

    expect(step.state).toBe("done");
    if (step.state !== "done") return;
    expect(step.report).toMatchObject({ failed: [], remaining: 0, summaries: [], consolidated: [{ agent: "residency-agent", touched: ["migration-agency"], stats: ["migration-agency"] }] });
    expect(parseDoc((await store.read("factions/migration-agency.md"))!).data.stats).toMatchObject({ counts: { call: 1 }, last_contact: "2026-09-27" });
    expect(await store.list("inbox")).toEqual([]);
  });

  it("passes over a data-only episode in look-ahead, and still curates like the classic sleep", async () => {
    const classic = await setup();
    // Between the first and second episode; with no text, it's curated from its data.
    classic.store.files.set("inbox/home-finder/2026-09-27T103000-call.md", '---\nagent: home-finder\nkind: interaction\nat: 2026-09-27T10:30:00Z\nabout: [migration-agency]\ndata:\n  channel: call\n---\n');
    const relayed = { store: new MemoryStore(Object.fromEntries(classic.store.files)), identity: classic.identity };
    const expected = await sleep({ store: classic.store, llm: script(), now });
    expect(expected.failed).toEqual([]);

    const { relay } = relayOver(relayed.store);
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    expect(first.questions.map((q) => q.name)).toEqual(["mentions", "mentions", "mentions"]);
    const { report, rejected } = await runToEnd(relay, first, script());
    expect(rejected).toEqual([]);
    expect(report.consolidated).toEqual(expected.consolidated);
    expect(report.consolidated[1]).toMatchObject({ agent: "home-finder", stats: ["migration-agency"] });
    expect(await tree(relayed)).toEqual(await tree(classic));
  });
});

/** `model`, but the `n`th call named `name` (counting from 1) throws `err` instead of answering. */
function failing(model: LLM, name: string, n: number, err: () => Error): LLM & { asked: string[] } {
  let seen = 0;
  const asked: string[] = [];
  return {
    name: model.name,
    asked,
    async object(req) {
      asked.push(req.name);
      if (req.name === name && ++seen === n) throw err();
      return model.object(req);
    },
  };
}

const later = () => new Date(now().getTime() + 60 * 60_000);
const TEST_PRICE: Price = { provider: "anthropic", model: "test", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, checked: "2026-11-16", source: "test" };

describe("a hosted run", () => {
  it("curates like an agent's run, driven by the model, with nothing asked of anyone", async () => {
    const asAgent = await setup();
    const hosted = { store: new MemoryStore(Object.fromEntries(asAgent.store.files)), identity: asAgent.identity };
    const viaAgent = relayOver(committing(asAgent.store).store);
    await runToEnd(viaAgent.relay, asking(await viaAgent.relay.start({ curator: "archivist", model: "scripted" })), script());

    const { store, commits } = committing(hosted.store);
    const { relay } = relayOver(store);
    const opened = asking(await relay.start({ curator: "hosted", model: "scripted", hosted: true }));
    expect(opened.questions).toEqual([]);
    const done = await relay.autopilot({ runId: opened.run, answerer: script(), until: later() });
    expect(done).toMatchObject({ state: "done", report: { failed: [], remaining: 0 } });
    expect(await tree(hosted)).toEqual(await tree(asAgent));
    expect(commits).toHaveLength(4);
    for (const c of commits) expect(c.message).toMatch(/Hippo-Actor: curator\nHippo-Curator: hosted\nHippo-Model: scripted\nHippo-Run: /);
  });

  it("pauses at its deadline or unit count, and goes on from there", async () => {
    const { store } = await setup();
    const { relay } = relayOver(store);
    const run = asking(await relay.start({ curator: "hosted", model: "m", hosted: true })).run;
    const answerer = script();
    expect(await relay.autopilot({ runId: run, answerer, until: later(), units: 2 })).toMatchObject({ state: "paused", progress: { done: 1 } });
    expect(await relay.autopilot({ runId: run, answerer, until: now() })).toMatchObject({ state: "paused" });
    expect(await relay.autopilot({ runId: run, answerer, until: later() })).toMatchObject({ state: "done" });
  });

  it("stops at the budget in episode 2 of 3: episode 1 committed, the rest in the inbox, nothing counted as failed", async () => {
    const { store } = await setup();
    const inbox = () => [...store.files.keys()].filter((p) => p.startsWith("inbox/")).sort();
    // The oldest episode is curated first.
    const first = "inbox/residency-agent/2026-09-27T100000-agency.md";
    const before = inbox().filter((p) => p !== first);
    const { relay, runs } = relayOver(store, { clock: now });
    const run = asking(await relay.start({ curator: "hosted", model: "m", hosted: true })).run;
    const answerer = failing(script(), "mentions", 2, () => new BudgetExhausted());
    const done = await relay.autopilot({ runId: run, answerer, until: later() });
    expect(done).toMatchObject({ state: "done", stop: "budget", report: { failed: [] } });
    expect(inbox()).toEqual(before);
    expect((await runs.history())[0]).toMatchObject({ outcome: "aborted", stop: "budget", consolidated: 1, failed: 0 });
    const review = store.files.get("_hippo/review.md")!;
    expect(review).toContain("budget reached: finished without summaries");
    expect(parseDoc(review).data.failures ?? {}).toEqual({});
    // No summaries were asked once it stopped.
    expect(answerer.asked).not.toContain("summary");
  });

  it("never spends past the cap, whatever the run's size", async () => {
    for (const cap of [5_000, 20_000, 60_000]) {
      const { store } = await setup();
      const { relay } = relayOver(store);
      const meter = new CappedMeter(cap);
      const run = asking(await relay.start({ curator: "hosted", model: "m", hosted: true })).run;
      const done = await relay.autopilot({ runId: run, answerer: script().bill(meter, TEST_PRICE, { input: 1_000, output: 100 }), until: later() });
      expect(done.state).toBe("done");
      expect(meter.spent).toBeLessThanOrEqual(cap);
      expect(meter.held).toBe(0);
    }
  });

  it("stops on a refused key, and leaves the episodes in place", async () => {
    const { store } = await setup();
    const before = [...store.files.keys()].filter((p) => p.startsWith("inbox/")).length;
    const { relay, runs } = relayOver(store);
    const run = asking(await relay.start({ curator: "hosted", model: "m", hosted: true })).run;
    const done = await relay.autopilot({ runId: run, answerer: failing(script(), "mentions", 1, () => new ProviderStop("auth", 401)), until: later() });
    expect(done).toMatchObject({ state: "done", stop: "auth" });
    expect([...store.files.keys()].filter((p) => p.startsWith("inbox/"))).toHaveLength(before);
    expect((await runs.history())[0]).toMatchObject({ outcome: "aborted", stop: "auth", failed: 0 });
  });

  it("passes over an episode too large for the per-run budget, and curates the next", async () => {
    const { store } = await setup();
    const { relay, runs } = relayOver(store);
    const run = asking(await relay.start({ curator: "hosted", model: "m", hosted: true })).run;
    const answerer = failing(script(), "mentions", 1, () => new BudgetExhausted(true));
    const done = await relay.autopilot({ runId: run, answerer, until: later() });
    expect(done).toMatchObject({ state: "done", report: { failed: [] } });
    const summary = (await runs.history())[0]!;
    expect(summary).toMatchObject({ outcome: "done", consolidated: 2, tooLarge: [expect.stringMatching(/^ep-/)] });
    expect(store.files.get("_hippo/review.md")).toContain("too large for the per-run budget");
  });

  it("replays a conflicting commit without paying for answers it already has", async () => {
    const relayed = await setup();
    const { store } = committing(relayed.store, (n) => {
      if (n > 0 || relayed.store.files.has("inbox/job-scout/2026-09-27T130000-fair.md")) return;
      relayed.store.files.set("inbox/job-scout/2026-09-27T130000-fair.md", episode("job-scout", "2026-09-27T13:00:00Z", "Career fair at Harbor University on 2026-10-20."));
      throw new StoreConflictError(["inbox/job-scout/2026-09-27T130000-fair.md"]);
    });
    const { relay } = relayOver(store);
    const run = asking(await relay.start({ curator: "hosted", model: "m", hosted: true })).run;
    const answerer = failing(script(), "never", 1, () => new Error("x"));
    await relay.autopilot({ runId: run, answerer, until: later(), units: 2 });
    // Episode 1's questions were each asked once, though its commit was tried twice.
    expect(answerer.asked).toEqual(["mentions", "claims"]);
  });

  it("can't be answered or skipped over MCP, only aborted; and only the Worker opens one", async () => {
    const { store } = await setup();
    // A clock that moves a minute per read, so a renewed lease would show.
    let ticks = 0;
    const { relay } = relayOver(store, { clock: () => new Date(now().getTime() + 60_000 * ticks++) });
    await expect(relay.start({ curator: "hosted", model: "m" })).rejects.toThrow('"hosted" is reserved');
    const run = asking(await relay.start({ curator: "hosted", model: "m", hosted: true })).run;
    const lease = (await relay.status()).run!.leaseUntil;
    await expect(relay.answer({ runId: run, answers: [] })).rejects.toThrow("can't be answered or skipped");
    await expect(relay.skip({ runId: run, reason: "x" })).rejects.toThrow("can't be answered or skipped");
    // Refused calls don't keep a hosted run's lease alive.
    expect((await relay.status()).run!.leaseUntil).toBe(lease);
    expect(await relay.abort(run)).toMatchObject({ history: [{ id: run, outcome: "aborted" }] });
    // An agent's run, whatever it is called, is never driven by the model.
    const agents = asking(await relay.start({ curator: "archivist", model: "m" })).run;
    await expect(relay.autopilot({ runId: agents, answerer: script(), until: later() })).rejects.toThrow("isn't a hosted run");
  });

  it("leaves set-aside episodes and excluded ones out, unless the owner asks for every episode", async () => {
    const { store } = await setup();
    const vault = await Vault.load(store, { now });
    const [a, b, c] = vault.episodes.map((e) => e.id);
    await store.write("_hippo/review.md", `---\nfailures:\n  ${a}: { attempts: 3, reason: refused }\n---\n`);
    const { relay } = relayOver(store);
    const hosted = await relay.start({ curator: "hosted", model: "m", hosted: true, exclude: [b!] });
    expect((await relay.status()).run!.progress.total).toBe(1);
    await relay.abort(asking(hosted).run);
    await relay.start({ curator: "hosted", model: "m", hosted: true, includeSetAside: true });
    expect((await relay.status()).run!.progress.total).toBe(3);
    expect(c).toBeDefined();
  });

  it("waits for a late alarm, and expires after six hours", async () => {
    const { store } = await setup();
    let at = now();
    const { relay, runs } = relayOver(store, { clock: () => at });
    const run = asking(await relay.start({ curator: "hosted", model: "m", hosted: true })).run;
    // Its lease passed two hours ago, but a hosted run is still waiting for its slice.
    at = new Date(now().getTime() + 2 * 60 * 60_000);
    await relay.expire(at);
    expect((await runs.get())?.id).toBe(run);
    expect(await relay.autopilot({ runId: run, answerer: script(), until: at, units: 0 })).toMatchObject({ state: "paused" });
    at = new Date(now().getTime() + 7 * 60 * 60_000);
    await relay.expire(at);
    expect((await runs.history())[0]).toMatchObject({ id: run, outcome: "expired" });
  });
});

describe("the standby gate", () => {
  const healthy = { healthy: true, lastRun: "2026-09-27T03:00:00.000Z" };
  const at = new Date("2026-09-27T21:00:00.000Z");
  const hours = (h: number) => new Date(at.getTime() - h * 3_600_000);

  it("without hosted curation, every run is needed, an empty inbox's too", async () => {
    expect(standbyVerdict(undefined, { episodes: 0, rulings: 0 }, at)).toEqual({ needed: true });
    const store = fixtureStore({});
    const runs = new MemoryRunStore();
    const relay = new SleepRelay({ open: async (n) => ({ vault: await Vault.load(store, { now: () => n }), store }), runs, clock: now });
    const step = await relay.start({ curator: "archivist", model: "scripted" });
    expect(step.state).toBe("done");
    expect(await runs.history()).toHaveLength(1);
  });

  it("stands by while Hippocampus curates, and wakes when it pauses or memories wait too long", () => {
    expect(standbyVerdict(healthy, { episodes: 2, oldest: hours(30), rulings: 0 }, at)).toMatchObject({ needed: false, reason: "hosted" });
    expect(standbyVerdict(healthy, { episodes: 2, oldest: hours(37), rulings: 0 }, at)).toEqual({ needed: true });
    expect(standbyVerdict({ healthy: false }, { episodes: 2, oldest: hours(1), rulings: 0 }, at)).toEqual({ needed: true });
    expect(standbyVerdict(healthy, { episodes: 0, rulings: 0 }, at)).toMatchObject({ needed: false, reason: "idle" });
    expect(standbyVerdict(healthy, { episodes: 0, rulings: 1 }, at)).toMatchObject({ needed: false, reason: "hosted" });
  });

  it("counts waiting from arrival, not from when the thing happened, and leaves set-aside episodes out", async () => {
    const landed = new Date("2026-09-27T20:00:00.000Z");
    const id = `ep-${ulid(landed.getTime())}`;
    expect(arrivedAt({ id, at: "2025-01-01T00:00:00Z" })).toEqual(landed);
    // Written by hand: no ULID, so `at` is all there is.
    expect(arrivedAt({ id: "ep-1k2j3h4", at: "2026-09-20T10:00:00Z" })).toEqual(new Date("2026-09-20T10:00:00Z"));
    const store = fixtureStore({
      [`inbox/home-finder/2026-09-27T200000-old.md`]: `---\nid: ${id}\nagent: home-finder\nkind: fact\nat: 2025-01-01T00:00:00Z\n---\nThe Alfama flat was first listed in 2025.\n`,
      "inbox/campus-agent/stuck.md": episode("campus-agent", "2026-09-01T10:00:00Z", "Something that keeps failing."),
    });
    const vault = await Vault.load(store, { now });
    const stuck = vault.episodes.find((e) => e.agent === "campus-agent")!.id;
    const work = waitingWork(vault, { [stuck]: { attempts: 3, reason: "refused" } });
    expect(work).toMatchObject({ episodes: 1, setAside: 1, oldest: landed, rulings: 0 });
    expect(standbyVerdict(healthy, work, at)).toMatchObject({ needed: false, reason: "hosted" });
  });

  it("answers not_needed without opening a run or touching history, and force runs anyway", async () => {
    const { store } = await setup();
    const runs = new MemoryRunStore();
    const gate: SleepGate = async ({ vault, failures, now: n }) => standbyVerdict(healthy, waitingWork(vault, failures), n);
    const relay = new SleepRelay({ open: async (n) => ({ vault: await Vault.load(store, { now: () => n }), store }), runs, clock: now, gate });
    const quiet = await relay.start({ curator: "archivist", model: "scripted" });
    expect(quiet).toMatchObject({ state: "not_needed", reason: "hosted", hosted: { lastRun: healthy.lastRun } });
    expect(await runs.get()).toBeUndefined();
    expect(await runs.history()).toEqual([]);
    expect((await relay.start({ curator: "archivist", model: "scripted", force: true })).state).toBe("ask");
  });
});

describe("how many episodes a run takes", () => {
  /** The night's three episodes plus `extra` more, with the vault's `batch_size` set when given. */
  async function inbox(extra: number, batchSize?: number) {
    const { store } = await setup();
    for (let i = 0; i < extra; i++)
      await store.write(`inbox/home-finder/2026-09-27T13${String(i).padStart(2, "0")}00-viewing.md`, episode("home-finder", "2026-09-27T13:00:00Z", `Viewing ${i + 1} of a flat in Lisbon.`));
    if (batchSize !== undefined) await store.write("_hippo/config.yaml", `${(await store.read("_hippo/config.yaml"))!}curator:\n  batch_size: ${batchSize}\n`);
    return store;
  }

  it("takes the vault's whole batch_size, not ten", async () => {
    const { relay } = relayOver(await inbox(12));
    const step = await relay.start({ curator: "archivist", model: "scripted" });
    expect(step.state === "ask" && step.progress.total).toBe(15);
  });

  it("records a full batch in the review, so the rest read as next rather than failed", async () => {
    const store = await inbox(2, 3);
    const { relay } = relayOver(store);
    const first = await relay.start({ curator: "archivist", model: "scripted" });
    expect(first.state === "ask" && first.progress.total).toBe(3);
    const { report } = await runToEnd(relay, first, script());
    expect(report.remaining).toBe(2);
    const review = (await store.read("_hippo/review.md"))!;
    expect(parseDoc(review).data.batch_full).toBe(3);
    expect(review).toContain("2 still in the inbox (this run took its limit of 3; the rest are next)");
  });

  it("records no full batch when everything fit", async () => {
    const store = await inbox(0);
    const { relay } = relayOver(store);
    await runToEnd(relay, await relay.start({ curator: "archivist", model: "scripted" }), script());
    expect(parseDoc((await store.read("_hippo/review.md"))!).data.batch_full).toBeUndefined();
  });
});
