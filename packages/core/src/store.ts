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

/** A store that keeps writes and removes in memory over `base`, and the changes they add up to. */
export interface BufferedStore {
  /** Reads and lists see the buffered writes and removes; `base` is never written. */
  store: VaultStore;
  /** What the buffer would change in `base`, by path: writes that leave a file as it was are left out. */
  changes(): Promise<Change[]>;
}

/** Buffer writes over `base`, starting from `initial` changes (the last change to a path wins). */
export function bufferedStore(base: VaultStore, initial: Change[] = []): BufferedStore {
  // A path's buffered content, or `undefined` once it's removed.
  const over = new Map<string, string | undefined>(initial.map((c) => [c.path, "remove" in c ? undefined : c.content]));
  const store: VaultStore = {
    async list(prefix = "") {
      const dir = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
      const paths = new Set(await base.list(prefix));
      for (const [path, content] of over) {
        if (content === undefined) paths.delete(path);
        else if (path.startsWith(dir)) paths.add(path);
      }
      return [...paths].sort();
    },
    read: async (path) => (over.has(path) ? over.get(path) : base.read(path)),
    async write(path, content) {
      over.set(path, content);
    },
    async remove(path) {
      over.set(path, undefined);
    },
  };
  return {
    store,
    async changes() {
      const out: Change[] = [];
      for (const path of [...over.keys()].sort()) {
        const [now, was] = [over.get(path), await base.read(path)];
        if (now === was) continue;
        out.push(now === undefined ? { path, remove: true } : { path, content: now });
      }
      return out;
    },
  };
}
