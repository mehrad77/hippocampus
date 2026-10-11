export interface TreeFile {
  sha: string;
  mode: string;
}

export interface Snapshot {
  commit: string;
  tree: string;
  files: Map<string, TreeFile>;
}

/** Commit → its file listing. Commits are immutable, so entries never go stale. */
export class SnapshotCache {
  private readonly entries = new Map<string, Snapshot>();

  constructor(private readonly max = 8) {}

  get(commit: string): Snapshot | undefined {
    const hit = this.entries.get(commit);
    if (hit) {
      this.entries.delete(commit);
      this.entries.set(commit, hit);
    }
    return hit;
  }

  set(snap: Snapshot): void {
    this.entries.delete(snap.commit);
    this.entries.set(snap.commit, snap);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}

// Mirrors FsStore: editor and VCS internals are never vault content.
export const IGNORED = new Set([".git", ".obsidian", ".trash", "node_modules"]);
export const ignored = (path: string) => path.split("/").some((seg) => IGNORED.has(seg));

/** Base64 of the UTF-8 bytes, without Node's Buffer (this runs in Workers too). */
export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
