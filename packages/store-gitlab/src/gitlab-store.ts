import { StoreConflictError, VaultError, type Change, type CommitMeta, type VaultStore } from "@hippocampus/core";
import { EmptyRepositoryError, HttpError, MemoryBlobCache, SnapshotCache, gitBlobSha, ignored, untar, type BlobCache, type Snapshot, type TreeFile } from "@hippocampus/store-git";

export interface GitLabStoreOptions {
  /** The project's numeric id, or its full path (`group/subgroup/name`). The id survives renames. */
  project: string | number;
  branch?: string;
  /**
   * A token, or a function that mints one (e.g. refreshes an OAuth access token). After a 401 the
   * function is asked once more with `refresh: true` and the request retried, since tokens expire.
   */
  token: string | ((opts?: { refresh?: boolean }) => Promise<string>);
  cache?: BlobCache;
  /** Whether a path's content may go into `cache`; see `GitHubStoreOptions.persist`. */
  persist?: (path: string) => boolean;
  /** Where blobs `persist` turns away are cached (default: an in-memory LRU per store). */
  transientCache?: BlobCache;
  /** Added to auth errors, e.g. how to reconnect. */
  hint?: { auth?: string };
  /** Tree listings by commit. Share one (with `cache`) across short-lived stores. */
  snapshots?: SnapshotCache;
  fetch?: typeof fetch;
  /** The REST root, default `https://gitlab.com/api/v4`. */
  apiUrl?: string;
  /** Times to rebase a batch onto a moved branch before giving up. */
  maxRebases?: number;
  /** When more files than this are missing from the cache, download the commit as one archive (default 20). */
  preloadThreshold?: number;
}

export interface ProjectInfo {
  /** GitLab's id for the project: survives renames and transfers. */
  id: number;
  /** `group/name` as GitLab spells it. */
  fullName: string;
  /** Only `private` is safe for a vault: `internal` is visible to every signed-in user of the instance. */
  visibility: "private" | "internal" | "public";
  private: boolean;
  defaultBranch: string;
  /** The branch this store reads and writes. */
  branch: string;
  /** No commits yet: `initialize()` makes the first. */
  empty: boolean;
  /** The commit reads are pinned to; none while the project is empty. */
  head?: string;
  /** The namespace that owns the project, for "is this my personal project" checks. */
  namespace: { id: number; kind: "user" | "group" };
}

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  id: string;
}

interface Action {
  action: "create" | "update" | "delete";
  file_path: string;
  content?: string;
}

const PAGE = 100;

/**
 * Vault store over the GitLab REST API (gitlab.com or self-managed), for running without a checkout.
 *
 * Like `GitHubStore`, reads come from one pinned commit and `apply()` writes a batch as a single
 * commit. GitLab's commits API commits onto the branch's current head and has no fast-forward
 * check, so we compare heads first and rebase or throw `StoreConflictError` when the branch moved.
 * A push landing between that check and the commit isn't detected; the hosted app's single writer
 * per vault makes that window theoretical there.
 */
export class GitLabStore implements VaultStore {
  readonly branch: string;
  private readonly cache: BlobCache;
  private readonly transient: BlobCache;
  private readonly snapshots: SnapshotCache;
  private readonly fetch: typeof fetch;
  private readonly api: string;
  private readonly project: string;
  private snap?: Promise<Snapshot>;
  private preloaded?: { commit: string; done: Promise<void> };
  /** `write`/`remove` outside a batch, until `commit()`. `null` marks a removal. */
  private readonly pending = new Map<string, string | null>();

  constructor(private readonly opts: GitLabStoreOptions) {
    const p = String(opts.project);
    if (!/^\d+$/.test(p) && !/^[\w.-]+(\/[\w.-]+)+$/.test(p)) throw new VaultError(`GitLab project must be an id or look like group/name, got "${p}"`);
    this.project = encodeURIComponent(p);
    this.branch = opts.branch ?? "main";
    this.cache = opts.cache ?? new MemoryBlobCache();
    this.transient = opts.transientCache ?? new MemoryBlobCache();
    this.snapshots = opts.snapshots ?? new SnapshotCache();
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.api = (opts.apiUrl ?? "https://gitlab.com/api/v4").replace(/\/$/, "");
  }

  private get name(): string {
    return decodeURIComponent(this.project);
  }

  /** The commit reads are pinned to. */
  async head(): Promise<string> {
    return (await this.snapshot()).commit;
  }

