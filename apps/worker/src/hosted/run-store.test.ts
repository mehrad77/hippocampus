import { MemoryRunStore, type RunState, type RunStore, type RunSummary } from "@hippocampus/curator/relay";
import { nodeSqlStorage } from "@hippocampus/index/testing";
import { describe, expect, it } from "vitest";
import { SqlRunStore, onPut } from "./run-store.ts";

const state = (id: string): RunState => ({
  id,
  curator: "archivist",
  model: "test-model",
  now: "2026-10-01T21:00:00.000Z",
  leaseUntil: "2026-10-01T21:15:00.000Z",
  batch: ["ep-1", "ep-2"],
  cursor: 0,
  phase: "episodes",
  report: { model: "test-model", rulings: [], consolidated: [], failed: [], summaries: [], remaining: 0, changed: [], warnings: [] },
  evidence: { "residence-permit": ["[redacted]"] },
  commits: [],
  skipped: [],
  skippedSummaries: [],
  marks: [{ length: 9, hash: "a1b2" }],
  seed: 7,
});

const summary = (id: string): RunSummary => ({
  id,
  curator: "archivist",
  model: "test-model",
  started: "2026-10-01T21:00:00.000Z",
  ended: "2026-10-01T21:05:00.000Z",
  outcome: "done",
  consolidated: 1,
  failed: 0,
  skipped: 0,
  summaries: 1,
  remaining: 0,
  commits: 2,
});

// The relay's RunStore contract: the Durable Object's SQL store must behave like the in-memory one.
const stores: [string, (keep: number) => RunStore][] = [
  ["MemoryRunStore", (keep) => new MemoryRunStore(keep)],
  ["SqlRunStore", (keep) => new SqlRunStore(nodeSqlStorage().sql, keep)],
];

describe.each(stores)("RunStore contract: %s", (_, make) => {
  it("holds one run, as a copy", async () => {
    const runs = make(20);
    expect(await runs.get()).toBeUndefined();
    const s = state("run-a");
    await runs.put(s);
    s.cursor = 1;
    expect(await runs.get()).toEqual(state("run-a"));
    const got = (await runs.get())!;
    got.commits.push("mutated");
    expect((await runs.get())!.commits).toEqual([]);
    await runs.put({ ...state("run-a"), cursor: 2 });
    expect((await runs.get())!.cursor).toBe(2);
    await runs.clear();
    expect(await runs.get()).toBeUndefined();
  });

  it("records answers per unit, by index, replacing one at the same index", async () => {
    const runs = make(20);
    await runs.putAnswer("ep:ep-1", { index: 1, hash: "h1", value: { match: "new" } });
    await runs.putAnswer("ep:ep-1", { index: 0, hash: "h0", value: "plain" });
    await runs.putAnswer("ep:ep-2", { index: 0, hash: "x", value: [1, 2] });
    await runs.putAnswer("ep:ep-1", { index: 1, hash: "h1b", value: { match: "residence-permit" } });
    expect(await runs.answers("ep:ep-1")).toEqual([
      { index: 0, hash: "h0", value: "plain" },
      { index: 1, hash: "h1b", value: { match: "residence-permit" } },
    ]);
    expect(await runs.answers("ep:ep-3")).toEqual([]);
    await runs.clearAnswers("ep:ep-1");
    expect(await runs.answers("ep:ep-1")).toEqual([]);
    expect(await runs.answers("ep:ep-2")).toHaveLength(1);
    await runs.clearAnswers();
    expect(await runs.answers("ep:ep-2")).toEqual([]);
  });

  it("keeps the newest history first, up to its limit", async () => {
    const runs = make(2);
    expect(await runs.history()).toEqual([]);
    for (const id of ["run-a", "run-b", "run-c"]) await runs.pushHistory(summary(id));
    expect((await runs.history()).map((h) => h.id)).toEqual(["run-c", "run-b"]);
    expect((await runs.history())[0]).toEqual(summary("run-c"));
  });
});

describe("onPut", () => {
  it("routes saves through the decorator and forwards everything else", async () => {
    const inner = new MemoryRunStore();
    const seen: string[] = [];
    const runs = onPut(inner, async (s, next) => {
      seen.push(s.id);
      await next(s);
    });
    await runs.put(state("run-a"));
    await runs.putAnswer("u", { index: 0, hash: "h", value: 1 });
    await runs.pushHistory(summary("run-a"));
    expect(seen).toEqual(["run-a"]);
    expect((await inner.get())!.id).toBe("run-a");
    expect(await runs.answers("u")).toHaveLength(1);
    expect(await runs.history()).toHaveLength(1);
  });
});
