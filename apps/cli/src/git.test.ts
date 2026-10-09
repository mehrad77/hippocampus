import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTOR_TRAILER, MODEL_TRAILER, withTrailers } from "@hippocampus/core";
import { Git, parseRemoteUrl } from "./git.ts";

describe("parseRemoteUrl", () => {
  it("keeps host and path, never credentials", () => {
    expect(parseRemoteUrl("https://player:ghp_secret123@github.com/player/lisbon-arc.git")).toEqual({ host: "github.com", path: "player/lisbon-arc" });
    expect(parseRemoteUrl("git@github.com:player/lisbon-arc.git")).toEqual({ host: "github.com", path: "player/lisbon-arc" });
    expect(parseRemoteUrl("ssh://git@git.example.com:2222/player/lisbon-arc")).toEqual({ host: "git.example.com", path: "player/lisbon-arc" });
    expect(parseRemoteUrl("/srv/git/lisbon-arc.git")).toBeUndefined();
  });
});

describe("Git status", () => {
  let tmp: string | undefined;
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  it("reports branch, remote and uncommitted files", async () => {
    tmp = mkdtempSync(join(tmpdir(), "hippo-git-"));
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: tmp });
    execFileSync("git", ["remote", "add", "origin", "https://player:ghp_secret123@github.com/player/lisbon-arc.git"], { cwd: tmp });
    writeFileSync(join(tmp, "a.md"), "a");
    writeFileSync(join(tmp, "b.md"), "b");
    const git = new Git(tmp);
    expect(await git.status()).toEqual({ branch: "main", dirty: 2 });
    expect(await git.remoteInfo()).toEqual({ name: "origin", host: "github.com", path: "player/lisbon-arc" });
  });
});

describe("Git commits", () => {
  let tmp: string | undefined;
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  it("reads back the trailers a curator commit carries, after the sleep report's own footer", async () => {
    tmp = mkdtempSync(join(tmpdir(), "hippo-git-"));
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: tmp });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: tmp });
    writeFileSync(join(tmp, "a.md"), "a");
    const git = new Git(tmp);
    await git.stage(["a.md"]);
    await git.commit(withTrailers("chore(sleep): consolidate 1 episode\n\n- ep-1 (residency-agent): touched migration-agency\n\nmodel: lmstudio:qwen", { [ACTOR_TRAILER]: "curator", [MODEL_TRAILER]: "lmstudio:qwen" }));
    const [c] = await git.commits();
    expect(c).toMatchObject({ parents: [], actors: ["curator"] });
    expect(await git.run("log", "-1", `--format=%(trailers:key=${MODEL_TRAILER},valueonly)`)).toBe("lmstudio:qwen");
    expect(await git.changedPaths(c!.sha)).toEqual([{ status: "A", path: "a.md" }]);
  });
});
