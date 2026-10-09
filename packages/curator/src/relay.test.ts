import { MemoryStore, StoreConflictError, Vault, decryptSecret, humanText, parseDoc, type Change, type CommitMeta } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { episode, now, script, setup } from "./__fixtures__/night.ts";
import { ScriptedLLM } from "./llm.ts";
import { MemoryRunStore, RunBusyError, SleepRelay, type Question, type RelayStep } from "./relay.ts";
import { CURATOR_AUTHOR, sleep } from "./sleep.ts";

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
  return { report: step.report, seen, rejected };
}

const NOTE = /^(characters|factions|locations|items|lore|quests|campaigns|party)\//;
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

  it("asks again only what the vault changed", async () => {
    const { store } = await setup();
    const { relay } = relayOver(store);
    const agent = script();
    const first = asking(await relay.start({ curator: "archivist", model: "scripted" }));
    expect(first.questions.map((q) => q.name)).toEqual(["mentions", "mentions", "mentions"]);
    const second = asking(await relay.answer({ runId: first.run, answers: await answers(agent, first.questions) }));
    expect(second.questions.map((q) => q.name)).toEqual(["claims"]);
    expect(second.progress).toEqual({ done: 0, total: 3, unit: first.questions[0]!.unit });

    // The human adds a quest meanwhile. Every prompt lists the quests, so the recorded answers no longer fit.
    await store.write("quests/health-insurance.md", "---\ntype: quest\ntitle: Health insurance\nstatus: active\n---\n");
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
    const next = asking(await relay.skip({ runId: step.run, reason: "nothing worth saying" }));
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
});
