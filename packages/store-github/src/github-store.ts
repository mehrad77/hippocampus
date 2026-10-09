import { StoreConflictError, VaultError, type Change, type CommitMeta, type VaultStore } from "@hippocampus/core";
import { MemoryBlobCache, gitBlobSha, type BlobCache } from "./blob-cache.ts";
import { untar } from "./tar.ts";

export interface GitHubStoreOptions {
  /** `owner/name` of the (private) vault repo. */
  repo: string;
  branch?: string;
  /** A token, or a function that mints one (e.g. a GitHub App installation token). */
  token: string | (() => Promise<string>);
  cache?: BlobCache;
  /** Tree listings by commit. Share one (with `cache`) across short-lived stores, e.g. one store per request. */
  snapshots?: SnapshotCache;
  fetch?: typeof fetch;
  apiUrl?: string;
  /** Times to rebase a batch onto a moved branch before giving up. */
  maxRebases?: number;
  /**
   * When more files than this are missing from the cache, download the commit as one tarball
   * instead of one request per file (default 20). Keeps cold loads within Workers' subrequest limits.
   */
  preloadThreshold?: number;
}

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

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

// Mirrors FsStore: editor and VCS internals are never vault content.
const IGNORED = new Set([".git", ".obsidian", ".trash", "node_modules"]);
const ignored = (path: string) => path.split("/").some((seg) => IGNORED.has(seg));

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Vault store over the GitHub REST API, for running without a local checkout.
 *
 * Reads come from one pinned commit, so a whole `Vault.load()` sees a consistent tree even while
 * others push. `apply()` writes a batch as a single commit through the Git Data API and only
 * fast-forwards the branch; if the branch moved, it rebases when none of its paths were touched
 * and throws `StoreConflictError` otherwise.
 */
export class GitHubStore implements VaultStore {
  readonly repo: string;
  readonly branch: string;
  private readonly cache: BlobCache;
  private readonly snapshots: SnapshotCache;
  private readonly fetch: typeof fetch;
  private readonly api: string;
  private snap?: Promise<Snapshot>;
  private preloaded?: { commit: string; done: Promise<void> };
  /** `write`/`remove` outside a batch, until `commit()`. `null` marks a removal. */
  private readonly pending = new Map<string, string | null>();

