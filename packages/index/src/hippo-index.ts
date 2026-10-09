import { fold, searchDocs, unwrapLink, type SearchDoc, type SearchHit, type SearchOptions, type Searcher, type Vault } from "@hippocampus/core";
import type { Embedder } from "./embedder.ts";
import { boostNeighbors, dot, fromBlob, normalize, rrf, toBlob } from "./hybrid.ts";
import type { SqlDriver, SqlStatement, SqlValue } from "./sql.ts";

/** Bump when the tables change. The index is derived from the vault, so a mismatch just rebuilds it. */
export const INDEX_SCHEMA_VERSION = 2;

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
  // One embedding per doc, for the doc version (`hash`) and model it was computed from.
  "CREATE TABLE IF NOT EXISTS vectors (doc_id TEXT PRIMARY KEY, model TEXT NOT NULL, hash TEXT NOT NULL, kind TEXT NOT NULL, type TEXT NOT NULL, vec BLOB NOT NULL)",
];
const TABLES = ["docs", "docs_fts", "names_tri", "edges", "vectors", "meta"];

// Same weights as the in-memory index: names count three times as much as body text.
const BM25 = "bm25(docs_fts, 3.0, 3.0, 1.0)";
const FUZZY_CANDIDATES = 50;
// Statements per transaction. A doc's statements never straddle two, so a failed sync leaves no half-indexed doc.
const BATCH_SIZE = 500;
const EMBED_BATCH = 32;
// D1 allows 100 bound parameters per statement.
const IN_CHUNK = 90;

export interface IndexOptions {
  /** Enables semantic recall: keyword and vector results fused, then re-ranked along relations. */
  embedder?: Embedder;
  /** Vector matches below this cosine similarity are ignored (default 0.35; tune per model). */
  minSimilarity?: number;
  /** Characters of a doc sent to the embedder (default 2000). */
  maxEmbedChars?: number;
}

