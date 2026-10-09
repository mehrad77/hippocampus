/** Content cache keyed by git blob sha. Blobs are immutable, so entries never go stale. */
export interface BlobCache {
  get(sha: string): Promise<string | undefined>;
  put(sha: string, content: string): Promise<void>;
}

/** In-process LRU, bounded by entry count. */
export class MemoryBlobCache implements BlobCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly max = 5000) {}

  async get(sha: string): Promise<string | undefined> {
    const hit = this.entries.get(sha);
    if (hit !== undefined) {
      this.entries.delete(sha);
      this.entries.set(sha, hit);
    }
    return hit;
  }

  async put(sha: string, content: string): Promise<void> {
    this.entries.delete(sha);
    this.entries.set(sha, content);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}

/** The sha git assigns to a blob with this content, so fresh commits can prime the cache without a round trip. */
export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header);
  bytes.set(body, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
