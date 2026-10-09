import { gitBlobSha } from "./blob-cache.ts";

interface FakeFile {
  sha: string;
  mode: string;
}

export interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author?: { name: string; email: string };
}

type Access = "read" | "write";
export type FakePermissions = Record<string, Access>;

export interface FakeToken {
  /** Repos (`owner/name`) it reaches; every repo when omitted. */
  repos?: string[];
  /** Like `{ contents: "write" }`; anything when omitted. */
  permissions?: FakePermissions;
  /** The signed-in user's login, for user tokens (`GET /user`, `/user/installations`). */
  user?: string;
  /** The installation that minted it: it stops working when that's uninstalled. */
  installation?: number;
  expiresAt?: Date;
}

export interface FakeInstallation {
  id: number;
  account: { id: number; login: string; type: "User" | "Organization" };
  /** Repos it was granted, as `owner/name`. */
  repos: string[];
  /** What the app may do there. Tokens can narrow it, never widen it. */
  permissions: FakePermissions;
}

export interface FakeUser {
  id: number;
  login: string;
  /** Installations the user sees besides the one on their own account, e.g. an organization's. */
  installations: number[];
}

export interface FakeRepoOptions {
  fullName: string;
  id?: number;
  private?: boolean;
  /** No commits at all, like a repo created without a README. */
  empty?: boolean;
  files?: Record<string, string>;
  defaultBranch?: string;
}

const sha1 = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s))));
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

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
const notFound = () => json(404, { message: "Not Found" });
const badCredentials = () => json(401, { message: "Bad credentials" });
const allows = (granted: Access | undefined, wanted: Access) => granted === "write" || granted === wanted;
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isWorkflow = (path: string) => path.startsWith(".github/workflows/");

const base64Decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

/** Git objects, content-addressed and shared by every repo (they never collide). */
class GitObjects {
  readonly blobs = new Map<string, string>();
  readonly trees = new Map<string, Map<string, FakeFile>>();
  readonly commits = new Map<string, FakeCommit>();

  async putBlob(content: string): Promise<string> {
    const sha = await gitBlobSha(content);
    this.blobs.set(sha, content);
    return sha;
  }

  async putTree(base: Map<string, FakeFile>, files: [string, string][]): Promise<string> {
    const next = new Map(base);
    for (const [p, content] of files) next.set(p, { sha: await this.putBlob(content), mode: "100644" });
    return this.storeTree(next);
  }

  async storeTree(files: Map<string, FakeFile>): Promise<string> {
    const sha = await sha1(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b))));
    this.trees.set(sha, files);
    return sha;
  }

  async putCommit(c: Omit<FakeCommit, "sha">): Promise<string> {
    const sha = await sha1(JSON.stringify([c.tree, c.parents, c.message, this.commits.size]));
    this.commits.set(sha, { ...c, sha });
    return sha;
  }

  isAncestor(ancestor: string, of: string): boolean {
    const queue = [of];
    while (queue.length) {
      const sha = queue.shift()!;
      if (sha === ancestor) return true;
      queue.push(...(this.commits.get(sha)?.parents ?? []));
    }
    return false;
  }
}

/** One repository: its branches and settings. Its git objects live in the shared store. */
export class FakeRepo {
  readonly refs = new Map<string, string>();
  /** Requests to this repo, as `METHOD path` relative to it. */
  readonly calls: string[] = [];

  constructor(
    private readonly objects: GitObjects,
    readonly fullName: string,
    readonly id: number,
    public isPrivate: boolean,
    public defaultBranch: string,
  ) {}

  /** No commits yet: GitHub's Git Data API refuses the repo until the Contents API makes one. */
  get empty(): boolean {
    return this.refs.size === 0;
  }

  /** Files on a branch, as path → content. */
  files(branch = this.defaultBranch): Record<string, string> {
    return Object.fromEntries([...this.tree(branch)].map(([p, f]) => [p, this.objects.blobs.get(f.sha)!]));
  }

  /** Commits on a branch, newest first. */
  log(branch = this.defaultBranch): FakeCommit[] {
    const out: FakeCommit[] = [];
    for (let c = this.objects.commits.get(this.refs.get(branch)!); c; c = this.objects.commits.get(c.parents[0] ?? "")) out.push(c);
    return out;
  }

