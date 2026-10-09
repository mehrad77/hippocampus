import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HippoService, Vault, fold, type SearchHit } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { extra } from "./__fixtures__/vault.ts";
import { d1 } from "./d1.ts";
import type { Embedder } from "./embedder.ts";
import { HippoIndex } from "./hippo-index.ts";
import { boostNeighbors, rrf } from "./hybrid.ts";
import { nodeSqlite } from "./node.ts";
import type { SqlValue } from "./sql.ts";

const now = () => new Date("2026-09-27T21:00:00.000Z");

/** Deterministic stand-in for a real model: words in the same concept share a dimension, so synonyms land close together. */
function conceptEmbedder(id = "test:concepts", concepts = [["flat", "apartment", "studio"], ["visa", "permit", "residence"], ["enrolment", "registration", "matriculation"]]) {
  const texts: string[] = [];
  const embedder: Embedder & { texts: string[] } = {
    id,
    texts,
    async embed(batch) {
      texts.push(...batch);
      return batch.map((text) => {
        const v = new Float32Array(concepts.length + 1);
        for (const word of fold(text).split(/[^\p{L}\p{N}]+/u)) concepts.forEach((c, i) => c.includes(word) && v[i]!++);
        v[concepts.length] = 0.1;
        return v;
      });
    },
  };
  return embedder;
}

const failing = (): Embedder => ({
  id: "test:concepts",
  embed: async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:1234");
  },
});

async function setup(embedder?: Embedder, db = nodeSqlite(":memory:")) {
  const store = fixtureStore(extra);
  const index = await HippoIndex.open(db, { embedder });
  return { store, index, vault: await Vault.load(store, { now }) };
}

const ids = (hits: SearchHit[]) => hits.map((h) => h.id);

describe("semantic recall", () => {
  it("finds a note by a synonym that keyword search misses", async () => {
    const plain = await setup();
    await plain.index.sync(plain.vault);
    expect(await plain.index.search("apartment", { kind: "entity" })).toEqual([]);

    const { index, vault } = await setup(conceptEmbedder());
    await index.sync(vault);
    expect(ids(await index.search("apartment", { kind: "entity" }))[0]).toBe("alfama-flat");
    expect(ids(await index.search("matriculation", { kind: "episode" }))).toHaveLength(1);
  });

  it("keeps exact keyword matches on top", async () => {
    const { index, vault } = await setup(conceptEmbedder());
    await index.sync(vault);
    expect(ids(await index.search("Lisboa", { limit: 1 }))).toEqual(["lisbon"]);
    expect(ids(await index.search("residence permit", { limit: 1 }))).toEqual(["residence-permit"]);
  });

  it("embeds only new or changed notes", async () => {
    const embedder = conceptEmbedder();
    const { store, index, vault } = await setup(embedder);
    const first = await index.sync(vault);
    expect(first.embedded).toBe(first.added);
    expect((await index.sync(vault)).embedded).toBe(0);
    await store.write("locations/alfama-flat.md", `---\ntype: location\ntitle: Alfama flat\naliases: [the studio]\n---\n`);
    expect((await index.sync(await Vault.load(store, { now }))).embedded).toBe(1);
  });

  it("re-embeds everything when the model changes", async () => {
    const db = nodeSqlite(":memory:");
    const a = await setup(conceptEmbedder("test:a"), db);
    const { added } = await a.index.sync(a.vault);
    const b = await setup(conceptEmbedder("test:b"), db);
    expect((await b.index.sync(b.vault)).embedded).toBe(added);
  });

  it("never sends secrets to the embedder", async () => {
    const embedder = conceptEmbedder();
    const { index, vault } = await setup(embedder);
    await index.sync(vault);
    expect(embedder.texts.join("\n")).not.toMatch(/U12345678|secret:\/\//);
  });

  it("falls back to keywords when the embedder is down, and catches up later", async () => {
    const db = nodeSqlite(":memory:");
    const down = await setup(failing(), db);
    const stats = await down.index.sync(down.vault);
    expect(stats).toMatchObject({ embedded: 0, embedFailed: stats.added });
    expect(down.index.lastEmbedError?.message).toContain("ECONNREFUSED");
    expect(ids(await down.index.search("Lisboa"))[0]).toBe("lisbon");
    const recall = await new HippoService(down.store, { now, searcher: down.index.searcher }).recall("alfama");
    expect(recall.entities[0]?.ref).toBe("[[alfama-flat]]");

    const up = await setup(conceptEmbedder(), db);
    expect((await up.index.sync(up.vault)).embedded).toBe(stats.added);
  });

  it("shares vectors between processes through the database", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "hippo-index-")), "index.sqlite");
    const a = await setup(conceptEmbedder(), nodeSqlite(path));
    await a.index.sync(a.vault);
    const embedder = conceptEmbedder();
    const b = await setup(embedder, nodeSqlite(path));
    expect((await b.index.sync(b.vault)).embedded).toBe(0);
    expect(ids(await b.index.search("apartment", { kind: "entity" }))[0]).toBe("alfama-flat");
    expect(embedder.texts).toEqual(["apartment"]);
  });

  it("stores vectors through D1's BLOB handling", async () => {
    // D1 binds BLOBs from ArrayBuffers and returns them as arrays of bytes.
    const db = nodeSqlite(":memory:");
    const toNode = (v: unknown) => (v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SqlValue));
    const fromNode = <T>(rows: T[]) => rows.map((r) => Object.fromEntries(Object.entries(r as object).map(([k, v]) => [k, v instanceof Uint8Array ? [...v] : v])) as T);
    const stmt = (sql: string, params: unknown[] = []) => ({
      sql,
      params,
      bind: (...values: unknown[]) => stmt(sql, values),
      all: async <T>() => ({ results: fromNode(await db.all<T>(sql, params.map(toNode))) }),
    });
    const fake = { prepare: (sql: string) => stmt(sql), batch: async (s: ReturnType<typeof stmt>[]) => db.batch(s.map((x) => ({ sql: x.sql, params: x.params.map(toNode) }))) };
    const a = await setup(conceptEmbedder(), d1(fake));
    await a.index.sync(a.vault);
    const b = await setup(conceptEmbedder(), d1(fake));
    await b.index.sync(b.vault);
    expect(ids(await b.index.search("apartment", { kind: "entity" }))[0]).toBe("alfama-flat");
  });
});

describe("hybrid ranking", () => {
  const hit = (id: string, kind: SearchHit["kind"] = "entity"): SearchHit => ({ id, kind, type: "location", score: 1 });

  it("fuses rankings so agreement beats a single first place", () => {
    const fused = rrf([
      [hit("a"), hit("b"), hit("c")],
      [hit("b"), hit("d"), hit("a")],
    ]);
    expect(ids(fused).slice(0, 2)).toEqual(["b", "a"]);
    expect(ids(fused)).toHaveLength(4);
  });

  it("lifts candidates related to the top hits, without adding new ones", () => {
    const ranked = [hit("alfama-flat"), hit("harbor-university"), hit("lisbon")].map((h, i) => ({ ...h, score: 1 - i * 0.01 }));
    const related = (id: string) => new Set(id === "alfama-flat" ? ["lisbon"] : []);
    expect(ids(boostNeighbors(ranked, related))).toEqual(["alfama-flat", "lisbon", "harbor-university"]);
    expect(ids(boostNeighbors(ranked, () => new Set(["somewhere-else"])))).toEqual(ids(ranked));
  });
});
