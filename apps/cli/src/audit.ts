import { MemoryStore, auditChanges, parseActorTrailer, type Change, type VaultStore } from "@hippocampus/core";
import { CatFile, GitTreeStore, type Git } from "./git.ts";

/** A broken rule in one commit. Paths and rules only: audit output ends up in CI logs. */
export interface CommitViolation {
  sha: string;
  path: string;
  rule: string;
}

export interface HistoryAudit {
  /** Commits checked against their actor's rules. */
  audited: number;
  /** Commits with a trailer that weren't checked, and why. */
  skipped: { sha: string; reason: string }[];
  violations: CommitViolation[];
}

/**
 * Check each commit that names a non-human `Hippo-Actor` against what that actor may do, as
 * `auditChanges` decides it before a hosted write. The human's commits (no trailer, or `human`)
 * aren't audited: the human may change anything.
 */
export async function auditHistory(git: Git, opts: { range?: string; since?: string } = {}): Promise<HistoryAudit> {
  const out: HistoryAudit = { audited: 0, skipped: [], violations: [] };
  const cat = new CatFile(git.dir);
  try {
    for (const c of await git.commits(opts)) {
      const values = [...new Set(c.actors)];
      if (!values.length || (values.length === 1 && values[0] === "human")) continue;
      const flag = (rule: string, path = "(commit)") => out.violations.push({ sha: c.sha, path, rule });
      if (values.length > 1) {
        flag("conflicting Hippo-Actor trailers");
        continue;
      }
      const actor = parseActorTrailer(values[0]!);
      if (!actor) {
        flag("unknown Hippo-Actor trailer");
        continue;
      }
      if (c.parents.length > 1) {
        out.skipped.push({ sha: c.sha, reason: "merge commit" });
        continue;
      }
      const after = new GitTreeStore(git.dir, c.sha, { cat });
      const changes: Change[] = [];
      for (const { status, path } of await git.changedPaths(c.sha, c.parents[0])) {
        if (status === "D") changes.push({ path, remove: true });
        else {
          const content = await after.read(path);
          // A submodule or other non-blob has no content to check.
          if (content !== undefined) changes.push({ path, content });
        }
      }
      const before: VaultStore = c.parents[0] ? new GitTreeStore(git.dir, c.parents[0], { cat }) : new MemoryStore();
      try {
        for (const v of await auditChanges({ before, changes, actor })) flag(v.rule, v.path);
      } catch {
        // Say nothing about why: a parse error can quote the file it failed on.
        flag("could not be audited (unreadable vault config?)");
      }
      out.audited++;
    }
  } finally {
    cat.close();
  }
  return out;
}