  /** Someone else pushes (e.g. the human from Obsidian). `null` removes a file. */
  async push(changes: Record<string, string | null>, branch = this.defaultBranch, message = "human edit"): Promise<string> {
    const files = new Map(this.refs.has(branch) ? this.tree(branch) : []);
    for (const [p, content] of Object.entries(changes)) if (content === null) files.delete(p);
    const tree = await this.objects.putTree(
      files,
      Object.entries(changes).filter((e): e is [string, string] => e[1] !== null),
    );
    return this.commit(branch, tree, message);
  }

  /** A commit on top of `branch` (a root commit when there's none), and the branch moved to it. */
  async commit(branch: string, tree: string, message: string, author?: FakeCommit["author"]): Promise<string> {
    const head = this.refs.get(branch);
    const sha = await this.objects.putCommit({ tree, parents: head ? [head] : [], message, ...(author ? { author } : {}) });
    this.refs.set(branch, sha);
    return sha;
  }

  tree(branch = this.defaultBranch): Map<string, FakeFile> {
    return this.objects.trees.get(this.objects.commits.get(this.refs.get(branch)!)!.tree)!;
  }

  /** What `GET /repos/{owner}/{repo}` reports. */
  json() {
    const [owner, name] = this.fullName.split("/");
    let bytes = 0;
    if (this.refs.has(this.defaultBranch)) for (const f of this.tree().values()) bytes += this.objects.blobs.get(f.sha)!.length;
    // `size` is in KiB, and 0 for a repo without commits.
    const size = this.empty ? 0 : Math.max(1, Math.ceil(bytes / 1024));
    return { id: this.id, name, full_name: this.fullName, owner: { login: owner }, private: this.isPrivate, default_branch: this.defaultBranch, size };
  }
}

/**
 * In-memory stand-in for the slices of the GitHub API that `GitHubStore` and the hosted app use:
 * the Git Data and Contents APIs over any number of repos, GitHub App installations and their
 * tokens, and the signed-in user's installations. Trees are flat path maps; subtrees for
 * level-by-level walks are addressed as `<tree>:<dir>`.
 *
 * Auth is opt-in (`requireAuth`), so tests that don't care needn't mint tokens. The single-repo
 * API (`repo`, `refs`, `files()`, `push()`…) is the repo `create()` made.
 */
export class FakeGitHub {
  private readonly objects = new GitObjects();
  readonly blobs = this.objects.blobs;
  readonly trees = this.objects.trees;
  readonly commits = this.objects.commits;
  /** By lowercased `owner/name`: GitHub ignores case in repo names. */
  readonly repos = new Map<string, FakeRepo>();
  readonly installations = new Map<number, FakeInstallation>();
  /** By login. */
  readonly users = new Map<string, FakeUser>();
  readonly tokens = new Map<string, FakeToken>();
  /** Every request as `METHOD path`: relative to the repo for repo endpoints (`GET ` is the repo itself), else absolute. */
  readonly calls: string[] = [];
  /** Answer 401 to repo requests without a known, unexpired token. */
  requireAuth = false;
  /** Checks the app's JWT on `/app/*`. Unset, any bearer passes. */
  verifyAppJwt?: (jwt: string) => boolean | Promise<boolean>;
  /** The clock tokens expire by. */
  now = () => new Date();
  /** Report recursive listings as truncated, like GitHub does for huge repos. */
  truncate = false;
  /** Runs before a ref update is applied, e.g. to simulate a concurrent push. */
  beforeRefUpdate?: () => Promise<void>;
  private nextId = 1000;
  private minted = 0;

  private constructor(readonly repo: string) {}

  static async create(files: Record<string, string> = {}, opts: { repo?: string; branch?: string; empty?: boolean; id?: number; private?: boolean } = {}): Promise<FakeGitHub> {
    const gh = new FakeGitHub(opts.repo ?? "player/vault");
    await gh.addRepo({ fullName: gh.repo, files, defaultBranch: opts.branch, empty: opts.empty, id: opts.id, private: opts.private });
    return gh;
  }

  async addRepo(opts: FakeRepoOptions): Promise<FakeRepo> {
    const repo = new FakeRepo(this.objects, opts.fullName, opts.id ?? this.nextId++, opts.private ?? true, opts.defaultBranch ?? "main");
    if (!opts.empty) await repo.commit(repo.defaultBranch, await this.objects.putTree(new Map(), Object.entries(opts.files ?? {})), "init");
    this.repos.set(opts.fullName.toLowerCase(), repo);
    return repo;
  }

  /** A repo by `owner/name`. */
  at(fullName: string): FakeRepo {
    const repo = this.repos.get(fullName.toLowerCase());
    if (!repo) throw new Error(`fake: no repo ${fullName}`);
    return repo;
  }

