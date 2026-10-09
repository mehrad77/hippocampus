import { describe, expect, it } from "vitest";
import type { GitStatus, SetupItem } from "@hippocampus/dashboard";
import {
  agentIdProblem,
  defaultStep,
  describeError,
  domainProblem,
  hhmm,
  isTimeZone,
  neighbors,
  normalizeUrl,
  parseStep,
  providerForServer,
  publishSnippets,
  repoName,
  repoSlug,
  shellPath,
  stepState,
  syncSnippets,
  tally,
  truncateKey,
  workerDeploySteps,
} from "./model.ts";

const item = (id: string, state: SetupItem["state"]): SetupItem => ({ id, title: id, state, detail: "", how: "performed" });

describe("steps", () => {
  it("parses only known step hashes", () => {
    expect(parseStep("#party")).toBe("party");
    expect(parseStep("secrets")).toBe("secrets");
    expect(parseStep("#nope")).toBeUndefined();
    expect(parseStep("")).toBeUndefined();
  });

  it("knows its neighbors", () => {
    expect(neighbors("welcome").prev).toBeUndefined();
    expect(neighbors("welcome").next?.id).toBe("vault");
    expect(neighbors("done").next).toBeUndefined();
  });

  it("starts at Welcome without a vault, else at the first step that needs you", () => {
    expect(defaultStep([], false)).toBe("welcome");
    const items = [item("vault", "done"), item("party", "warn"), item("secrets", "todo"), item("git", "error")];
    expect(defaultStep(items, true)).toBe("git");
    expect(defaultStep(items.slice(0, 3), true)).toBe("secrets");
    expect(defaultStep(items.slice(0, 2), true)).toBe("party");
    expect(defaultStep([item("vault", "done"), item("remote", "optional")], true)).toBe("done");
  });

  it("locks vault steps until there is a vault", () => {
    expect(stepState("party", [item("party", "done")], false)).toBe("locked");
    expect(stepState("party", [item("party", "done")], true)).toBe("done");
    expect(stepState("vault", [], false)).toBe("todo");
    expect(stepState("llm", [], false)).toBeUndefined();
    expect(stepState("welcome", [], true)).toBeUndefined();
  });

  it("tallies what counts", () => {
    expect(tally([item("vault", "done"), item("git", "warn"), item("remote", "optional"), item("secrets", "na")])).toEqual({ done: 1, total: 2, attention: 1 });
  });
});

