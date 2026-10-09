import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureStore } from "../../../packages/core/src/__fixtures__/vault.ts";
import { auditHistory } from "./audit.ts";
import { CatFile, Git, GitTreeStore } from "./git.ts";

const EPISODE = "inbox/residency-agent/2026-09-27T100000-agency.md";
const AGENCY = "factions/migration-agency.md";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const write = (files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
};
/** Commit everything as the vault's human, with a `Hippo-Actor` trailer unless `actor` is undefined. */
const commit = (subject: string, actor?: string) => {
  git("add", "-A");
  git("-c", "user.name=player", "-c", "user.email=player@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", subject, ...(actor ? ["-m", `Hippo-Actor: ${actor}`] : []));
  return git("rev-parse", "HEAD");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hippo-audit-"));
  git("init", "--quiet", "-b", "main");
  const seed = fixtureStore();
  write(Object.fromEntries(seed.files));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("GitTreeStore", () => {
  it("reads and lists one revision without a checkout", async () => {
    const first = commit("init", "bootstrap");
    write({ [AGENCY]: "---\ntype: faction\ntitle: Agência de Migração\n---\nMoved.\n" });
    commit("human edit");
    const cat = new CatFile(dir);
    const then = new GitTreeStore(dir, first, { cat });
    try {
      expect(await then.list("party")).toEqual(["party/campus-agent.md", "party/home-finder.md", "party/residency-agent.md"]);
      expect(await then.read(AGENCY)).toContain("Human prose that must survive.");
      expect(await new GitTreeStore(dir, "HEAD", { cat }).read(AGENCY)).toContain("Moved.");
      expect(await then.read("nope.md")).toBeUndefined();
      expect(await then.read("party")).toBeUndefined();
      await expect(then.write()).rejects.toThrow(/read-only/);
    } finally {
      cat.close();
    }
  });
});

describe("auditHistory", () => {
  it("passes clean commits by the curator and agents, and skips the human's", async () => {
    const root = commit("init", "bootstrap");
    write({ [EPISODE]: "---\nid: ep-agency\nagent: residency-agent\nat: 2026-09-27T10:00:00Z\n---\nAgency appointment booked for 2026-10-14.\n" });
    commit("remember(residency-agent): ep-agency", "agent:residency-agent");
    write({ [AGENCY]: (fixtureStore().files.get(AGENCY) ?? "").replace("must survive.", "must survive, and does.") });
    commit("human edit");
    write({ "chronicle/2026/09/2026-09-27.md": "# 2026-09-27\n\n> Agency appointment booked for 2026-10-14.\n\n^ep-agency\n" });
    rmSync(join(dir, EPISODE));
    commit("chore(sleep): consolidate 1 episode", "curator");

    const r = await auditHistory(new Git(dir), { since: "1 hour ago" });
    expect(r).toEqual({ audited: 3, skipped: [], violations: [] });
    expect((await auditHistory(new Git(dir), { range: `${root}..HEAD` })).audited).toBe(2);
  });

  it("reports what an agent or the curator may not do, by path and rule", async () => {
    commit("init", "bootstrap");
    write({ [AGENCY]: "---\ntype: faction\ntitle: Agência de Migração\n---\n\n## Notes\nRewritten.\n" });
    const bad = commit("remember(residency-agent): oops", "agent:residency-agent");
    write({ "inbox/campus-agent/x.md": "---\nagent: campus-agent\n---\nEnrolment opens.\n" });
    rmSync(join(dir, "party/home-finder.md"));
    const curator = commit("chore(sleep): tidy", "curator");
    write({ "lore/visa.md": "---\ntype: lore\ntitle: Visa\n---\n" });
    const odd = commit("something", "gremlin");

    const r = await auditHistory(new Git(dir), { since: "1 hour ago" });
    expect(r.audited).toBe(3);
    expect(r.violations).toContainEqual({ sha: bad, path: AGENCY, rule: "agents may not modify this file" });
    expect(r.violations).toContainEqual({ sha: bad, path: AGENCY, rule: "human prose changed" });
    expect(r.violations).toContainEqual({ sha: curator, path: "inbox/campus-agent/x.md", rule: "outside the curator's folders" });
    expect(r.violations).toContainEqual({ sha: curator, path: "party/home-finder.md", rule: "entity note removed" });
    expect(r.violations).toContainEqual({ sha: odd, path: "(commit)", rule: "unknown Hippo-Actor trailer" });
    // Never file content.
    expect(JSON.stringify(r)).not.toContain("Rewritten");
  });

  it("skips merge commits with a note", async () => {
    commit("init", "bootstrap");
    git("checkout", "--quiet", "-b", "side");
    write({ "inbox/job-scout/a.md": "---\nagent: job-scout\n---\nA cafe is hiring.\n" });
    commit("remember(job-scout): a", "agent:job-scout");
    git("checkout", "--quiet", "main");
    write({ "inbox/home-finder/b.md": "---\nagent: home-finder\n---\nA flat in Alfama.\n" });
    commit("remember(home-finder): b", "agent:home-finder");
    git("-c", "user.name=player", "-c", "user.email=player@example.invalid", "-c", "commit.gpgsign=false", "merge", "--quiet", "--no-ff", "side", "-m", "merge side", "-m", "Hippo-Actor: curator");
    const merge = git("rev-parse", "HEAD");
    const r = await auditHistory(new Git(dir), { since: "1 hour ago" });
    expect(r).toEqual({ audited: 3, skipped: [{ sha: merge, reason: "merge commit" }], violations: [] });
  });
});
