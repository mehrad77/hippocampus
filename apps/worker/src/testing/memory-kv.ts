/** The slice of Workers KV the OAuth library uses, in memory. Expiry is honoured on read. */
export class MemoryKV {
  readonly entries = new Map<string, { value: string; metadata?: unknown; expires?: number }>();

  async get(key: string, opts?: "json" | "text" | { type?: "json" | "text" }): Promise<unknown> {
    const entry = this.entries.get(key);
    if (!entry || (entry.expires && entry.expires < Date.now())) return null;
    const type = typeof opts === "string" ? opts : opts?.type;
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, opts: { expirationTtl?: number; metadata?: unknown } = {}): Promise<void> {
    this.entries.set(key, { value, metadata: opts.metadata, expires: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const names = [...this.entries.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const page = names.slice(start, start + (opts.limit ?? 1000));
    const done = start + page.length >= names.length;
    return { keys: page.map((name) => ({ name, metadata: this.entries.get(name)!.metadata })), list_complete: done, cursor: done ? undefined : String(start + page.length) };
  }
}
