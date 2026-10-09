/** One file change in an atomic batch: write `content`, or remove the file. */
export type Change = { path: string; content: string } | { path: string; remove: true };

export interface CommitMeta {
  message: string;
  author?: { name: string; email: string };
}

/** Storage port. Paths are vault-relative and use forward slashes. */
export interface VaultStore {
  /** All file paths under `prefix` (recursive). */
  list(prefix?: string): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  /**
   * Apply a batch as one atomic change (e.g. a single git commit). Optional: stores without it
   * get the changes one by one through `write`/`remove`.
   */
  apply?(changes: Change[], meta: CommitMeta): Promise<void>;
  /** Stores that pin reads to one revision move to the latest one here. */
  refresh?(): Promise<void>;
}

/** The batch touched paths that changed underneath it since they were read. Reload and retry. */
export class StoreConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`vault changed underneath this write (${paths.join(", ")}); reload and retry`);
  }
}

/** Apply a batch through `store.apply` when it has one, else file by file. */
export async function applyChanges(store: VaultStore, changes: Change[], meta: CommitMeta): Promise<void> {
  if (!changes.length) return;
  if (store.apply) return store.apply(changes, meta);
  for (const c of changes) {
    if ("remove" in c) await store.remove(c.path);
    else await store.write(c.path, c.content);
  }
}

export class MemoryStore implements VaultStore {
  readonly files: Map<string, string>;

  constructor(files: Record<string, string> = {}) {
    this.files = new Map(Object.entries(files));
  }

  async list(prefix = ""): Promise<string[]> {
    const p = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
    return [...this.files.keys()].filter((k) => k.startsWith(p)).sort();
  }

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}
