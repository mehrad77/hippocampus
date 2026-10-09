import { gitBlobSha } from "./blob-cache.ts";

interface FakeFile {
  sha: string;
  mode: string;
}

interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author?: { name: string; email: string };
}

const sha1 = async (s: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const encoder = new TextEncoder();

function tarHeader(name: string, size: number, type: string): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, at: number) => h.set(encoder.encode(s), at);
  put(name.slice(0, 99), 0);
  put("0000644\0", 100);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put(type, 156);
  put("ustar\0" + "00", 257);
  const sum = h.reduce((a, b) => a + b, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

const pad = (n: number) => new Uint8Array((512 - (n % 512)) % 512);

/** A gzipped tarball shaped like GitHub's: one top-level directory, pax headers for long paths. */
async function tarball(root: string, files: [string, string][]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const [path, content] of files) {
    const name = `${root}/${path}`;
    if (name.length > 99) {
      const record = (len: number) => `${len} path=${name}\n`;
      let len = record(0).length;
      while (record(len).length !== len) len = record(len).length;
      const pax = encoder.encode(record(len));
      parts.push(tarHeader("pax_header", pax.length, "x"), pax, pad(pax.length));
    }
    const body = encoder.encode(content);
    parts.push(tarHeader(name, body.length, "0"), body, pad(body.length));
  }
  parts.push(new Uint8Array(1024));
  const stream = new Blob(parts as Uint8Array<ArrayBuffer>[]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * In-memory stand-in for the slice of the GitHub Git Data API that `GitHubStore` uses.
 * Trees are flat path maps; subtrees for level-by-level walks are addressed as `<tree>:<dir>`.
 */
export class FakeGitHub {
  readonly blobs = new Map<string, string>();
  readonly trees = new Map<string, Map<string, FakeFile>>();
  readonly commits = new Map<string, FakeCommit>();
  readonly refs = new Map<string, string>();
  /** Every request as `METHOD path`, for asserting on API usage. */
  readonly calls: string[] = [];
  /** Report recursive listings as truncated, like GitHub does for huge repos. */
  truncate = false;
  /** Runs before the ref update is applied, e.g. to simulate a concurrent push. */
  beforeRefUpdate?: () => Promise<void>;

  private constructor(readonly repo: string) {}

  static async create(files: Record<string, string>, opts: { repo?: string; branch?: string } = {}): Promise<FakeGitHub> {
    const gh = new FakeGitHub(opts.repo ?? "player/vault");
    const tree = await gh.putTree(new Map(), Object.entries(files));
    const commit = await gh.putCommit({ tree, parents: [], message: "init" });
    gh.refs.set(opts.branch ?? "main", commit);
    return gh;
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? "GET";
    const prefix = `/repos/${this.repo}/`;
    if (!url.pathname.startsWith(prefix)) return json(404, { message: "Not Found" });
    const path = url.pathname.slice(prefix.length);
    this.calls.push(`${method} ${path}`);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    let m: RegExpMatchArray | null;

    if (method === "GET" && (m = path.match(/^git\/ref\/heads\/(.+)$/))) {
      const sha = this.refs.get(m[1]!);
      return sha ? json(200, { object: { sha, type: "commit" } }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = path.match(/^git\/commits\/(\w+)$/))) {
      const c = this.commits.get(m[1]!);
      return c ? json(200, { sha: c.sha, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = path.match(/^git\/trees\/([\w:/.-]+)$/))) return this.getTree(m[1]!, url.searchParams.has("recursive"));
    if (method === "GET" && (m = path.match(/^git\/blobs\/(\w+)$/))) {
      const content = this.blobs.get(m[1]!);
      return content === undefined ? json(404, { message: "Not Found" }) : new Response(content);
    }
    if (method === "GET" && (m = path.match(/^tarball\/(\w+)$/))) {
      const c = this.commits.get(m[1]!);
      if (!c) return json(404, { message: "Not Found" });
      const files = [...this.trees.get(c.tree)!].map(([p, f]): [string, string] => [p, this.blobs.get(f.sha)!]);
      return new Response(await tarball(`${this.repo.replace("/", "-")}-${c.sha.slice(0, 7)}`, files) as Uint8Array<ArrayBuffer>);
    }
    if (method === "POST" && path === "git/trees") {
      const base = this.trees.get(String(body.base_tree));
      if (!base) return json(422, { message: "base_tree not found" });
      const files = new Map(base);
      for (const e of body.tree as { path: string; mode: string; content?: string; sha?: string | null }[]) {
        if (e.sha === null) {
          if (!files.delete(e.path)) return json(422, { message: `GitRPC::BadObjectState: ${e.path} not in tree` });
        } else {
          const sha = await gitBlobSha(e.content ?? "");
          this.blobs.set(sha, e.content ?? "");
          files.set(e.path, { sha, mode: e.mode });
        }
      }
      return json(201, { sha: await this.storeTree(files), truncated: false });
    }
    if (method === "POST" && path === "git/commits") {
      const sha = await this.putCommit({ tree: String(body.tree), parents: body.parents as string[], message: String(body.message), author: body.author as FakeCommit["author"] });
      return json(201, { sha });
    }
    if (method === "PATCH" && (m = path.match(/^git\/refs\/heads\/(.+)$/))) {
      await this.beforeRefUpdate?.();
      const current = this.refs.get(m[1]!);
      const next = String(body.sha);
      if (!body.force && current && !this.isAncestor(current, next)) return json(422, { message: "Update is not a fast forward" });
      this.refs.set(m[1]!, next);
      return json(200, { object: { sha: next } });
    }
    return json(404, { message: `fake: unhandled ${method} ${path}` });
  };

  /** Files on a branch, as path → content. */
  files(branch = "main"): Record<string, string> {
    const commit = this.commits.get(this.refs.get(branch)!)!;
    return Object.fromEntries([...this.trees.get(commit.tree)!].map(([p, f]) => [p, this.blobs.get(f.sha)!]));
  }

  /** Commits on a branch, newest first. */
  log(branch = "main"): FakeCommit[] {
    const out: FakeCommit[] = [];
    for (let c = this.commits.get(this.refs.get(branch)!); c; c = this.commits.get(c.parents[0] ?? "")) out.push(c);
    return out;
  }

  /** Someone else pushes (e.g. the human from Obsidian). `null` removes a file. */
  async push(changes: Record<string, string | null>, branch = "main"): Promise<void> {
    const head = this.commits.get(this.refs.get(branch)!)!;
    const files = new Map(this.trees.get(head.tree)!);
    for (const [p, content] of Object.entries(changes)) if (content === null) files.delete(p);
    const tree = await this.putTree(
      files,
      Object.entries(changes).filter((e): e is [string, string] => e[1] !== null),
    );
    this.refs.set(branch, await this.putCommit({ tree, parents: [head.sha], message: "human edit" }));
  }

  private async putTree(base: Map<string, FakeFile>, files: [string, string][]): Promise<string> {
    const next = new Map(base);
    for (const [p, content] of files) {
      const sha = await gitBlobSha(content);
      this.blobs.set(sha, content);
      next.set(p, { sha, mode: "100644" });
    }
    return this.storeTree(next);
  }

  private async storeTree(files: Map<string, FakeFile>): Promise<string> {
    const sha = await sha1(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b))));
    this.trees.set(sha, files);
    return sha;
  }

  private async putCommit(c: Omit<FakeCommit, "sha">): Promise<string> {
    const sha = await sha1(JSON.stringify([c.tree, c.parents, c.message, this.commits.size]));
    this.commits.set(sha, { ...c, sha });
    return sha;
  }

  private isAncestor(ancestor: string, of: string): boolean {
    const queue = [of];
    while (queue.length) {
      const sha = queue.shift()!;
      if (sha === ancestor) return true;
      queue.push(...(this.commits.get(sha)?.parents ?? []));
    }
    return false;
  }

  private getTree(id: string, recursive: boolean): Response {
    const [root, dir = ""] = id.split(/:(.*)/s) as [string, string?];
    const files = this.trees.get(root);
    if (!files) return json(404, { message: "Not Found" });
    if (recursive && !dir) {
      if (this.truncate) return json(200, { sha: root, tree: [], truncated: true });
      return json(200, { sha: root, tree: [...files].map(([path, f]) => ({ path, mode: f.mode, type: "blob", sha: f.sha })), truncated: false });
    }
    const prefix = dir ? `${dir}/` : "";
    const entries = new Map<string, { path: string; mode: string; type: string; sha: string }>();
    for (const [path, f] of files) {
      if (!path.startsWith(prefix)) continue;
      const [head, ...rest] = path.slice(prefix.length).split("/");
      if (rest.length) entries.set(head!, { path: head!, mode: "040000", type: "tree", sha: `${root}:${prefix}${head}` });
      else entries.set(head!, { path: head!, mode: f.mode, type: "blob", sha: f.sha });
    }
    return json(200, { sha: id, tree: [...entries.values()], truncated: false });
  }
}