  /** Visibility, default branch, whether it's empty, and the commit reads are pinned to. */
  async info(): Promise<ProjectInfo> {
    const [p, head] = await Promise.all([
      this.json<{ id: number; path_with_namespace: string; visibility: ProjectInfo["visibility"]; default_branch?: string | null; namespace: { id: number; kind: "user" | "group" } }>("GET", ""),
      this.head().catch((err: unknown) => {
        if (err instanceof EmptyRepositoryError) return undefined;
        throw err;
      }),
    ]);
    return {
      id: p.id,
      fullName: p.path_with_namespace,
      visibility: p.visibility,
      private: p.visibility === "private",
      defaultBranch: p.default_branch ?? "main",
      branch: this.branch,
      empty: head === undefined,
      head,
      namespace: { id: p.namespace.id, kind: p.namespace.kind },
    };
  }

  /** Write a whole vault (e.g. the template) as one commit. Unlike GitHub, an empty project takes it directly. */
  async initialize(files: Record<string, string>, meta: CommitMeta): Promise<void> {
    const changes: Change[] = Object.entries(files).map(([path, content]) => ({ path, content }));
    if (!changes.length) return;
    this.snap = undefined;
    await this.apply(changes, meta);
  }

  /** Re-pin reads to the branch's current head (one request when it hasn't moved). */
  async refresh(): Promise<void> {
    const current = await this.snap?.catch(() => undefined);
    const head = await this.headCommit();
    if (current?.commit === head) return;
    this.snap = undefined;
    await this.snapshot(head);
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
    const cache = this.cacheFor(path);
    const cached = await cache.get(file.sha);
    if (cached !== undefined) return cached;
    await this.preload(snap);
    const preloaded = await cache.get(file.sha);
    if (preloaded !== undefined) return preloaded;
    const content = await (await this.request("GET", `repository/blobs/${file.sha}/raw`)).text();
    await cache.put(file.sha, content);
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
    let base = opts.base ? await this.snapshotAt(opts.base) : await this.snapshot().catch(emptyAsNothing);
    for (let attempt = 0; ; attempt++) {
      // Nothing to commit when every change already matches (or removes a missing file).
      const actions = await this.actions(base, changes);
      if (!actions.length) break;
      const head = await this.headCommit().catch(emptyAsNothing);
      if (head !== base?.commit) {
        const latest = head ? await this.fetchSnapshot(head) : undefined;
        const moved = changes.map((c) => c.path).filter((p) => base?.files.get(p)?.sha !== latest?.files.get(p)?.sha);
        if (moved.length || attempt >= (this.opts.maxRebases ?? 3)) {
          // Reads move to the new head, so "reload and retry" sees what we collided with.
          if (latest) this.snap = Promise.resolve(latest);
          throw new StoreConflictError(moved.length ? moved : changes.map((c) => c.path));
        }
        base = latest;
        continue;
      }
      const res = await this.json<{ id: string }>("POST", "repository/commits", {
        branch: this.branch,
        commit_message: meta.message,
        actions,
        ...(meta.author ? { author_name: meta.author.name, author_email: meta.author.email } : {}),
      });
      base = await this.advance(base, res.id, changes);
      this.snapshots.set(base);
      break;
    }
    if (base) this.snap = Promise.resolve(base);
    for (const c of changes) this.pending.delete(c.path);
  }

  private cacheFor(path: string): BlobCache {
    return this.opts.persist?.(path) === false ? this.transient : this.cache;
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

  /** The branch's head commit. An empty project has no branch to look up: that's an `EmptyRepositoryError`. */
  private async headCommit(): Promise<string> {
    try {
      return (await this.json<{ commit: { id: string } }>("GET", `repository/branches/${encodeURIComponent(this.branch)}`)).commit.id;
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 404) throw err;
      const project = await this.json<{ empty_repo?: boolean }>("GET", "");
      if (project.empty_repo) throw new EmptyRepositoryError(this.name);
      throw new VaultError(`GitLab can't find branch "${this.branch}" of ${this.name} (404): check the name, and that the token can see this project`);
    }
  }

  /** Fill the cache from the commit's archive if many files are missing. Once per snapshot; failures fall back to per-file reads. */
  private preload(snap: Snapshot): Promise<void> {
    if (this.preloaded?.commit !== snap.commit) this.preloaded = { commit: snap.commit, done: this.preloadNow(snap).catch(() => undefined) };
    return this.preloaded.done;
  }

