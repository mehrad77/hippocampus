import { gitBlobSha } from "@hippocampus/store-git";
import { tarball } from "@hippocampus/store-git/testing";

export interface FakeProjectOptions {
  /** `group/name` (or `user/name`). */
  fullName: string;
  id?: number;
  visibility?: "private" | "internal" | "public";
  /** No commits at all, like a project created without a README. */
  empty?: boolean;
  files?: Record<string, string>;
  defaultBranch?: string;
  namespace?: { id: number; kind: "user" | "group" };
}

interface Commit {
  id: string;
  parent?: string;
  files: Map<string, string>;
  message: string;
  author?: { name: string; email: string };
}

const sha1 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

class FakeProject {
  readonly commits = new Map<string, Commit>();
  readonly branches = new Map<string, string>();
  readonly calls: string[] = [];
  private counter = 0;

  constructor(
    readonly id: number,
    readonly fullName: string,
    public visibility: "private" | "internal" | "public",
    readonly defaultBranch: string,
    readonly namespace: { id: number; kind: "user" | "group" },
  ) {}

  get empty(): boolean {
    return this.branches.size === 0;
  }

  async commit(branch: string, changes: Record<string, string | null>, message = "fake commit", author?: Commit["author"]): Promise<string> {
    const parent = this.branches.get(branch);
    const files = new Map(parent ? this.commits.get(parent)!.files : undefined);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    const id = await sha1(`${this.id}:${++this.counter}:${parent ?? ""}:${JSON.stringify([...files])}`);
    this.commits.set(id, { id, parent, files, message, author });
    this.branches.set(branch, id);
    return id;
  }

  head(branch: string): Commit | undefined {
    const id = this.branches.get(branch);
    return id ? this.commits.get(id) : undefined;
  }
}

/** An in-memory GitLab project API (just enough for `GitLabStore`), behind a `fetch`. */
export class FakeGitLab {
  readonly projects = new Map<number, FakeProject>();
  /** Every request, as `METHOD path` relative to the project. */
  readonly calls: string[] = [];
  /** Tokens that work; any bearer works when empty. */
  readonly tokens = new Set<string>();
  /** Smaller pages than the client asks for, to exercise pagination. */
  pageSize = 100;
  /** Runs before a commit is applied: a place to simulate someone else pushing first. */
  beforeCommit?: (project: FakeProject) => Promise<void>;
  repo!: FakeProject;
  private nextId = 100;

  static async create(files: Record<string, string> = {}, opts: Partial<FakeProjectOptions> = {}): Promise<FakeGitLab> {
    const gl = new FakeGitLab();
    gl.repo = await gl.addProject({ fullName: "player/example-relocation", files, ...opts });
    return gl;
  }

  async addProject(o: FakeProjectOptions): Promise<FakeProject> {
    const branch = o.defaultBranch ?? "main";
    const p = new FakeProject(o.id ?? this.nextId++, o.fullName, o.visibility ?? "private", branch, o.namespace ?? { id: 7, kind: "user" });
    if (!o.empty) await p.commit(branch, o.files ?? {}, "init");
    this.projects.set(p.id, p);
    return p;
  }

  /** A push by someone else, for conflict tests. */
  async push(changes: Record<string, string | null>, branch = "main"): Promise<void> {
    await this.repo.commit(branch, changes, "human edit");
  }

  files(branch = "main"): Record<string, string> {
    return Object.fromEntries(this.repo.head(branch)?.files ?? []);
  }

  log(branch = "main"): { id: string; message: string; author?: { name: string; email: string } }[] {
    const out = [];
    for (let c = this.repo.head(branch); c; c = c.parent ? this.repo.commits.get(c.parent) : undefined) out.push({ id: c.id, message: c.message, author: c.author });
    return out;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const text = method === "GET" ? "" : await req.text();
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const bearer = req.headers.get("authorization")?.replace(/^bearer\s+/i, "") || undefined;

    const m = url.pathname.match(/^\/api\/v4\/projects\/([^/]+)(?:\/(.*))?$/);
    if (!m) return json(404, { message: "404 Not Found" });
    const path = m[2] ?? "";
    this.calls.push(`${method} ${path}`);
    if (!bearer || (this.tokens.size && !this.tokens.has(bearer))) return json(401, { message: "401 Unauthorized" });
    const key = decodeURIComponent(m[1]!);
    const project = /^\d+$/.test(key) ? this.projects.get(Number(key)) : [...this.projects.values()].find((p) => p.fullName.toLowerCase() === key.toLowerCase());
    if (!project) return json(404, { message: "404 Project Not Found" });
    project.calls.push(`${method} ${path}`);
    return this.route(project, method, path, url, body);
  };

