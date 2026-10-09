import { StoreConflictError, type Change, type CommitMeta } from "@hippocampus/core";

/** A batch to commit, and the commit the writer read when computing it. */
export interface CommitRequest {
  base: string;
  changes: Change[];
  meta: CommitMeta;
}

// Plain data, because it crosses Durable Object RPC (error classes don't survive it).
export type CommitResult = { ok: true } | { ok: false; conflict: string[] };

export interface ScribeClient {
  commit(request: CommitRequest): Promise<CommitResult>;
}

/** Commits a batch on top of `base` (GitHubStore's `apply`), throwing `StoreConflictError` when its paths moved. */
export interface BatchWriter {
  apply(changes: Change[], meta: CommitMeta, opts: { base?: string }): Promise<void>;
}

/**
 * The single writer: commits one batch at a time, each on top of the commit its writer read, so a
 * change based on stale state is refused instead of silently overwriting someone else's.
 */
export class ScribeQueue implements ScribeClient {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: BatchWriter) {}

  commit(request: CommitRequest): Promise<CommitResult> {
    const run = this.tail.then(() => this.commitNow(request));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async commitNow({ base, changes, meta }: CommitRequest): Promise<CommitResult> {
    try {
      await this.store.apply(changes, meta, { base });
      return { ok: true };
    } catch (err) {
      if (err instanceof StoreConflictError) return { ok: false, conflict: err.paths };
      throw err;
    }
  }
}