  private async preloadNow(snap: Snapshot): Promise<void> {
    const threshold = this.opts.preloadThreshold ?? 20;
    let missing = 0;
    for (const [path, f] of snap.files) if ((await this.cacheFor(path).get(f.sha)) === undefined && ++missing > threshold) break;
    if (missing <= threshold) return;
    const res = await this.request("GET", `repository/archive.tar.gz?sha=${snap.commit}`);
    const archive = new Uint8Array(await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const decoder = new TextDecoder();
    for (const [name, bytes] of untar(archive)) {
      // Entries sit under one top-level `<project>-<ref>-<sha>/` directory.
      const path = name.slice(name.indexOf("/") + 1);
      const file = snap.files.get(path);
      if (file) await this.cacheFor(path).put(file.sha, decoder.decode(bytes));
    }
  }

  private async fetchSnapshot(sha?: string): Promise<Snapshot> {
    sha ??= await this.headCommit();
    const known = this.snapshots.get(sha);
    if (known) return known;
    // GitLab's API has no tree object ids on commits; the commit stands in for the tree.
    const snap = { commit: sha, tree: sha, files: await this.readTree(sha) };
    this.snapshots.set(snap);
    return snap;
  }

  private async readTree(sha: string): Promise<Map<string, TreeFile>> {
    const files = new Map<string, TreeFile>();
    for (let page = 1; page; ) {
      const res = await this.request("GET", `repository/tree?recursive=true&ref=${sha}&per_page=${PAGE}&page=${page}`);
      for (const e of (await res.json()) as TreeEntry[]) if (e.type === "blob") files.set(e.path, { sha: e.id, mode: e.mode });
      page = Number(res.headers.get("x-next-page")) || 0;
    }
    return files;
  }

  /** What each change does to `base`, skipping no-ops so an unchanged batch makes no commit. */
  private async actions(base: Snapshot | undefined, changes: Change[]): Promise<Action[]> {
    const out: Action[] = [];
    for (const c of changes) {
      const existing = base?.files.get(c.path);
      if ("remove" in c) {
        if (existing) out.push({ action: "delete", file_path: c.path });
      } else if (!existing) out.push({ action: "create", file_path: c.path, content: c.content });
      else if (existing.sha !== (await gitBlobSha(c.content))) out.push({ action: "update", file_path: c.path, content: c.content });
    }
    return out;
  }

  /** The snapshot after our own commit, computed locally (and the cache primed) instead of re-listing. */
  private async advance(base: Snapshot | undefined, commit: string, changes: Change[]): Promise<Snapshot> {
    const files = new Map(base?.files);
    for (const c of changes) {
      if ("remove" in c) {
        files.delete(c.path);
        continue;
      }
      const sha = await gitBlobSha(c.content);
      files.set(c.path, { sha, mode: base?.files.get(c.path)?.mode ?? "100644" });
      await this.cacheFor(c.path).put(sha, c.content);
    }
    return { commit, tree: commit, files };
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.request(method, path, body)).json() as Promise<T>;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const { token } = this.opts;
    const send = async (refresh: boolean) =>
      // An empty path is the project itself (`GET /projects/:id`).
      this.fetch(`${this.api}/projects/${this.project}${path ? `/${path}` : ""}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${typeof token === "string" ? token : await (refresh ? token({ refresh }) : token())}`,
          "user-agent": "hippocampus",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res = await send(false);
    // A minted token may have expired (OAuth access tokens last two hours): refresh it, once.
    if (res.status === 401 && typeof token !== "string") {
      await res.body?.cancel();
      res = await send(true);
    }
    if (res.ok) return res;
    const detail = await res.text().catch(() => "");
    const message = (() => {
      try {
        const parsed = JSON.parse(detail) as { message?: unknown; error?: string };
        return typeof parsed.message === "string" ? parsed.message : parsed.error ?? detail;
      } catch {
        return detail;
      }
    })();
    const hint = this.opts.hint?.auth ? ` ${this.opts.hint.auth}` : "";
    if (res.status === 401) throw new VaultError(`GitLab rejected the token for ${this.name} (401).${hint}`);
    if (res.status === 429) {
      const reset = Number(res.headers.get("ratelimit-reset"));
      throw new VaultError(`GitLab rate limit reached for ${this.name}${reset ? `; resets at ${new Date(reset * 1000).toISOString()}` : ""}`);
    }
    if (res.status === 403) throw new VaultError(`GitLab denied ${method} ${path} on ${this.name} (403): the token needs the api scope and Developer access or better.${hint} ${message}`);
    if (res.status === 404 && method === "GET" && path === "") throw new VaultError(`GitLab can't find ${this.name} (404): check the name, and that the token can see this project`);
    throw new HttpError(res.status, `GitLab ${method} ${path} on ${this.name} failed (${res.status}): ${message}`);
  }
}

/** An empty project has no snapshot: writing to it starts from nothing. */
const emptyAsNothing = (err: unknown): undefined => {
  if (err instanceof EmptyRepositoryError) return undefined;
  throw err;
};
