import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { DurableSqlLike } from "./do-sql.ts";

const TRANSACTION = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

const toNode = (v: unknown): SQLInputValue => {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // Stricter than it needs to be on purpose: callers should hand Cloudflare what it documents.
  if (ArrayBuffer.isView(v)) throw new TypeError("bind BLOBs as ArrayBuffer");
  return v as SQLInputValue;
};

const fromNode = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v]));

/**
 * A Durable Object's `ctx.storage` over node:sqlite, for tests. It behaves like the real one where
 * it matters: `exec` takes bindings and refuses transaction statements, `transactionSync` is atomic,
 * BLOBs go in and come out as ArrayBuffers, and FTS5 (trigram included) works.
 */
export function nodeSqlStorage(path = ":memory:"): DurableSqlLike & { close(): void } {
  const db = new DatabaseSync(path);
  return {
    sql: {
      exec(query, ...bindings) {
        if (TRANSACTION.test(query)) throw new Error("use transactionSync() instead of exec() for transactions");
        const stmt = db.prepare(query);
        // Several statements in one string (schema setup) run in full, as in a Durable Object.
        if (!bindings.length && !stmt.columns().length) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const rows = stmt.all(...bindings.map(toNode)).map((r) => fromNode(r as Record<string, unknown>));
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close() {
      db.close();
    },
  };
}