interface StoredVector {
  hash: string;
  kind: SearchHit["kind"];
  type: string;
  vec: Float32Array;
}
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
  /** With an embedder: docs embedded this sync, and docs left without a vector because the embedder failed. */
  embedded?: number;
  embedFailed?: number;
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
  /** Vectors of the current model, mirrored from the database so search needn't read them every time. */
  private readonly vectors = new Map<string, StoredVector>();
  private readonly queryVectors = new Map<string, Float32Array>();
  /** Why the embedder last failed, if it did. Search then falls back to keywords. */
  lastEmbedError?: Error;

  private constructor(
    readonly db: SqlDriver,
    private readonly opts: IndexOptions,
  ) {}

  static async open(db: SqlDriver, opts: IndexOptions = {}): Promise<HippoIndex> {
    const index = new HippoIndex(db, opts);
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
    const groups: SqlStatement[][] = [];
    for (const doc of docs.values()) {
      const known = indexed.get(doc.id);
      if (known === doc.hash) {
        stats.unchanged++;
        continue;
      }
      if (known === undefined) stats.added++;
      else stats.updated++;
      // Delete first even when new: another process (or Worker isolate) may have just added it too.
      groups.push([...deleteDoc(doc.id), ...insertDoc(doc)]);
    }
    for (const id of indexed.keys()) {
      if (docs.has(id)) continue;
      stats.removed++;
      groups.push(deleteDoc(id));
    }
    let chunk: SqlStatement[] = [];
    for (const group of groups) {
      if (chunk.length && chunk.length + group.length > BATCH_SIZE) {
        await this.db.batch(chunk);
        chunk = [];
      }
      chunk.push(...group);
    }
    if (chunk.length) await this.db.batch(chunk);
    if (this.opts.embedder) await this.syncVectors(this.opts.embedder, docs, stats);
    return stats;
  }

  /** Embed docs that have no vector for this model and version, then mirror the table into memory. */
  private async syncVectors(embedder: Embedder, docs: Map<string, IndexedDoc>, stats: SyncStats): Promise<void> {
    const stored = new Map((await this.db.all<{ doc_id: string; hash: string; model: string }>("SELECT doc_id, hash, model FROM vectors")).map((r) => [r.doc_id, r]));
    const current = (id: string, hash: string) => {
      const v = stored.get(id);
      return v?.model === embedder.id && v.hash === hash;
    };
    const missing = [...docs.values()].filter((d) => !current(d.id, d.hash));
    stats.embedded = 0;
    stats.embedFailed = 0;
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      const batch = missing.slice(i, i + EMBED_BATCH);
      let vecs: Float32Array[];
      try {
        vecs = await embedder.embed(batch.map((d) => embedText(d, this.opts.maxEmbedChars ?? 2000)));
        if (vecs.length !== batch.length) throw new Error(`embedder returned ${vecs.length} vectors for ${batch.length} texts`);
        this.lastEmbedError = undefined;
      } catch (err) {
        // Stop for this sync rather than hammer a server that's down; the next sync retries.
        this.lastEmbedError = err instanceof Error ? err : new Error(String(err));
        stats.embedFailed = missing.length - i;
        break;
      }
      const statements = batch.map((d, j) => {
        const vec = normalize(vecs[j]!);
        this.vectors.set(d.id, { hash: d.hash, kind: d.kind, type: d.type, vec });
        stored.set(d.id, { doc_id: d.id, hash: d.hash, model: embedder.id });
        return {
          sql: "INSERT OR REPLACE INTO vectors (doc_id, model, hash, kind, type, vec) VALUES (?, ?, ?, ?, ?, ?)",
          params: [d.id, embedder.id, d.hash, d.kind, d.type, toBlob(vec)],
        };
      });
      await this.db.batch(statements);
      stats.embedded += batch.length;
    }
    // Others (another process, another isolate) may have embedded docs too: load what we lack.
    for (const id of this.vectors.keys()) if (!docs.has(id) || !current(id, this.vectors.get(id)!.hash)) this.vectors.delete(id);
    const lacking = [...docs.values()].filter((d) => current(d.id, d.hash) && this.vectors.get(d.id)?.hash !== d.hash).map((d) => d.id);
    for (let i = 0; i < lacking.length; i += IN_CHUNK) {
      const ids = lacking.slice(i, i + IN_CHUNK);
      const rows = await this.db.all<{ doc_id: string; hash: string; kind: SearchHit["kind"]; type: string; vec: unknown }>(
        `SELECT doc_id, hash, kind, type, vec FROM vectors WHERE model = ? AND doc_id IN (${ids.map(() => "?").join(", ")})`,
        [embedder.id, ...ids],
      );
      for (const r of rows) this.vectors.set(r.doc_id, { hash: r.hash, kind: r.kind, type: r.type, vec: fromBlob(r.vec) });
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const words = terms(query);
    if (!words.length) return [];
    const limit = opts.limit ?? 10;
    if (!this.opts.embedder) return this.keyword(words, opts, limit);
    const depth = Math.max(limit * 3, 30);
    const [keyword, semantic] = await Promise.all([this.keyword(words, opts, depth), this.semantic(this.opts.embedder, query, opts, depth)]);
    if (!semantic.length) return keyword.slice(0, limit);
    const fused = rrf([keyword, semantic]);
    const related = await this.adjacency(fused.slice(0, 3).map((h) => h.id));
    return boostNeighbors(fused, (id) => related.get(id) ?? new Set()).slice(0, limit);
  }

  /** Nearest docs by cosine similarity. Any embedder failure means no semantic results, never a failed search. */
  private async semantic(embedder: Embedder, query: string, opts: SearchOptions, k: number): Promise<SearchHit[]> {
    if (!this.vectors.size) return [];
    let q = this.queryVectors.get(query);
    if (!q) {
      try {
        const [v] = await embedder.embed([query]);
        if (!v) return [];
        q = normalize(v);
      } catch (err) {
        this.lastEmbedError = err instanceof Error ? err : new Error(String(err));
        return [];
      }
      // Recall searches entities and episodes with the same query; embed it once.
      this.queryVectors.set(query, q);
      if (this.queryVectors.size > 32) this.queryVectors.delete(this.queryVectors.keys().next().value!);
    }
    const types = opts.types?.length ? new Set(opts.types) : undefined;
    const min = this.opts.minSimilarity ?? 0.35;
    const hits: SearchHit[] = [];
    for (const [id, v] of this.vectors) {
      if (opts.kind && v.kind !== opts.kind) continue;
      if (types && v.kind === "entity" && !types.has(v.type)) continue;
      const score = dot(q, v.vec);
      if (score >= min) hits.push({ id, kind: v.kind, type: v.type, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** Slugs related to each of `ids`, in either direction. */
  private async adjacency(ids: string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
    if (!ids.length) return out;
    const marks = ids.map(() => "?").join(", ");
    const rows = await this.db.all<{ src: string; dst: string }>(`SELECT src, dst FROM edges WHERE src IN (${marks}) OR dst IN (${marks})`, [...ids, ...ids]);
    for (const { src, dst } of rows) {
      out.get(src)?.add(dst);
      out.get(dst)?.add(src);
    }
    return out;
  }

  private async keyword(words: string[], opts: SearchOptions, limit: number): Promise<SearchHit[]> {
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

function embedText(doc: IndexedDoc, max: number): string {
  return [doc.title, doc.aliases, doc.text].filter(Boolean).join("\n").slice(0, max);
}

function deleteDoc(id: string): SqlStatement[] {
  return [
    { sql: "DELETE FROM vectors WHERE doc_id = ?", params: [id] },
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