  constructor(private readonly opts: GitHubStoreOptions) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new VaultError(`GitHub repo must look like owner/name, got "${opts.repo}"`);
    this.repo = opts.repo;
    this.branch = opts.branch ?? "main";
    this.cache = opts.cache ?? new MemoryBlobCache();
    this.snapshots = opts.snapshots ?? new SnapshotCache();
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.api = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  }

  /** The commit reads are pinned to. */
  async head(): Promise<string> {
    return (await this.snapshot()).commit;
  }

  /** Re-pin reads to the branch's current head (one request when it hasn't moved). */
  async refresh(): Promise<void> {
    const current = await this.snap?.catch(() => undefined);
    const ref = await this.json<{ object: { sha: string } }>("GET", `git/ref/heads/${this.branch}`);
    if (current?.commit === ref.object.sha) return;
    this.snap = undefined;
    await this.snapshot(ref.object.sha);
  }

  async list(prefix = ""): Promise<string[]> {
    const p = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
    const paths = new Set((await this.snapshot()).files.keys());
    for (const [path, content] of this.pending) {
      if (content === null) paths.delete(path);
      else paths.add(path);
    }
    return [...paths].filter((k) => k.startsWith(p) && !ignored(k)).sort();
  }

  async read(path: string): Promise<string | undefined> {
    if (this.pending.has(path)) return this.pending.get(path) ?? undefined;
    const snap = await this.snapshot();
    const file = snap.files.get(path);
    if (!file) return undefined;
    const cached = await this.cache.get(file.sha);
    if (cached !== undefined) return cached;
    await this.preload(snap);
    const preloaded = await this.cache.get(file.sha);
    if (preloaded !== undefined) return preloaded;
    const content = await (await this.request("GET", `git/blobs/${file.sha}`, undefined, "application/vnd.github.raw+json")).text();
    await this.cache.put(file.sha, content);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.pending.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.pending.set(path, null);
  }

  /** Commit what `write`/`remove` buffered. */
  async commit(meta: CommitMeta): Promise<string[]> {
    const changes: Change[] = [...this.pending].map(([path, content]) => (content === null ? { path, remove: true } : { path, content }));
    await this.apply(changes, meta);
    return changes.map((c) => c.path);
  }

  /**
   * Commit a batch. `base` is the commit the changes were computed from, when that isn't this
   * store's own snapshot (e.g. a writer applying changes read by someone else).
   */
  async apply(changes: Change[], meta: CommitMeta, opts: { base?: string } = {}): Promise<void> {
    if (!changes.length) return;
    let base = opts.base ? await this.snapshotAt(opts.base) : await this.snapshot();
    for (let attempt = 0; ; attempt++) {
      const tree = await this.createTree(base, changes);
      if (tree === base.tree) break;
      const commit = await this.createCommit(tree, base.commit, meta);
      try {
        await this.request("PATCH", `git/refs/heads/${this.branch}`, { sha: commit, force: false });
        base = await this.advance(base, commit, tree, changes);
        this.snapshots.set(base);
        break;
      } catch (err) {
        if (!(err instanceof HttpError) || (err.status !== 422 && err.status !== 409)) throw err;
        const head = await this.fetchSnapshot();
        const moved = changes.map((c) => c.path).filter((p) => base.files.get(p)?.sha !== head.files.get(p)?.sha);
        if (moved.length || attempt >= (this.opts.maxRebases ?? 3)) {
          // Reads move to the new head, so "reload and retry" sees what we collided with.
          this.snap = Promise.resolve(head);
          throw new StoreConflictError(moved.length ? moved : changes.map((c) => c.path));
        }
        base = head;
      }
    }
    this.snap = Promise.resolve(base);
    for (const c of changes) this.pending.delete(c.path);
  }

  private snapshot(sha?: string): Promise<Snapshot> {
    this.snap ??= this.fetchSnapshot(sha).catch((err: unknown) => {
      this.snap = undefined;
      throw err;
    });
    return this.snap;
  }

  private async snapshotAt(commit: string): Promise<Snapshot> {
    const current = await this.snap?.catch(() => undefined);
    return current?.commit === commit ? current : this.fetchSnapshot(commit);
  }

  /** Fill the cache from the commit's tarball if many files are missing. Once per snapshot; failures fall back to per-file reads. */
  private preload(snap: Snapshot): Promise<void> {
    if (this.preloaded?.commit !== snap.commit) this.preloaded = { commit: snap.commit, done: this.preloadNow(snap).catch(() => undefined) };
    return this.preloaded.done;
  }

  private async preloadNow(snap: Snapshot): Promise<void> {
    const threshold = this.opts.preloadThreshold ?? 20;
    let missing = 0;
    for (const f of snap.files.values()) if ((await this.cache.get(f.sha)) === undefined && ++missing > threshold) break;
    if (missing <= threshold) return;
    const res = await this.request("GET", `tarball/${snap.commit}`);
    const archive = new Uint8Array(await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const decoder = new TextDecoder();
    for (const [name, bytes] of untar(archive)) {
      // Entries sit under one top-level `<owner>-<repo>-<sha>/` directory.
      const file = snap.files.get(name.slice(name.indexOf("/") + 1));
      if (file) await this.cache.put(file.sha, decoder.decode(bytes));
    }
  }

  private async fetchSnapshot(sha?: string): Promise<Snapshot> {
    sha ??= (await this.json<{ object: { sha: string } }>("GET", `git/ref/heads/${this.branch}`)).object.sha;
    const known = this.snapshots.get(sha);
    if (known) return known;
    const commit = await this.json<{ tree: { sha: string } }>("GET", `git/commits/${sha}`);
    const snap = { commit: sha, tree: commit.tree.sha, files: await this.readTree(commit.tree.sha) };
    this.snapshots.set(snap);
    return snap;
  }

  private async readTree(sha: string): Promise<Map<string, TreeFile>> {
    const files = new Map<string, TreeFile>();
    const full = await this.json<{ tree: TreeEntry[]; truncated: boolean }>("GET", `git/trees/${sha}?recursive=1`);
    if (!full.truncated) {
      for (const e of full.tree) if (e.type === "blob") files.set(e.path, { sha: e.sha, mode: e.mode });
      return files;
    }
    // Very large repos: GitHub caps recursive listings, so walk the tree level by level.
    const walk = async (treeSha: string, dir: string): Promise<void> => {
      const level = await this.json<{ tree: TreeEntry[] }>("GET", `git/trees/${treeSha}`);
      for (const e of level.tree) {
        const path = dir ? `${dir}/${e.path}` : e.path;
        if (e.type === "blob") files.set(path, { sha: e.sha, mode: e.mode });
        else if (e.type === "tree" && !IGNORED.has(e.path)) await walk(e.sha, path);
      }
    };
    await walk(sha, "");
    return files;
  }

  private async createTree(base: Snapshot, changes: Change[]): Promise<string> {
    const tree = changes.flatMap((c): { path: string; mode: string; type: "blob"; content?: string; sha?: null }[] => {
      const mode = base.files.get(c.path)?.mode ?? "100644";
      if (!("remove" in c)) return [{ path: c.path, mode, type: "blob", content: c.content }];
      // Removing a missing file is a no-op, like everywhere else in the store port.
      return base.files.has(c.path) ? [{ path: c.path, mode, type: "blob", sha: null }] : [];
    });
    if (!tree.length) return base.tree;
    return (await this.json<{ sha: string }>("POST", "git/trees", { base_tree: base.tree, tree })).sha;
  }

  private async createCommit(tree: string, parent: string, meta: CommitMeta): Promise<string> {
    const body = { message: meta.message, tree, parents: [parent], ...(meta.author ? { author: meta.author } : {}) };
    return (await this.json<{ sha: string }>("POST", "git/commits", body)).sha;
  }

  /** The snapshot after our own commit, computed locally (and the cache primed) instead of re-listing. */
  private async advance(base: Snapshot, commit: string, tree: string, changes: Change[]): Promise<Snapshot> {
    const files = new Map(base.files);
    for (const c of changes) {
      if ("remove" in c) {
        files.delete(c.path);
        continue;
      }
      const sha = await gitBlobSha(c.content);
      files.set(c.path, { sha, mode: base.files.get(c.path)?.mode ?? "100644" });
      await this.cache.put(sha, c.content);
    }
    return { commit, tree, files };
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.request(method, path, body)).json() as Promise<T>;
  }

  private async request(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
    const token = typeof this.opts.token === "string" ? this.opts.token : await this.opts.token();
    const res = await this.fetch(`${this.api}/repos/${this.repo}/${path}`, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "hippocampus",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return res;
    const detail = await res.text().catch(() => "");
    const message = (() => {
      try {
        return (JSON.parse(detail) as { message?: string }).message ?? detail;
      } catch {
        return detail;
      }
    })();
    if (res.status === 401) throw new VaultError(`GitHub rejected the token for ${this.repo} (401). Check HIPPO_GITHUB_TOKEN.`);
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
      throw new VaultError(`GitHub rate limit reached for ${this.repo}; resets at ${new Date(Number(res.headers.get("x-ratelimit-reset")) * 1000).toISOString()}`);
    if (res.status === 403) throw new VaultError(`GitHub denied ${method} ${path} on ${this.repo} (403): the token needs Contents read and write access. ${message}`);
    if (res.status === 404 && method === "GET" && path.startsWith("git/ref/"))
      throw new VaultError(`GitHub can't find branch "${this.branch}" of ${this.repo} (404): check the name, and that the token can see this repo`);
    throw new HttpError(res.status, `GitHub ${method} ${path} on ${this.repo} failed (${res.status}): ${message}`);
  }
}
