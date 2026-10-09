import { fold, searchDocs, unwrapLink, type SearchDoc, type SearchHit, type SearchOptions, type Searcher, type Vault } from "@hippocampus/core";
import type { SqlDriver, SqlStatement, SqlValue } from "./sql.ts";

/** Bump when the tables change. The index is derived from the vault, so a mismatch just rebuilds it. */
export const INDEX_SCHEMA_VERSION = 1;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS docs (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, type TEXT NOT NULL, hash TEXT NOT NULL)",
  // Text is folded before it gets here (Turkish ı/İ included), so the tokenizer only splits.
  "CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title, aliases, text, tokenize = 'unicode61 remove_diacritics 2')",
  // Names again, as trigrams: typo-tolerant lookup when exact terms find nothing.
  "CREATE VIRTUAL TABLE IF NOT EXISTS names_tri USING fts5(names, tokenize = 'trigram')",
  "CREATE TABLE IF NOT EXISTS edges (src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS edges_src ON edges (src)",
  "CREATE INDEX IF NOT EXISTS edges_dst ON edges (dst)",
];
const TABLES = ["docs", "docs_fts", "names_tri", "edges", "meta"];

// Same weights as the in-memory index: names count three times as much as body text.
const BM25 = "bm25(docs_fts, 3.0, 3.0, 1.0)";
const FUZZY_CANDIDATES = 50;
const FUZZY_MIN_SIMILARITY = 0.5;

export interface IndexEdge {
  rel: string;
  dir: "out" | "in";
  slug: string;
}

export interface SyncStats {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

interface IndexedDoc extends SearchDoc {
  edges: { rel: string; dst: string }[];
  hash: string;
}

const terms = (q: string) => fold(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function trigrams(word: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= word.length; i++) out.add(word.slice(i, i + 3));
  return out;
}

/** Dice coefficient over trigrams: 1 for identical words, ~0.5 for one or two typos in a long word. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** cyrb53: fast, good enough to notice a changed doc. Not for security. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Persistent full-text and graph index of a vault, on SQLite FTS5.
 *
 * It is a cache: `sync()` diffs the vault against what's indexed (by content hash) and writes only
 * what changed, so it can always be rebuilt from git and never needs migrations.
 */
export class HippoIndex implements Searcher {
  /** Syncs run one at a time: concurrent requests would otherwise race on the same rows. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly db: SqlDriver) {}

  static async open(db: SqlDriver): Promise<HippoIndex> {
    const index = new HippoIndex(db);
    await db.batch([{ sql: SCHEMA[0]! }]);
    const [row] = await db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'schema'");
    if (row?.value !== String(INDEX_SCHEMA_VERSION)) await index.rebuild();
    return index;
  }

  /** Drop everything and start empty (the next `sync()` fills it). */
  async rebuild(): Promise<void> {
    await this.db.batch([
      ...TABLES.map((t) => ({ sql: `DROP TABLE IF EXISTS ${t}` })),
      ...SCHEMA.map((sql) => ({ sql })),
      { sql: "INSERT INTO meta (key, value) VALUES ('schema', ?)", params: [String(INDEX_SCHEMA_VERSION)] },
    ]);
  }

  /** A `SearcherFactory` that brings the index up to date with the vault first. */
  readonly searcher = async (vault: Vault): Promise<Searcher> => {
    await this.sync(vault);
    return this;
  };

