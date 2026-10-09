import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { CURATOR_AUTHOR } from "@hippocampus/curator";

const exec = promisify(execFile);


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
}
