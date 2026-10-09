import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
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

  /** The `origin` remote (or the first one), as host and path only. */
  async remoteInfo(): Promise<Remote | undefined> {
    const names = (await this.run("remote")).split("\n").filter(Boolean);
    const name = names.includes("origin") ? "origin" : names[0];
    if (!name) return undefined;
    const parsed = parseRemoteUrl(await this.run("remote", "get-url", name));
    return parsed && { name, ...parsed };
  }
}
