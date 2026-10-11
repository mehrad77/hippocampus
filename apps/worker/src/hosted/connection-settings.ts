import type { SqlStorageLike } from "@hippocampus/index";

// What the person switched on or off for one connection (`key:<hash>` or `oauth:<grant>`), in the
// vault's Durable Object SQLite. An OAuth grant's scopes are fixed when it is made and the library
// can't change them later, so whether an app may curate is a switch read on every request: the token
// carries `curate` as the most it could ever do, and this decides whether it does now. A connection
// without a row is on its default (what the person chose when connecting it).

const SCHEMA = "CREATE TABLE IF NOT EXISTS connection_setting (credential TEXT PRIMARY KEY, curate INTEGER NOT NULL)";

export class ConnectionSettings {
  constructor(private readonly sql: SqlStorageLike) {
    sql.exec(SCHEMA).toArray();
  }

  /** The person's choice for `credential`, if they made one since connecting it. */
  curate(credential: string): boolean | undefined {
    const [row] = this.sql.exec("SELECT curate FROM connection_setting WHERE credential = ?", credential).toArray() as { curate: number }[];
    return row ? row.curate === 1 : undefined;
  }

  setCurate(credential: string, on: boolean): void {
    this.sql.exec("INSERT INTO connection_setting (credential, curate) VALUES (?, ?) ON CONFLICT (credential) DO UPDATE SET curate = excluded.curate", credential, on ? 1 : 0).toArray();
  }

  /** The choices made for these connections, by credential; those never changed are left out. */
  curation(credentials: string[]): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const c of credentials) {
      const on = this.curate(c);
      if (on !== undefined) out[c] = on;
    }
    return out;
  }

  /** A connection was revoked. */
  forget(credential: string): void {
    this.sql.exec("DELETE FROM connection_setting WHERE credential = ?", credential).toArray();
  }
}
