import type { SqlStorageLike } from "@hippocampus/index";
import type { BlobCache } from "./blob-cache.ts";

export interface SqliteBlobCacheOptions {
  /** Least recently used blobs are evicted past this many bytes of content (default 128 MiB). */
  maxBytes?: number;
  /** A read refreshes a blob's timestamp at most this often (default an hour), so warm reads don't each write a row. */
  touchEvery?: number;
  now?: () => number;
}

const MiB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const encoder = new TextEncoder();

/**
 * Blob cache in a Durable Object's SQLite, so a restarted object doesn't download the vault again.
 * Blobs are immutable, so the only upkeep is space: a byte cap evicts the least recently used, and
 * an alarm can `prune` what no current commit needs or `pruneOlderThan` what nobody read lately.
 * Use one per object: it keeps a running byte count that another instance wouldn't see.
 */
export class SqliteBlobCache implements BlobCache {
  private readonly maxBytes: number;
  private readonly now: () => number;
  private bytes?: number;

  constructor(
    private readonly sql: SqlStorageLike,
    private readonly opts: SqliteBlobCacheOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 128 * MiB;
    this.now = opts.now ?? Date.now;
    sql.exec("CREATE TABLE IF NOT EXISTS blobs (sha TEXT PRIMARY KEY, content TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL)").toArray();
    sql.exec("CREATE INDEX IF NOT EXISTS blobs_at ON blobs (at)").toArray();
  }

  async get(sha: string): Promise<string | undefined> {
    const [row] = this.sql.exec("SELECT content, at FROM blobs WHERE sha = ?", sha).toArray() as { content: string; at: number }[];
    if (!row) return undefined;
    this.touch(sha, row.at);
    return row.content;
  }

  async put(sha: string, content: string): Promise<void> {
    const size = encoder.encode(content).byteLength;
    if (size > this.maxBytes) return;
    // A tarball preload puts every file, cached or not: known blobs cost a read, not a write.
    const [known] = this.sql.exec("SELECT at FROM blobs WHERE sha = ?", sha).toArray() as { at: number }[];
    if (known) return this.touch(sha, known.at);
    const before = this.total();
    this.sql.exec("INSERT INTO blobs (sha, content, size, at) VALUES (?, ?, ?, ?)", sha, content, size, this.now()).toArray();
    this.bytes = before + size;
    if (this.bytes > this.maxBytes) this.evict();
  }

  /** Drop every blob not in `keep` (e.g. the shas of the current tree). Returns how many went. */
  prune(keep: Set<string>): number {
    const gone = (this.sql.exec("SELECT sha FROM blobs").toArray() as { sha: string }[]).filter((r) => !keep.has(r.sha));
    for (const { sha } of gone) this.sql.exec("DELETE FROM blobs WHERE sha = ?", sha).toArray();
    if (gone.length) this.bytes = undefined;
    return gone.length;
  }

  /** Drop blobs nobody has read or written for `ms`. Returns how many went. */
  pruneOlderThan(ms: number): number {
    const gone = this.sql.exec("DELETE FROM blobs WHERE at < ? RETURNING size", this.now() - ms).toArray() as { size: number }[];
    if (gone.length) this.bytes = undefined;
    return gone.length;
  }

  /** Blobs held and their bytes, for health reporting. */
  stats(): { blobs: number; bytes: number } {
    const [row] = this.sql.exec("SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM blobs").toArray() as { n: number; bytes: number }[];
    return { blobs: row?.n ?? 0, bytes: row?.bytes ?? 0 };
  }

  private touch(sha: string, at: number): void {
    const now = this.now();
    if (now - at >= (this.opts.touchEvery ?? HOUR)) this.sql.exec("UPDATE blobs SET at = ? WHERE sha = ?", now, sha).toArray();
  }

  private total(): number {
    return (this.bytes ??= this.stats().bytes);
  }

  /** Oldest first, down to 90% of the cap so the next few puts don't evict again. */
  private evict(): void {
    let total = this.stats().bytes;
    const target = this.maxBytes * 0.9;
    while (total > target) {
      const oldest = this.sql.exec("SELECT sha, size FROM blobs ORDER BY at, sha LIMIT 64").toArray() as { sha: string; size: number }[];
      if (!oldest.length) break;
      for (const r of oldest) {
        if (total <= target) break;
        this.sql.exec("DELETE FROM blobs WHERE sha = ?", r.sha).toArray();
        total -= r.size;
      }
    }
    this.bytes = total;
  }
}
