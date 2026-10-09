import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
