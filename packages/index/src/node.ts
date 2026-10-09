import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlDriver } from "./sql.ts";

/** A SQLite file (or `:memory:`) through Node's built-in driver: no native dependency. */
export function nodeSqlite(path: string): SqlDriver {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // `hippo serve` and a nightly `hippo sleep` may share the file.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return {
    async all<T>(sql: string, params: (string | number | null)[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const s of statements) db.prepare(s.sql).run(...(s.params ?? []));
        db.exec("COMMIT");
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
