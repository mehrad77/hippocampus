import { MemoryStore } from "@hippocampus/core";
import type { HttpError } from "@hippocampus/dashboard";
import { nodeSqlStorage } from "@hippocampus/index/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBED_DAILY_LIMIT, cappedEmbedder, hostedEmbedding } from "./embed-cap.ts";
import { DailyCounter, checkInbox, inboxCounts, sizeGuard } from "./quotas.ts";

const caught = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err as HttpError;
  }
  return undefined;
};

describe("inbox quotas", () => {
  const before = ["inbox/README.md", "inbox/home-finder/a.md", "inbox/home-finder/_introduction-01.md", "inbox/home-finder/_draft.md", "quests/apartment-hunt.md"];

  it("counts episodes and introductions as the vault loads them", () => {
    expect(inboxCounts(before, "inbox")).toEqual({ episodes: 1, introductions: 1 });
  });

  it("refuses growth past a limit, never shrinking", () => {
    const q = { pendingEpisodes: 1, pendingIntroductions: 1 };
    const add = (path: string) => [{ path, content: "x" }];
    expect(caught(() => checkInbox(before, add("inbox/job-scout/b.md"), "inbox", q))).toMatchObject({ status: 429, code: "INBOX_FULL" });
    expect(caught(() => checkInbox(before, add("inbox/job-scout/_introduction-02.md"), "inbox", q))).toMatchObject({ status: 429, code: "INTRODUCTIONS_FULL" });
    // A new introduction replacing the agent's earlier one doesn't grow the count.
    expect(caught(() => checkInbox(before, [...add("inbox/home-finder/_introduction-02.md"), { path: "inbox/home-finder/_introduction-01.md", remove: true }], "inbox", q))).toBeUndefined();
    // Over the limit already (it was lowered): consolidating still works.
    const over = [...before, "inbox/job-scout/b.md", "inbox/job-scout/c.md"];
    expect(caught(() => checkInbox(over, [{ path: "inbox/job-scout/b.md", remove: true }], "inbox", q))).toBeUndefined();
    expect(caught(() => checkInbox(before, add("quests/paid-work.md"), "inbox", q))).toBeUndefined();
  });
});

describe("sizeGuard", () => {
  it("refuses a vault with too many files, or too much text, and says so once tripped", async () => {
    const files = { "a.md": "12345", "b.md": "67890", "c.md": "x" };
    const many = sizeGuard(new MemoryStore(files), { vaultFiles: 2, vaultBytes: 100 });
    await expect(many.read("a.md")).rejects.toMatchObject({ status: 413, code: "VAULT_TOO_LARGE" });
    expect(many.tripped?.code).toBe("VAULT_TOO_LARGE");

    const big = sizeGuard(new MemoryStore(files), { vaultFiles: 10, vaultBytes: 10 });
    expect(await big.read("a.md")).toBe("12345");
    // Each path counts once.
    expect(await big.read("a.md")).toBe("12345");
    expect(big.tripped).toBeUndefined();
    expect(await big.read("b.md")).toBe("67890");
    await expect(big.read("c.md")).rejects.toMatchObject({ code: "VAULT_TOO_LARGE" });
  });
});

describe("daily counters", () => {
  it("counts per kind per UTC day, refusing past the limit without counting", () => {
    let now = new Date("2026-10-01T23:00:00.000Z");
    const counter = new DailyCounter(nodeSqlStorage().sql, () => now);
    expect(counter.take("embed", 3, 4)).toBe(true);
    expect(counter.take("embed", 2, 4)).toBe(false);
    expect(counter.take("sleep_runs", 1, 1)).toBe(true);
    expect(counter.used("embed")).toBe(3);
    now = new Date("2026-10-02T00:30:00.000Z");
    expect(counter.used("embed")).toBe(0);
    expect(counter.take("embed", 4, 4)).toBe(true);
  });

  it("caps an embedder per day and keeps its id", async () => {
    const calls: string[][] = [];
    const inner = { id: "workers-ai:bge", embed: async (texts: string[]) => (calls.push(texts), texts.map(() => new Float32Array([1, 0]))) };
    const capped = cappedEmbedder(inner, new DailyCounter(nodeSqlStorage().sql, () => new Date("2026-10-01T09:00:00.000Z")), 3);
    expect(capped.id).toBe("workers-ai:bge");
    expect(await capped.embed(["permit", "lisbon"])).toHaveLength(2);
    await expect(capped.embed(["harbor", "university"])).rejects.toThrow(/daily embedding limit/);
    expect(calls).toEqual([["permit", "lisbon"]]);
  });

  it("is off unless the operator picks a provider", () => {
    expect(hostedEmbedding({})).toBeUndefined();
    expect(hostedEmbedding({ HIPPO_EMBED_MODEL: "nomic-embed-text" })).toBeUndefined();
    const ai = { run: async () => ({ data: [] }) };
    expect(hostedEmbedding({ HIPPO_EMBED_PROVIDER: "workers-ai" }, { ai })).toMatchObject({ dailyLimit: DEFAULT_EMBED_DAILY_LIMIT });
    expect(hostedEmbedding({ HIPPO_EMBED_PROVIDER: "workers-ai", HIPPO_EMBED_DAILY_LIMIT: "200" }, { ai })?.dailyLimit).toBe(200);
  });
});