  sync(vault: Vault): Promise<SyncStats> {
    const run = this.queue.then(() => this.syncNow(vault));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async syncNow(vault: Vault): Promise<SyncStats> {
    const docs = indexedDocs(vault);
    const indexed = new Map((await this.db.all<{ id: string; hash: string }>("SELECT id, hash FROM docs")).map((r) => [r.id, r.hash]));
    const stats: SyncStats = { added: 0, updated: 0, removed: 0, unchanged: 0 };
    const statements: SqlStatement[] = [];
    for (const doc of docs.values()) {
      const known = indexed.get(doc.id);
      if (known === doc.hash) {
        stats.unchanged++;
        continue;
      }
      if (known === undefined) stats.added++;
      else {
        stats.updated++;
        statements.push(...deleteDoc(doc.id));
      }
      statements.push(...insertDoc(doc));
    }
    for (const id of indexed.keys()) {
      if (docs.has(id)) continue;
      stats.removed++;
      statements.push(...deleteDoc(id));
    }
    if (statements.length) await this.db.batch(statements);
    return stats;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const words = terms(query);
    if (!words.length) return [];
    const limit = opts.limit ?? 10;
    const [filter, params] = filterSql(opts);
    const rows = await this.db.all<{ id: string; kind: SearchHit["kind"]; type: string; rank: number }>(
      `SELECT d.id, d.kind, d.type, ${BM25} AS rank FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
       WHERE docs_fts MATCH ?${filter} ORDER BY rank LIMIT ?`,
      [words.map((w) => `"${w}"*`).join(" OR "), ...params, limit],
    );
    if (rows.length) return rows.map((r) => ({ id: r.id, kind: r.kind, type: r.type, score: -r.rank }));
    return this.fuzzy(words, filter, params, limit);
  }

  /** Close matches by trigram similarity of names, for typos ("migraton agncy"). */
  private async fuzzy(words: string[], filter: string, params: SqlValue[], limit: number): Promise<SearchHit[]> {
    const wanted = words.filter((w) => w.length >= 3).map(trigrams);
    const grams = [...new Set(wanted.flatMap((g) => [...g]))];
    if (!grams.length) return [];
    const rows = await this.db.all<{ id: string; kind: SearchHit["kind"]; type: string; names: string }>(
      `SELECT d.id, d.kind, d.type, names_tri.names FROM names_tri JOIN docs d ON d.rowid = names_tri.rowid
       WHERE names_tri MATCH ?${filter} ORDER BY bm25(names_tri) LIMIT ?`,
      [grams.map((g) => `"${g}"`).join(" OR "), ...params, FUZZY_CANDIDATES],
    );
    return rows
      .map((r) => {
        const nameGrams = terms(r.names).map(trigrams);
        const score = Math.max(...wanted.map((w) => Math.max(0, ...nameGrams.map((n) => similarity(w, n)))));
        return { id: r.id, kind: r.kind, type: r.type, score };
      })
      .filter((h) => h.score >= FUZZY_MIN_SIMILARITY)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Typed relations from and to an entity, without scanning the vault. */
  async neighbors(slug: string): Promise<IndexEdge[]> {
    return this.db.all<IndexEdge>(
      `SELECT rel, 'out' AS dir, dst AS slug FROM edges WHERE src = ?
       UNION ALL SELECT rel, 'in' AS dir, src AS slug FROM edges WHERE dst = ? AND src <> ?`,
      [slug, slug, slug],
    );
  }

  async counts(): Promise<{ docs: number; edges: number }> {
    const [d] = await this.db.all<{ n: number }>("SELECT count(*) AS n FROM docs");
    const [e] = await this.db.all<{ n: number }>("SELECT count(*) AS n FROM edges");
    return { docs: d?.n ?? 0, edges: e?.n ?? 0 };
  }
}

function indexedDocs(vault: Vault): Map<string, IndexedDoc> {
  const out = new Map<string, IndexedDoc>();
  for (const doc of searchDocs(vault)) {
    const e = doc.kind === "entity" ? vault.entities.get(doc.id) : undefined;
    // Targets are stored resolved, so the hash also changes when an alias starts pointing elsewhere.
    const edges = (e?.fm.relations ?? []).map((r) => ({ rel: r.rel, dst: vault.resolve(r.target)?.slug ?? unwrapLink(r.target) }));
    out.set(doc.id, { ...doc, edges, hash: hash(JSON.stringify([doc, edges])) });
  }
  return out;
}

const rowidOf = "(SELECT rowid FROM docs WHERE id = ?)";

function deleteDoc(id: string): SqlStatement[] {
  return [
    { sql: `DELETE FROM docs_fts WHERE rowid = ${rowidOf}`, params: [id] },
    { sql: `DELETE FROM names_tri WHERE rowid = ${rowidOf}`, params: [id] },
    { sql: "DELETE FROM edges WHERE src = ?", params: [id] },
    { sql: "DELETE FROM docs WHERE id = ?", params: [id] },
  ];
}

function insertDoc(doc: IndexedDoc): SqlStatement[] {
  return [
    { sql: "INSERT INTO docs (id, kind, type, hash) VALUES (?, ?, ?, ?)", params: [doc.id, doc.kind, doc.type, doc.hash] },
    { sql: `INSERT INTO docs_fts (rowid, title, aliases, text) VALUES (${rowidOf}, ?, ?, ?)`, params: [doc.id, fold(doc.title), fold(doc.aliases), fold(doc.text)] },
    { sql: `INSERT INTO names_tri (rowid, names) VALUES (${rowidOf}, ?)`, params: [doc.id, fold(`${doc.title} ${doc.aliases}`)] },
    ...doc.edges.map((e) => ({ sql: "INSERT INTO edges (src, rel, dst) VALUES (?, ?, ?)", params: [doc.id, e.rel, e.dst] })),
  ];
}

function filterSql(opts: SearchOptions): [string, SqlValue[]] {
  let sql = "";
  const params: SqlValue[] = [];
  if (opts.kind) {
    sql += " AND d.kind = ?";
    params.push(opts.kind);
  }
  if (opts.types?.length) {
    sql += ` AND (d.kind <> 'entity' OR d.type IN (${opts.types.map(() => "?").join(", ")}))`;
    params.push(...opts.types);
  }
  return [sql, params];
}