  addInstallation(opts: Omit<FakeInstallation, "id" | "permissions"> & { id?: number; permissions?: FakePermissions }): FakeInstallation {
    const installation: FakeInstallation = { ...opts, id: opts.id ?? this.nextId++, permissions: opts.permissions ?? { metadata: "read", contents: "write", workflows: "write" } };
    this.installations.set(installation.id, installation);
    return installation;
  }

  /** A GitHub user, signed in with `token` when given. */
  addUser(opts: { login: string; id?: number; token?: string; installations?: number[] }): FakeUser {
    const user = { id: opts.id ?? this.nextId++, login: opts.login, installations: opts.installations ?? [] };
    this.users.set(user.login, user);
    if (opts.token) this.tokens.set(opts.token, { user: user.login });
    return user;
  }

  // The single-repo API, on the repo `create()` made.
  get refs(): Map<string, string> {
    return this.at(this.repo).refs;
  }
  get isPrivate(): boolean {
    return this.at(this.repo).isPrivate;
  }
  set isPrivate(value: boolean) {
    this.at(this.repo).isPrivate = value;
  }
  get defaultBranch(): string {
    return this.at(this.repo).defaultBranch;
  }
  set defaultBranch(value: string) {
    this.at(this.repo).defaultBranch = value;
  }
  files(branch?: string): Record<string, string> {
    return this.at(this.repo).files(branch);
  }
  log(branch?: string): FakeCommit[] {
    return this.at(this.repo).log(branch);
  }
  async push(changes: Record<string, string | null>, branch?: string): Promise<void> {
    await this.at(this.repo).push(changes, branch);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const text = method === "GET" || method === "HEAD" ? "" : await req.text();
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const bearer = req.headers.get("authorization")?.replace(/^(bearer|token)\s+/i, "") || undefined;

    const r = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(?:\/(.*))?$/);
    if (r) {
      const path = r[2] ?? "";
      this.calls.push(`${method} ${path}`);
      const repo = this.repos.get(r[1]!.toLowerCase());
      if (!repo) return notFound();
      repo.calls.push(`${method} ${path}`);
      return (await this.authorize(bearer, repo, method, path, body)) ?? this.repoRoute(repo, method, path, url, body);
    }
    this.calls.push(`${method} ${url.pathname}`);
    return this.apiRoute(method, url.pathname, bearer, body);
  };

  /** The token behind a bearer, if it's still good. */
  token(bearer: string | undefined): FakeToken | undefined {
    const t = bearer === undefined ? undefined : this.tokens.get(bearer);
    if (!t || (t.expiresAt && t.expiresAt <= this.now())) return undefined;
    if (t.installation !== undefined && !this.installations.has(t.installation)) return undefined;
    return t;
  }

  private reaches(t: FakeToken, repo: string): boolean {
    const within = (list?: string[]) => !list || list.some((r) => sameRepo(r, repo));
    return within(t.repos) && within(t.installation === undefined ? undefined : this.installations.get(t.installation)?.repos);
  }

  private async authorize(bearer: string | undefined, repo: FakeRepo, method: string, path: string, body: Record<string, unknown>): Promise<Response | undefined> {
    if (!this.requireAuth) return undefined;
    const t = this.token(bearer);
    if (!t) return badCredentials();
    // GitHub hides repos a token can't reach rather than admitting they exist.
    if (!this.reaches(t, repo.fullName)) return notFound();
    if (!t.permissions || path === "") return undefined;
    const need: Access = method === "GET" ? "read" : "write";
    if (!allows(t.permissions.contents, need)) return json(403, { message: "Resource not accessible by integration" });
    const paths = path.startsWith("contents/") ? [decodeURIComponent(path.slice("contents/".length))] : path === "git/trees" ? ((body.tree as { path: string }[] | undefined) ?? []).map((e) => e.path) : [];
    if (need === "write" && paths.some(isWorkflow) && !allows(t.permissions.workflows, "write"))
      return json(403, { message: "refusing to allow a GitHub App to create or update workflow without `workflows` permission" });
    return undefined;
  }

  private async repoRoute(repo: FakeRepo, method: string, path: string, url: URL, body: Record<string, unknown>): Promise<Response> {
    const o = this.objects;
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "") return json(200, repo.json());
    if (method === "PUT" && (m = path.match(/^contents\/(.+)$/))) return this.putContents(repo, decodeURIComponent(m[1]!), body);
    if (repo.empty) return path.startsWith("git/") ? json(409, { message: "Git Repository is empty." }) : notFound();

    if (method === "GET" && (m = path.match(/^git\/ref\/heads\/(.+)$/))) {
      const sha = repo.refs.get(m[1]!);
      return sha ? json(200, { ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }) : notFound();
    }
    if (method === "GET" && (m = path.match(/^git\/commits\/(\w+)$/))) {
      const c = o.commits.get(m[1]!);
      return c ? json(200, { sha: c.sha, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }) : notFound();
    }
    if (method === "GET" && (m = path.match(/^git\/trees\/([\w:/.-]+)$/))) return this.getTree(m[1]!, url.searchParams.has("recursive"));
    if (method === "GET" && (m = path.match(/^git\/blobs\/(\w+)$/))) {
      const content = o.blobs.get(m[1]!);
      return content === undefined ? notFound() : new Response(content);
    }
    if (method === "GET" && (m = path.match(/^tarball\/(\w+)$/))) {
      const c = o.commits.get(m[1]!);
      if (!c) return notFound();
      const files = [...o.trees.get(c.tree)!].map(([p, f]): [string, string] => [p, o.blobs.get(f.sha)!]);
      return new Response((await tarball(`${repo.fullName.replace("/", "-")}-${c.sha.slice(0, 7)}`, files)) as Uint8Array<ArrayBuffer>);
    }
    if (method === "POST" && path === "git/trees") {
      const base = o.trees.get(String(body.base_tree));
      if (!base) return json(422, { message: "base_tree not found" });
      const files = new Map(base);
      for (const e of body.tree as { path: string; mode: string; content?: string; sha?: string | null }[]) {
        if (e.sha === null) {
          if (!files.delete(e.path)) return json(422, { message: `GitRPC::BadObjectState: ${e.path} not in tree` });
        } else files.set(e.path, { sha: await o.putBlob(e.content ?? ""), mode: e.mode });
      }
      return json(201, { sha: await o.storeTree(files), truncated: false });
    }
    if (method === "POST" && path === "git/commits") {
      const sha = await o.putCommit({ tree: String(body.tree), parents: body.parents as string[], message: String(body.message), author: body.author as FakeCommit["author"] });
      return json(201, { sha });
    }
    if (method === "POST" && path === "git/refs") {
      const ref = String(body.ref ?? "");
      if (!ref.startsWith("refs/heads/")) return json(422, { message: "fake: only refs/heads/* refs are supported" });
      const branch = ref.slice("refs/heads/".length);
      if (repo.refs.has(branch)) return json(422, { message: "Reference already exists" });
      if (!o.commits.has(String(body.sha))) return json(422, { message: "Object does not exist" });
      repo.refs.set(branch, String(body.sha));
      return json(201, { ref, object: { sha: body.sha, type: "commit" } });
    }
    if (method === "PATCH" && (m = path.match(/^git\/refs\/heads\/(.+)$/))) {
      await this.beforeRefUpdate?.();
      const current = repo.refs.get(m[1]!);
      const next = String(body.sha);
      if (!body.force && current && !o.isAncestor(current, next)) return json(422, { message: "Update is not a fast forward" });
      repo.refs.set(m[1]!, next);
      return json(200, { object: { sha: next } });
    }
    return json(404, { message: `fake: unhandled ${method} ${path}` });
  }

  /** `PUT contents/{path}`: one file, one commit. On an empty repo it makes the first commit. */
  private async putContents(repo: FakeRepo, path: string, body: Record<string, unknown>): Promise<Response> {
    if (typeof body.message !== "string" || typeof body.content !== "string") return json(422, { message: "Invalid request.\n\nmessage and content are required." });
    const branch = typeof body.branch === "string" ? body.branch : repo.defaultBranch;
    const wasEmpty = repo.empty;
    if (!wasEmpty && !repo.refs.has(branch)) return json(404, { message: `Branch ${branch} not found` });
    const files = new Map(wasEmpty ? [] : repo.tree(branch));
    const existing = files.get(path);
    if (existing && body.sha === undefined) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
    if (existing && body.sha !== existing.sha) return json(409, { message: `${path} does not match ${String(body.sha)}` });
    const content = base64Decode(body.content);
    const tree = await this.objects.putTree(files, [[path, content]]);
    const commit = await repo.commit(branch, tree, body.message, body.author as FakeCommit["author"]);
    // The first push to an empty repo decides its default branch.
    if (wasEmpty) repo.defaultBranch = branch;
    const blob = this.objects.trees.get(tree)!.get(path)!;
    return json(existing ? 200 : 201, { content: { name: path.split("/").pop(), path, sha: blob.sha, type: "file" }, commit: { sha: commit, tree: { sha: tree }, message: body.message } });
  }

  private async apiRoute(method: string, path: string, bearer: string | undefined, body: Record<string, unknown>): Promise<Response> {
    let m: RegExpMatchArray | null;

    if (method === "POST" && (m = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      const denied = await this.authorizeApp(bearer);
      if (denied) return denied;
      const installation = this.installations.get(Number(m[1]));
      if (!installation) return notFound();
      return this.mint(installation, body);
    }
    if (method === "DELETE" && (m = path.match(/^\/app\/installations\/(\d+)$/))) {
      const denied = await this.authorizeApp(bearer);
      if (denied) return denied;
      if (!this.installations.delete(Number(m[1]))) return notFound();
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && path === "/installation/repositories") {
      const t = this.token(bearer);
      if (t?.installation === undefined) return badCredentials();
      const repos = this.installations.get(t.installation)!.repos.filter((r) => this.reaches(t, r));
      return json(200, this.repoList(repos));
    }

    const user = (() => {
      const login = this.token(bearer)?.user;
      return login === undefined ? undefined : this.users.get(login);
    })();
    const visible = (i: FakeInstallation) => i.account.id === user?.id || !!user?.installations.includes(i.id);
    if (method === "GET" && path === "/user") return user ? json(200, { login: user.login, id: user.id, type: "User" }) : badCredentials();
    if (method === "GET" && path === "/user/installations") {
      if (!user) return badCredentials();
      const installations = [...this.installations.values()].filter(visible).map((i) => ({ id: i.id, account: i.account, repository_selection: "selected", permissions: i.permissions }));
      return json(200, { total_count: installations.length, installations });
    }
    if (method === "GET" && (m = path.match(/^\/user\/installations\/(\d+)\/repositories$/))) {
      if (!user) return badCredentials();
      const installation = this.installations.get(Number(m[1]));
      if (!installation || !visible(installation)) return notFound();
      return json(200, this.repoList(installation.repos));
    }
    return json(404, { message: `fake: unhandled ${method} ${path}` });
  }

  private async authorizeApp(bearer: string | undefined): Promise<Response | undefined> {
    if (!bearer || (this.verifyAppJwt && !(await this.verifyAppJwt(bearer)))) return json(401, { message: "A JSON web token could not be decoded" });
    return undefined;
  }

  /** An installation token, narrowed to the requested repos and permissions. */
  private mint(installation: FakeInstallation, body: Record<string, unknown>): Response {
    const ids = body.repository_ids as number[] | undefined;
    const names = body.repositories as string[] | undefined;
    let repos = installation.repos;
    if (ids || names) {
      const byId = (id: number) => [...this.repos.values()].find((r) => r.id === id)?.fullName;
      const wanted = [...(ids ?? []).map(byId), ...(names ?? []).map((n) => `${installation.account.login}/${n}`)];
      if (wanted.some((r) => r === undefined || !installation.repos.some((x) => sameRepo(x, r))))
        return json(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      repos = wanted as string[];
    }
    const asked = body.permissions as FakePermissions | undefined;
    if (asked && Object.entries(asked).some(([k, v]) => !allows(installation.permissions[k], v))) return json(422, { message: "The permissions requested are not granted to this installation." });
    const permissions = asked ?? installation.permissions;
    const token = `ghs_fake${String(++this.minted).padStart(4, "0")}`;
    const expiresAt = new Date(this.now().getTime() + 60 * 60 * 1000);
    this.tokens.set(token, { installation: installation.id, repos, permissions, expiresAt });
    return json(201, {
      token,
      expires_at: expiresAt.toISOString(),
      permissions,
      repository_selection: "selected",
      ...(ids || names ? { repositories: repos.map((r) => this.at(r).json()) } : {}),
    });
  }

  private repoList(repos: string[]) {
    const repositories = repos.flatMap((r) => this.repos.get(r.toLowerCase())?.json() ?? []);
    return { total_count: repositories.length, repository_selection: "selected", repositories };
  }

  private getTree(id: string, recursive: boolean): Response {
    const [root, dir = ""] = id.split(/:(.*)/s) as [string, string?];
    const files = this.objects.trees.get(root);
    if (!files) return notFound();
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

/** The `X-Hub-Signature-256` header GitHub sends with a webhook `body` signed with `secret`. */
export async function signWebhook(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))))}`;
}
