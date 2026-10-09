import { HippoService, SearchIndex, Vault, type MemoryStore } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { d1 } from "./d1.ts";
import { HippoIndex, INDEX_SCHEMA_VERSION } from "./hippo-index.ts";
import { nodeSqlite } from "./node.ts";
import type { SqlValue } from "./sql.ts";

const now = () => new Date("2026-09-27T21:00:00.000Z");

const extra = {
  "characters/joao-silva.md": `---\ntype: character\ntitle: João Silva\naliases: [the landlord]\ntags: [housing]\nfacts:\n  phone: { value: "+351 900 000 001", status: canon, by: home-finder }\n  iban: { value: "secret://joao-silva/iban", status: canon, by: home-finder }\nrelations:\n  - { rel: owns, target: "[[alfama-flat]]" }\n---\n`,
  "locations/alfama-flat.md": `---\ntype: location\ntitle: Alfama flat\nrelations:\n  - { rel: located_in, target: "[[lisbon]]" }\n---\n`,
  "locations/lisbon.md": `---\ntype: location\ntitle: Lisbon\naliases: [Lisboa]\n---\n`,
  "characters/ilkay-yilmaz.md": `---\ntype: character\ntitle: İlkay Yılmaz\ntags: [university]\n---\nClassmate from the exchange programme.\n`,
  "inbox/campus-agent/2026-09-27T110000-enrol.md": `---\nagent: campus-agent\nkind: fact\nat: 2026-09-27T11:00:00Z\n---\nEnrolment at Harbor University opens 2026-10-01.\n`,
  "inbox/residency-agent/2026-09-27T120000-pass.md": `---\nagent: residency-agent\nkind: fact\nat: 2026-09-27T12:00:00Z\nsecret: true\n---\nPassport number U12345678.\n`,
};

async function setup(files: Record<string, string> = extra) {
  const store = fixtureStore(files);
  const index = await HippoIndex.open(nodeSqlite(":memory:"));
  return { store, index, vault: await Vault.load(store, { now }) };
}

