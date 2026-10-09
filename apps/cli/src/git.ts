import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { ACTOR_TRAILER, VaultError, type VaultStore } from "@hippocampus/core";
import { CURATOR_AUTHOR } from "@hippocampus/curator";

const exec = promisify(execFile);

export interface GitState {
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Changed, staged and untracked files. */
  dirty: number;
}

/** One commit to audit: its parents and the `Hippo-Actor` trailer values it carries. */
export interface CommitInfo {
  sha: string;
  parents: string[];
  actors: string[];
}

/** A path a commit changed, from `git diff-tree`: added, modified (or retyped) or deleted. */
export interface ChangedPath {
  status: "A" | "M" | "D";
  path: string;
}

export interface Remote {
  name: string;
  host: string;
  /** e.g. `owner/repo`, without `.git`. */
  path: string;
}

/**
 * Host and path of a remote URL, never its credentials: https://user:token@host/path,
 * ssh://git@host:22/path and scp-style git@host:path all come out as { host, path }.
 */
export function parseRemoteUrl(url: string): { host: string; path: string } | undefined {
  const clean = (p: string) => p.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return u.hostname ? { host: u.hostname, path: clean(decodeURIComponent(u.pathname)) } : undefined;
    } catch {
      return undefined;
    }
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
  if (scp) return { host: scp[1]!, path: clean(scp[2]!) };
  return undefined;
}

let gh: Promise<boolean> | undefined;
/** Whether the GitHub CLI is installed (the wizard can then suggest `gh repo create`). */
export function ghAvailable(): Promise<boolean> {
  return (gh ??= exec("gh", ["--version"], { timeout: 5000 }).then(
    () => true,
    () => false,
  ));
}

export class Git {
  constructor(readonly dir: string) {}

  async run(...args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, { cwd: this.dir, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  }

  isRepo(): boolean {
    return existsSync(join(this.dir, ".git"));
  }

  async hasRemote(): Promise<boolean> {
    return (await this.run("remote")).length > 0;
  }

  async hasUpstream(): Promise<boolean> {
    try {
      await this.run("rev-parse", "--abbrev-ref", "@{u}");
      return true;
    } catch {
      return false;
    }
  }

  async pull(): Promise<void> {
    await this.run("pull", "--rebase", "--autostash");
  }

  /** Stage exactly these paths (additions, edits, and deletions), leaving the human's other edits alone. */
  async stage(paths: string[]): Promise<void> {
    const present = paths.filter((p) => existsSync(join(this.dir, p)));
    const gone = paths.filter((p) => !existsSync(join(this.dir, p)));
    for (let i = 0; i < present.length; i += 200) await this.run("add", "--", ...present.slice(i, i + 200));
    for (const p of gone) {
      if (await this.run("ls-files", "--", p)) await this.run("rm", "--cached", "--quiet", "--", p);
    }
  }

  async hasStaged(): Promise<boolean> {
    try {
      await this.run("diff", "--cached", "--quiet");
      return false;
    } catch {
      return true;
    }
  }

  async commit(message: string): Promise<void> {
    await this.run("-c", `user.name=${CURATOR_AUTHOR.name}`, "-c", `user.email=${CURATOR_AUTHOR.email}`, "commit", "--quiet", "-m", message);
  }

  async push(): Promise<void> {
    await this.run("push", "--quiet");
  }

  /** Branch, distance from upstream and the number of uncommitted files. Read-only. */
  async status(): Promise<GitState> {
    const out = await this.run("status", "--porcelain=v2", "--branch");
    const state: GitState = { dirty: 0 };
    for (const line of out.split("\n")) {
      if (!line) continue;
      if (!line.startsWith("# ")) {
        state.dirty++;
        continue;
      }
      const [key, ...rest] = line.slice(2).split(" ");
      if (key === "branch.head" && rest[0] !== "(detached)") state.branch = rest[0];
      else if (key === "branch.upstream") state.upstream = rest[0];
      else if (key === "branch.ab") {
        state.ahead = Math.abs(Number(rest[0]));
        state.behind = Math.abs(Number(rest[1]));
      }
    }
    return state;
  }

  /**
   * Commits in `range` (default `HEAD`), oldest first, optionally only those committed `since` (any
   * date git understands, e.g. "26 hours ago").
   */
  async commits(opts: { range?: string; since?: string } = {}): Promise<CommitInfo[]> {
    // \x1f between fields (trailer values included), \x1e after each commit.
    const args = ["log", "--reverse", `--format=%H%x1f%P%x1f%(trailers:key=${ACTOR_TRAILER},valueonly,separator=%x1f)%x1e`];
    if (opts.since) args.push(`--since=${opts.since}`);
    args.push(opts.range ?? "HEAD", "--");
    return (await this.run(...args))
      .split("\x1e")
      .map((r) => r.replace(/^\n/, ""))
      .filter(Boolean)
      .map((r) => {
        const [sha = "", parents = "", ...actors] = r.split("\x1f");
        return { sha, parents: parents.split(" ").filter(Boolean), actors: actors.map((a) => a.trim()).filter(Boolean) };
      });
  }

  /** What `commit` changed against `parent`, or against nothing for a root commit. */
  async changedPaths(commit: string, parent?: string): Promise<ChangedPath[]> {
    const args = ["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--name-status", ...(parent ? [parent, commit] : ["--root", commit])];
    const parts = (await this.run(...args)).split("\0").filter(Boolean);
    const out: ChangedPath[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i]![0];
      out.push({ status: code === "A" ? "A" : code === "D" ? "D" : "M", path: parts[i + 1]! });
    }
    return out;
  }

