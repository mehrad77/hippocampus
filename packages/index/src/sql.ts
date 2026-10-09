export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

/**
 * The SQLite the index runs on: `node:sqlite` locally, D1 in the Worker. Async so both fit.
 * `batch` is atomic.
 */
export interface SqlDriver {
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  batch(statements: SqlStatement[]): Promise<void>;
  close?(): void;
}
