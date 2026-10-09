import { StoreConflictError, VaultError, type Change, type CommitMeta, type VaultStore } from "@hippocampus/core";
import type { GitHubStore } from "@hippocampus/store-github";

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

/**
 * The single writer: commits one batch at a time, each on top of the commit its writer read, so a
 * change based on stale state is refused instead of silently overwriting someone else's.
 */
export class ScribeQueue implements ScribeClient {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: GitHubStore) {}

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

/** Reads straight from GitHub; every write goes through the Scribe as one atomic commit. */
export class ScribeStore implements VaultStore {
  constructor(
    private readonly reads: GitHubStore,
    private readonly scribe: ScribeClient,
  ) {}

  list(prefix?: string): Promise<string[]> {
    return this.reads.list(prefix);
  }

  read(path: string): Promise<string | undefined> {
    return this.reads.read(path);
  }

  refresh(): Promise<void> {
    return this.reads.refresh();
  }

  async write(): Promise<void> {
    throw new VaultError("the Worker writes only in atomic batches (Vault.flush)");
  }

  async remove(): Promise<void> {
    throw new VaultError("the Worker writes only in atomic batches (Vault.flush)");
  }

  async apply(changes: Change[], meta: CommitMeta): Promise<void> {
    const result = await this.scribe.commit({ base: await this.reads.head(), changes, meta });
    if (!result.ok) throw new StoreConflictError(result.conflict);
  }
}
