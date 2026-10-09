export type SqlValue = string | number | null | Uint8Array;

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

/** Cloudflare's SQL APIs (D1, Durable Objects) bind BLOBs from ArrayBuffers, not views. */
export const blobAsBuffer = (v: SqlValue): SqlValue | ArrayBuffer => (v instanceof Uint8Array ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) : v);
