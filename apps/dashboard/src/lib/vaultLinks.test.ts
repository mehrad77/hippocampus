import { describe, expect, it } from "vitest";
import { repoLinks } from "./vaultLinks.ts";

describe("repoLinks", () => {
  it("links GitHub repos", () => {
    const l = repoLinks({ kind: "github", repo: "player/vault", branch: "main", url: "https://github.com/player/vault" })!;
    expect(l.host).toBe("GitHub");
    expect(l.repo).toBe("https://github.com/player/vault");
    expect(l.commits).toBe("https://github.com/player/vault/commits/main");
    expect(l.blob("quests/residence permit.md")).toBe("https://github.com/player/vault/blob/main/quests/residence%20permit.md");
  });

  it("links GitLab projects, under /-/, subgroups and self-managed hosts included", () => {
    const l = repoLinks({ kind: "gitlab", repo: "harbor-university/campus/vault", branch: "trunk", url: "https://git.example.org/harbor-university/campus/vault/" })!;
    expect(l.host).toBe("GitLab");
    expect(l.repo).toBe("https://git.example.org/harbor-university/campus/vault");
    expect(l.commits).toBe("https://git.example.org/harbor-university/campus/vault/-/commits/trunk");
    expect(l.blob("a/b.md")).toBe("https://git.example.org/harbor-university/campus/vault/-/blob/trunk/a/b.md");
  });

  it("falls back to the public hosts without a url, and to nothing without a repo", () => {
    expect(repoLinks({ kind: "github", repo: "player/vault" })!.repo).toBe("https://github.com/player/vault");
    expect(repoLinks({ kind: "gitlab", repo: "player/vault" })!.repo).toBe("https://gitlab.com/player/vault");
    expect(repoLinks({ kind: "dir" })).toBeUndefined();
    expect(repoLinks({ kind: "github" })).toBeUndefined();
    expect(repoLinks(undefined)).toBeUndefined();
  });
});