describe("HippoIndex", () => {
  it("finds the same top hit as the in-memory index", async () => {
    const { index, vault } = await setup();
    await index.sync(vault);
    const mini = new SearchIndex(vault);
    for (const q of ["migration agency", "Agência", "residence permit", "Lisbon Migration", "LMA", "exchange programme", "landlord", "Lisboa", "Joao", "harbor university"]) {
      const [want] = await mini.search(q, { limit: 1 });
      const [got] = await index.search(q, { limit: 1 });
      expect(want, q).toBeDefined();
      expect(got?.id, q).toBe(want!.id);
    }
  });

  it("folds diacritics and Turkish dotted/dotless i", async () => {
    const { index, vault } = await setup();
    await index.sync(vault);
    for (const q of ["ilkay yilmaz", "İLKAY", "Yılmaz", "joão", "agencia de migracao"]) expect((await index.search(q, { limit: 1 }))[0], q).toBeDefined();
    expect((await index.search("ilkay"))[0]!.id).toBe("ilkay-yilmaz");
  });

  it("recovers from typos through name trigrams", async () => {
    const { index, vault } = await setup();
    await index.sync(vault);
    expect((await index.search("migraton agncy", { kind: "entity" }))[0]?.id).toBe("migration-agency");
    expect((await index.search("residnce", { kind: "entity" }))[0]?.id).toBe("residence-permit");
    expect(await index.search("xylophone quartz")).toEqual([]);
  });

  it("filters by kind and entity type", async () => {
    const { index, vault } = await setup();
    await index.sync(vault);
    const episodes = await index.search("harbor university", { kind: "episode" });
    expect(episodes.map((h) => h.kind)).toEqual(["episode"]);
    const locations = await index.search("lisbon", { kind: "entity", types: ["location"] });
    expect(locations.length).toBeGreaterThan(0);
    expect(locations.every((h) => h.type === "location")).toBe(true);
  });

  it("never indexes secret facts or secret episodes", async () => {
    const { index, vault } = await setup();
    await index.sync(vault);
    const text = (await index.db.all<{ t: string }>("SELECT title || ' ' || aliases || ' ' || text AS t FROM docs_fts")).map((r) => r.t).join("\n");
    expect(text).not.toContain("secret://");
    expect(text).not.toContain("u12345678");
    expect(await index.search("U12345678")).toEqual([]);
  });

  it("indexes typed relations both ways", async () => {
    const { index, vault } = await setup();
    await index.sync(vault);
    expect(await index.neighbors("alfama-flat")).toEqual(
      expect.arrayContaining([
        { rel: "located_in", dir: "out", slug: "lisbon" },
        { rel: "owns", dir: "in", slug: "joao-silva" },
      ]),
    );
  });

  it("only rewrites what changed", async () => {
    const { store, index, vault } = await setup();
    const first = await index.sync(vault);
    expect(first).toMatchObject({ updated: 0, removed: 0, unchanged: 0 });
    expect(await index.sync(vault)).toEqual({ added: 0, updated: 0, removed: 0, unchanged: first.added });

    await store.write("locations/lisbon.md", `---\ntype: location\ntitle: Lisbon\naliases: [Lisboa, Olisipo]\n---\n`);
    await store.remove("inbox/campus-agent/2026-09-27T110000-enrol.md");
    await store.write("factions/harbor-university.md", `---\ntype: faction\ntitle: Harbor University\n---\n`);
    const stats = await index.sync(await Vault.load(store, { now }));
    expect(stats).toEqual({ added: 1, updated: 1, removed: 1, unchanged: first.added - 2 });
    expect((await index.search("olisipo"))[0]?.id).toBe("lisbon");
    expect(await index.search("enrolment", { kind: "episode" })).toEqual([]);
    expect(await index.counts()).toEqual({ docs: first.added, edges: 2 });
  });

  it("serializes concurrent syncs", async () => {
    const { index, vault } = await setup();
    await Promise.all([index.sync(vault), index.sync(vault), index.sync(vault)]);
    expect((await index.counts()).docs).toBe((await index.sync(vault)).unchanged);
  });

  it("rebuilds from scratch when the schema version changes", async () => {
    const db = nodeSqlite(":memory:");
    const { vault } = await setup();
    await (await HippoIndex.open(db)).sync(vault);
    await db.batch([{ sql: "UPDATE meta SET value = '0' WHERE key = 'schema'" }]);
    const reopened = await HippoIndex.open(db);
    expect(await reopened.counts()).toEqual({ docs: 0, edges: 0 });
    expect((await db.all<{ value: string }>("SELECT value FROM meta"))[0]!.value).toBe(String(INDEX_SCHEMA_VERSION));
  });

  it("backs HippoService: recall sees an episode right after remember", async () => {
    const { store, index } = await setup();
    const service = new HippoService(store as MemoryStore, { now, searcher: index.searcher });
    await service.remember("home-finder", { text: "Viewing of the Alfama flat on Friday at 18:00" });
    const r = await service.recall("alfama viewing");
    expect(r.entities[0]?.ref).toBe("[[alfama-flat]]");
    expect(r.pending.map((p) => p.text)).toEqual([expect.stringContaining("Viewing of the Alfama flat")]);
    await expect(service.get("migraton agency")).rejects.toThrow(/did you mean \[\[migration-agency\]\]/);
  });
});

describe("d1 driver", () => {
  /** D1's API shape over node:sqlite, to check the adapter's mapping. */
  function fakeD1() {
    const db = nodeSqlite(":memory:");
    const batches: number[] = [];
    const stmt = (sql: string, params: SqlValue[] = []) => ({
      sql,
      params,
      bind: (...values: SqlValue[]) => stmt(sql, values),
      all: async <T>() => ({ results: await db.all<T>(sql, params) }),
    });
    return {
      batches,
      prepare: (sql: string) => stmt(sql),
      batch: async (statements: ReturnType<typeof stmt>[]) => {
        batches.push(statements.length);
        await db.batch(statements.map((s) => ({ sql: s.sql, params: s.params })));
      },
    };
  }

  it("runs the index on D1's API, in bounded batches", async () => {
    const npcs = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`characters/npc-${i}.md`, `---\ntype: character\ntitle: NPC ${i}\n---\n`]));
    const { vault } = await setup({ ...extra, ...npcs });
    const fake = fakeD1();
    const index = await HippoIndex.open(d1(fake));
    await index.sync(vault);
    expect((await index.search("npc 42", { limit: 1 }))[0]?.id).toBe("npc-42");
    expect(Math.max(...fake.batches)).toBeLessThanOrEqual(500);
    expect(fake.batches.length).toBeGreaterThan(2);
  });
});