  private async route(p: FakeProject, method: string, path: string, url: URL, body: Record<string, unknown>): Promise<Response> {
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "")
      return json(200, { id: p.id, path_with_namespace: p.fullName, visibility: p.visibility, default_branch: p.empty ? null : p.defaultBranch, empty_repo: p.empty, namespace: p.namespace });
    if (method === "GET" && (m = path.match(/^repository\/branches\/(.+)$/))) {
      const head = p.branches.get(decodeURIComponent(m[1]!));
      return head ? json(200, { name: decodeURIComponent(m[1]!), commit: { id: head } }) : json(404, { message: "404 Branch Not Found" });
    }
    if (method === "GET" && path === "repository/tree") return this.tree(p, url);
    if (method === "GET" && (m = path.match(/^repository\/blobs\/(\w+)\/raw$/))) {
      for (const c of p.commits.values())
        for (const content of c.files.values()) if ((await gitBlobSha(content)) === m[1]) return new Response(content);
      return json(404, { message: "404 Not Found" });
    }
    if (method === "GET" && path === "repository/archive.tar.gz") {
      const c = p.commits.get(url.searchParams.get("sha") ?? "");
      if (!c) return json(404, { message: "404 Commit Not Found" });
      const root = `${p.fullName.split("/").pop()}-${c.id}-${c.id}`;
      return new Response((await tarball(root, [...c.files])) as Uint8Array<ArrayBuffer>);
    }
    if (method === "POST" && path === "repository/commits") return this.createCommit(p, body);
    return json(404, { message: "404 Not Found" });
  }

  private async tree(p: FakeProject, url: URL): Promise<Response> {
    const c = p.commits.get(url.searchParams.get("ref") ?? "");
    if (!c) return json(404, { message: "404 Tree Not Found" });
    const entries: { id: string; name: string; type: "blob" | "tree"; path: string; mode: string }[] = [];
    const dirs = new Set<string>();
    for (const [path, content] of [...c.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!dirs.has(dir)) {
          dirs.add(dir);
          entries.push({ id: await sha1(`tree:${dir}`), name: parts[i - 1]!, type: "tree", path: dir, mode: "040000" });
        }
      }
      entries.push({ id: await gitBlobSha(content), name: parts.at(-1)!, type: "blob", path, mode: "100644" });
    }
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 20), this.pageSize);
    const page = Number(url.searchParams.get("page") ?? 1);
    const slice = entries.slice((page - 1) * per, page * per);
    return json(200, slice, { "x-next-page": page * per < entries.length ? String(page + 1) : "" });
  }

  private async createCommit(p: FakeProject, body: Record<string, unknown>): Promise<Response> {
    await this.beforeCommit?.(p);
    const branch = String(body.branch);
    const head = p.head(branch);
    const changes: Record<string, string | null> = {};
    for (const a of body.actions as { action: string; file_path: string; content?: string }[]) {
      const exists = head?.files.has(a.file_path) ?? false;
      if (a.action === "create" && exists) return json(400, { message: `A file with this name already exists: ${a.file_path}` });
      if ((a.action === "update" || a.action === "delete") && !exists) return json(400, { message: `A file with this name doesn't exist: ${a.file_path}` });
      changes[a.file_path] = a.action === "delete" ? null : (a.content ?? "");
    }
    const author = body.author_email ? { name: String(body.author_name), email: String(body.author_email) } : undefined;
    return json(201, { id: await p.commit(branch, changes, String(body.commit_message), author) });
  }
}
