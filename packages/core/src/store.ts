/** Storage port. Paths are vault-relative and use forward slashes. */
export interface VaultStore {
  /** All file paths under `prefix` (recursive). */
  list(prefix?: string): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
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