  /** The `origin` remote (or the first one), as host and path only. */
  async remoteInfo(): Promise<Remote | undefined> {
    const names = (await this.run("remote")).split("\n").filter(Boolean);
    const name = names.includes("origin") ? "origin" : names[0];
    if (!name) return undefined;
    const parsed = parseRemoteUrl(await this.run("remote", "get-url", name));
    return parsed && { name, ...parsed };
  }
}

interface Pending {
  resolve: (content: string | undefined) => void;
  reject: (err: Error) => void;
}

/**
 * One long-lived `git cat-file --batch`: an audit reads thousands of blobs, and a process per read
 * would dominate its run time. Requests are answered in order.
 */
export class CatFile {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly queue: Pending[] = [];
  private buf = Buffer.alloc(0);
  private failed?: Error;

  constructor(dir: string) {
    this.proc = spawn("git", ["cat-file", "--batch"], { cwd: dir });
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    const fail = (err: Error) => {
      this.failed = err;
      for (const p of this.queue.splice(0)) p.reject(err);
    };
    this.proc.on("error", fail);
    this.proc.on("exit", (code) => {
      if (code) fail(new Error(`git cat-file exited with ${code}`));
    });
  }

  /** A blob's text by object name (e.g. `<rev>:<path>`), or undefined if there's no such blob. */
  read(object: string): Promise<string | undefined> {
    if (this.failed) return Promise.reject(this.failed);
    if (/[\n\r]/.test(object)) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc.stdin.write(`${object}\n`);
    });
  }

  close(): void {
    this.proc.stdin.end();
  }

  private drain(): void {
    for (;;) {
      const head = this.queue[0];
      const eol = this.buf.indexOf(10);
      if (!head || eol < 0) return;
      const header = this.buf.subarray(0, eol).toString("utf8");
      const m = /^\S+ (\S+) (\d+)$/.exec(header);
      if (!m) {
        // "<object> missing" or "<object> ambiguous"
        this.buf = this.buf.subarray(eol + 1);
        this.queue.shift();
        head.resolve(undefined);
        continue;
      }
      const size = Number(m[2]);
      if (this.buf.length < eol + 1 + size + 1) return;
      const body = this.buf.subarray(eol + 1, eol + 1 + size);
      this.buf = this.buf.subarray(eol + 1 + size + 1);
      this.queue.shift();
      head.resolve(m[1] === "blob" ? body.toString("utf8") : undefined);
    }
  }
}

/**
 * The vault as of one git revision, read-only, without a checkout: `hippo audit` reads each commit
 * and its parent through it. Pass a shared `CatFile` to read many revisions through one process.
 */
export class GitTreeStore implements VaultStore {
  private paths?: Promise<string[]>;
  private readonly cat: CatFile;
  private readonly ownsCat: boolean;

  constructor(
    readonly dir: string,
    readonly rev: string,
    opts: { cat?: CatFile } = {},
  ) {
    this.cat = opts.cat ?? new CatFile(dir);
    this.ownsCat = !opts.cat;
  }

  async list(prefix = ""): Promise<string[]> {
    const dir = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
    this.paths ??= exec("git", ["ls-tree", "-r", "-z", "--name-only", this.rev], { cwd: this.dir, maxBuffer: 64 * 1024 * 1024 }).then(({ stdout }) => stdout.split("\0").filter(Boolean).sort());
    return (await this.paths).filter((p) => p.startsWith(dir));
  }

  read(path: string): Promise<string | undefined> {
    return this.cat.read(`${this.rev}:${path}`);
  }

  async write(): Promise<void> {
    throw new VaultError(`${this.rev} is a git revision: read-only`);
  }

  async remove(): Promise<void> {
    throw new VaultError(`${this.rev} is a git revision: read-only`);
  }

  /** Ends its `cat-file` process, unless it was given a shared one. */
  close(): void {
    if (this.ownsCat) this.cat.close();
  }
}
