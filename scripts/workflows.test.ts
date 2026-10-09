import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SLEEP_WORKFLOW } from "../apps/worker/src/hosted/sleep-workflow.ts";

// The workflows this repo hands to vaults run in people's private repos, where nobody here sees them
// fail. actionlint (scripts/lint-workflows.mjs) checks they're valid; these check they still do what
// the docs promise, and nothing more.

const ROOT = join(import.meta.dirname, "..");

interface Step {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: unknown;
  environment?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  "timeout-minutes"?: number;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs: Record<string, Job>;
}

const load = (text: string) => parse(text) as Workflow;

describe("the vault template's validate workflow", () => {
  const w = load(readFileSync(join(ROOT, "vault-template/.github/workflows/validate.yml"), "utf8"));
  const { validate, audit } = w.jobs;

  it("validates pushes and pull requests, except ones that only add inbox memories", () => {
    for (const event of ["push", "pull_request"]) expect(w.on[event], event).toEqual({ "paths-ignore": ["inbox/**"] });
    expect(validate?.if).toBe("github.event_name == 'push' || github.event_name == 'pull_request'");
    expect(validate?.steps.map((s) => s.run).filter(Boolean)).toEqual([expect.stringMatching(/^npx -y @mehrad77\/hippocampus@\d+ validate$/)]);
  });

  it("audits daily with the full history", () => {
    expect(w.on.schedule).toEqual([{ cron: expect.any(String) }]);
    expect(w.on).toHaveProperty("workflow_dispatch");
    expect(audit?.if).toContain("github.event_name == 'schedule'");
    const checkout = audit?.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toMatchObject({ "fetch-depth": 0 });
    expect(audit?.steps.map((s) => s.run).filter(Boolean)).toEqual([expect.stringMatching(/^npx -y @mehrad77\/hippocampus@\d+ audit\b/)]);
  });
});

describe("the hosted app's nightly sleep workflow", () => {
  const w = load(SLEEP_WORKFLOW);
  const jobs = Object.values(w.jobs);
  const steps = jobs.flatMap((j) => j.steps);

  it("runs on a schedule or by hand, one at a time", () => {
    expect(w.on.schedule).toEqual([{ cron: expect.any(String) }]);
    expect(w.on).toHaveProperty("workflow_dispatch");
    expect(Object.keys(w.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(w.concurrency?.["cancel-in-progress"]).toBe(false);
    for (const j of jobs) expect(j["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("gets no repo permissions and never checks the vault out", () => {
    expect(w.permissions).toEqual({});
    for (const j of jobs) expect(j.permissions).toBeUndefined();
    expect(steps.map((s) => s.uses)).toEqual(["anthropics/claude-code-action@v1"]);
    expect(steps.some((s) => s.run)).toBe(false);
  });

  it("lets Claude use the vault's MCP tools and nothing else", () => {
    const args = String(steps[0]!.with!.claude_args);
    expect([...args.matchAll(/--allowedTools\s+"([^"]*)"/g)].map((m) => m[1])).toEqual(["mcp__hippocampus__*"]);
    expect(args).not.toMatch(/--(dangerously-skip-permissions|disallowedTools|permission-mode)/);
  });

  it("takes its key and URL from the repo's secrets and variables, never inline", () => {
    const action = steps[0]!.with!;
    expect(action.anthropic_api_key).toBe("${{ secrets.ANTHROPIC_API_KEY }}");
    expect(String(action.claude_args)).toContain('"Authorization":"Bearer ${{ secrets.HIPPO_CURATOR_KEY }}"');
    expect(String(action.claude_args)).toContain('"url":"${{ vars.HIPPO_MCP_URL }}"');
    expect(SLEEP_WORKFLOW).not.toMatch(/hippo_[\w-]{20,}|sk-ant-|ghp_|ghs_|https?:\/\/(?!github\.com)/);
  });
});

describe("this repo's CI", () => {
  const w = load(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));

  it("releases only after every check passed", () => {
    expect(Object.keys(w.jobs)).toEqual(expect.arrayContaining(["check", "worker", "workflows", "release"]));
    expect(w.jobs.release!.needs).toEqual(["check", "worker", "workflows"]);
    expect(w.jobs.release!.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  });

  it("reads by default, and cancels superseded pull request runs but never main's", () => {
    expect(w.permissions).toEqual({ contents: "read" });
    // Grouped by ref for pull requests; by the run itself otherwise, so a main run has nothing to cancel it.
    expect(w.concurrency?.group).toBe("ci-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}");
    expect(w.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(w.jobs.release!.permissions).toEqual({ contents: "write", "id-token": "write" });
  });

  describe("deploying the hosted app", () => {
    const { tip, deploy } = w.jobs;
    const MAIN = "github.event_name == 'push' && github.ref == 'refs/heads/main'";

    it("deploys after the release, and only main's newest commit", () => {
      expect(tip?.needs).toBe("release");
      expect(tip?.if).toBe(MAIN);
      expect(deploy?.needs).toBe("tip");
      expect(deploy?.if).toBe("needs.tip.outputs.current == 'true'");
      // Applies the registry's migrations before the code that needs them, and probes what went live.
      const runs = deploy!.steps.map((s) => s.run ?? "");
      const at = (re: RegExp) => runs.findIndex((r) => re.test(r));
      expect(at(/deploy\.mjs config/)).toBeLessThan(at(/d1 migrations apply REGISTRY --remote -c wrangler\.deploy\.json/));
      expect(at(/d1 migrations apply/)).toBeLessThan(at(/wrangler deploy -c wrangler\.deploy\.json/));
      expect(at(/wrangler deploy -c/)).toBeLessThan(at(/deploy\.mjs probe/));
    });

    it("runs one deploy at a time in the main-only production environment, reading the repo only", () => {
      expect(deploy?.environment).toMatchObject({ name: "production" });
      expect(deploy?.concurrency).toEqual({ group: "deploy-production", "cancel-in-progress": false });
      expect(deploy?.permissions).toEqual({ contents: "read" });
    });

    it("hands the Cloudflare token only to wrangler, and to no other job", () => {
      for (const [name, job] of Object.entries(w.jobs)) {
        for (const step of job.steps) {
          const usesSecrets = JSON.stringify(step).includes("secrets.");
          if (name === "deploy" && usesSecrets) expect(step.run, step.id ?? step.run).toMatch(/^pnpm exec wrangler |\n\s*pnpm exec wrangler /);
          else expect(usesSecrets, `${name}: ${step.run ?? step.uses}`).toBe(false);
        }
      }
      const checkout = deploy!.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with).toMatchObject({ "persist-credentials": false });
    });

    it("rolls back only a version this run put live", () => {
      const rollback = deploy!.steps.find((s) => s.run?.includes("wrangler rollback"));
      expect(rollback?.if).toBe("failure() && steps.deploy.outcome == 'success'");
      expect(deploy!.steps.find((s) => s.id === "deploy")?.run).toContain("wrangler deploy");
    });
  });
});
