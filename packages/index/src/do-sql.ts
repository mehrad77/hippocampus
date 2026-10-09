import { blobAsBuffer, type SqlDriver, type SqlValue } from "./sql.ts";

/**
 * The slice of a Durable Object's `ctx.storage.sql` this repo uses, typed structurally so no
 * package needs Workers types. `exec` is synchronous; its cursor is consumed with `toArray()`
 * before anything else runs, since a cursor held across an `await` has no snapshot isolation.
 */
export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** `ctx.storage` of a SQLite-backed Durable Object. */
export interface DurableSqlLike {
  sql: SqlStorageLike;
  /** The only way to group statements: `exec("BEGIN")` is refused in a Durable Object. */
  transactionSync<T>(fn: () => T): T;
}

/** A Durable Object's own SQLite as the index's SQL driver. BLOBs go in as ArrayBuffers and come back as them. */
export function doSql(storage: DurableSqlLike): SqlDriver {
  const exec = (sql: string, params: SqlValue[] = []) => storage.sql.exec(sql, ...params.map(blobAsBuffer)).toArray();
  return {
    async all<T>(sql: string, params?: SqlValue[]) {
      return exec(sql, params) as T[];
    },
    async batch(statements) {
      if (!statements.length) return;
      storage.transactionSync(() => {
        for (const s of statements) exec(s.sql, s.params);
      });
    },
  };
}