describe("validation", () => {
  it("checks agent ids like core does", () => {
    expect(agentIdProblem("residency-agent")).toBeUndefined();
    expect(agentIdProblem("")).toMatch(/id/);
    expect(agentIdProblem("Home-Finder")).toMatch(/lowercase/);
    expect(agentIdProblem("-job-scout")).toBeDefined();
    expect(agentIdProblem("a".repeat(64))).toBeDefined();
    expect(agentIdProblem("archivist", ["archivist"])).toMatch(/taken/);
  });

  it("checks domains", () => {
    expect(domainProblem("housing")).toBeUndefined();
    expect(domainProblem("Housing ")).toBeUndefined();
    expect(domainProblem("two words")).toBeDefined();
    expect(domainProblem("career", ["career"])).toMatch(/already/);
  });

  it("knows time zones", () => {
    expect(isTimeZone("Europe/Lisbon")).toBe(true);
    expect(isTimeZone("Atlantis/Nowhere")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });

  it("normalizes Worker URLs", () => {
    expect(normalizeUrl("hippocampus.example.workers.dev/")).toBe("https://hippocampus.example.workers.dev");
    expect(normalizeUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeUrl("http://hippocampus.example.workers.dev")).toBeUndefined();
    expect(normalizeUrl("https://user:pw@example.dev")).toBeUndefined();
    expect(normalizeUrl("")).toBeUndefined();
  });
});

describe("snippets", () => {
  const git = (over: Partial<GitStatus> = {}): GitStatus => ({ repo: true, branch: "main", ghAvailable: false, dirty: 0, ...over });

  it("quotes paths but keeps ~ expandable", () => {
    expect(shellPath("~/vaults/lisbon-arc")).toBe("~/vaults/lisbon-arc");
    expect(shellPath("~/vaults/lisbon arc")).toBe("~/'vaults/lisbon arc'");
    expect(shellPath("/tmp/it's")).toBe(`'/tmp/it'\\''s'`);
  });

  it("names repositories after the vault folder", () => {
    expect(repoName("~/vaults/lisbon-arc/")).toBe("lisbon-arc");
    expect(repoName("~/vaults/Lisbon Arc")).toBe("Lisbon-Arc");
    expect(repoName("")).toBe("my-campaign");
    expect(repoSlug("/player/lisbon-arc.git")).toBe("player/lisbon-arc");
  });

  it("uses gh with --private when it is available", () => {
    const [s] = publishSnippets(git({ ghAvailable: true, dirty: 3 }), "~/vaults/lisbon-arc");
    expect(s?.code).toContain("gh repo create lisbon-arc --private --source . --push");
    expect(s?.code).toContain("git add -A");
  });

  it("falls back to a remote and a push, with git init for a fresh folder", () => {
    const [s] = publishSnippets({ repo: false, ghAvailable: false }, "~/vaults/lisbon-arc", { owner: "player" });
    expect(s?.code.split("\n")).toEqual([
      "cd ~/vaults/lisbon-arc",
      "git init -b main",
      `git add -A && git commit -m "chore: new vault"`,
      "git remote add origin git@github.com:player/lisbon-arc.git",
      "git push -u origin main",
    ]);
    expect(publishSnippets(git(), "~/v")[0]?.code).not.toContain("git commit");
    expect(publishSnippets(git(), "~/v")[0]?.note).toMatch(/<you>/);
  });

  it("suggests only the sync commands git's counts call for", () => {
    const remote = { name: "origin", host: "github.com", path: "player/lisbon-arc" };
    expect(syncSnippets(git(), "~/v")).toEqual([]);
    expect(syncSnippets(git({ remote, upstream: "origin/main", ahead: 0, behind: 0 }), "~/v")).toEqual([]);
    const labels = syncSnippets(git({ remote, upstream: "origin/main", ahead: 2, behind: 1, dirty: 1 }), "~/v").map((s) => s.label);
    expect(labels).toEqual(["Commit 1 changed file", "Pull 1 new commit", "Push"]);
    expect(syncSnippets(git({ remote }), "~/v")[0]?.code).toContain("git push -u origin main");
  });

  it("fills the Worker URL into the deploy guide", () => {
    const steps = workerDeploySteps("https://hippocampus.example.workers.dev/");
    const all = steps.flatMap((s) => s.snippets.map((x) => x.code)).join("\n");
    expect(all).toContain("https://hippocampus.example.workers.dev/oauth/github/callback");
    expect(all).toContain("https://hippocampus.example.workers.dev/oauth/github/callback/dashboard");
    expect(all).toContain("wrangler kv namespace create OAUTH_KV");
    expect(all).toContain("pnpm --filter @hippocampus/worker run deploy");
    expect(workerDeploySteps(undefined)[2]?.snippets[0]?.code).toContain("<your-subdomain>");
  });
});

describe("small formats", () => {
  it("formats times and keys", () => {
    expect(hhmm(3, 5)).toBe("03:05");
    expect(truncateKey("age1qzexampleexampleexamplek7n3")).toBe("age1qze…k7n3");
    expect(truncateKey(undefined)).toBe("");
  });

  it("maps probed servers to providers", () => {
    expect(providerForServer("LM Studio")).toBe("lmstudio");
    expect(providerForServer("Ollama")).toBe("ollama");
    expect(providerForServer("vLLM")).toBe("openai-compatible");
  });

  it("explains API errors", () => {
    expect(describeError({ status: 501, code: "UNSUPPORTED", message: "Setup is not available here" }).unsupported).toBe(true);
    expect(describeError({ status: 409, code: "NO_VAULT", message: "x" }).noVault).toBe(true);
    expect(describeError({ status: 400, code: "VAULT", message: "unknown domain" }).message).toBe("unknown domain");
    expect(describeError(new Error("boom")).message).toBe("boom");
  });
});
