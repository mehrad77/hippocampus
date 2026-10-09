import { blobAsBuffer, type SqlDriver, type SqlValue } from "./sql.ts";

/** The slice of Cloudflare's `D1Database` the index uses, typed structurally so this package needs no Workers types. */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown>;
}

export interface D1StatementLike {
  bind(...values: (SqlValue | ArrayBuffer)[]): D1StatementLike;
  all<T>(): Promise<{ results: T[] }>;
}

/** A D1 database as the index's SQL driver. D1 batches run as one transaction. */
export function d1(db: D1Like): SqlDriver {
  return {
    async all<T>(sql: string, params: SqlValue[] = []) {
      return (await db.prepare(sql).bind(...params.map(blobAsBuffer)).all<T>()).results;
    },
    async batch(statements) {
      if (statements.length) await db.batch(statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? []).map(blobAsBuffer))));
    },
  };
}
