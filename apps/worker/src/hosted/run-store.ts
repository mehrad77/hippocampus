import type { RecordedAnswer, RunState, RunStore, RunSummary } from "@hippocampus/curator/relay";
import type { SqlStorageLike } from "@hippocampus/index";

// The sleep relay's one run, in the vault's Durable Object SQLite, so a run survives the object
// being evicted between an agent's calls. Rows are JSON: the relay owns their shape. Recorded
// answers can hold secret values; the relay clears them when their unit commits.

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS sleep_run (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sleep_answer (unit TEXT NOT NULL, idx INTEGER NOT NULL, hash TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (unit, idx))",
  "CREATE TABLE IF NOT EXISTS sleep_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT NOT NULL)",
];

export class SqlRunStore implements RunStore {
  constructor(
    private readonly sql: SqlStorageLike,
    private readonly keep = 20,
  ) {
    for (const s of SCHEMA) sql.exec(s).toArray();
  }

  private rows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as T[];
  }

  async get(): Promise<RunState | undefined> {
    const [row] = this.rows<{ state: string }>("SELECT state FROM sleep_run WHERE id = 1");
    return row ? (JSON.parse(row.state) as RunState) : undefined;
  }

  async put(s: RunState): Promise<void> {
    this.rows("INSERT INTO sleep_run (id, state) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state", JSON.stringify(s));
  }

  async clear(): Promise<void> {
    this.rows("DELETE FROM sleep_run");
  }

  async answers(unit: string): Promise<RecordedAnswer[]> {
    return this.rows<{ idx: number; hash: string; value: string }>("SELECT idx, hash, value FROM sleep_answer WHERE unit = ? ORDER BY idx", unit).map((r) => ({
      index: r.idx,
      hash: r.hash,
      value: JSON.parse(r.value) as unknown,
    }));
  }

  async putAnswer(unit: string, a: RecordedAnswer): Promise<void> {
    // `undefined` isn't JSON; `null` is the closest a recorded answer can come back as.
    this.rows(
      "INSERT INTO sleep_answer (unit, idx, hash, value) VALUES (?, ?, ?, ?) ON CONFLICT (unit, idx) DO UPDATE SET hash = excluded.hash, value = excluded.value",
      unit,
      a.index,
      a.hash,
      JSON.stringify(a.value ?? null),
    );
  }

  async clearAnswers(unit?: string): Promise<void> {
    if (unit === undefined) this.rows("DELETE FROM sleep_answer");
    else this.rows("DELETE FROM sleep_answer WHERE unit = ?", unit);
  }

  async history(): Promise<RunSummary[]> {
    return this.rows<{ summary: string }>("SELECT summary FROM sleep_history ORDER BY seq DESC LIMIT ?", this.keep).map((r) => JSON.parse(r.summary) as RunSummary);
  }

  async pushHistory(s: RunSummary): Promise<void> {
    this.rows("INSERT INTO sleep_history (summary) VALUES (?)", JSON.stringify(s));
    this.rows("DELETE FROM sleep_history WHERE seq NOT IN (SELECT seq FROM sleep_history ORDER BY seq DESC LIMIT ?)", this.keep);
  }
}

/** `runs` with saving a run routed through `put` (which calls `next` to save), for decorators that act on it. */
export function onPut(runs: RunStore, put: (s: RunState, next: (s: RunState) => Promise<void>) => Promise<void>): RunStore {
  return {
    get: () => runs.get(),
    put: (s) => put(s, (x) => runs.put(x)),
    clear: () => runs.clear(),
    answers: (unit) => runs.answers(unit),
    putAnswer: (unit, a) => runs.putAnswer(unit, a),
    clearAnswers: (unit) => runs.clearAnswers(unit),
    history: () => runs.history(),
    pushHistory: (s) => runs.pushHistory(s),
  };
}
