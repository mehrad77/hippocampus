#!/usr/bin/env node
// Runs actionlint on every GitHub Actions workflow this repo owns or ships: its own CI, the vault
// template's, and the nightly sleep workflow the hosted app writes into vault repos (generated from
// apps/worker/src/hosted/sleep-workflow.ts, so it's linted exactly as it ships).
//
//   node scripts/lint-workflows.mjs              # actionlint from PATH, or ACTIONLINT=/path/to/actionlint
//
// Without actionlint it skips with a note, except in CI, where a skip would hide a broken workflow.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SLEEP_WORKFLOW } from "../apps/worker/src/hosted/sleep-workflow.ts";

const ROOT = join(import.meta.dirname, "..");
const actionlint = process.env.ACTIONLINT || "actionlint";

const probe = spawnSync(actionlint, ["-version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  const why = `actionlint not found (${actionlint}); install it or set ACTIONLINT`;
  if (process.env.CI) {
    console.error(`✗ ${why}`);
    process.exit(1);
  }
  console.log(`- skipped: ${why}`);
  process.exit(0);
}

// actionlint reads a workflow's own path to tell workflows from other YAML, so the shipped ones go
// under .github/workflows/ in a temp dir. Each tree is linted from its root, so reports name paths as a repo would.
const vault = mkdtempSync(join(tmpdir(), "hippo-workflows-"));
mkdirSync(join(vault, ".github/workflows"), { recursive: true });
writeFileSync(join(vault, ".github/workflows/sleep.yml"), SLEEP_WORKFLOW);
copyFileSync(join(ROOT, "vault-template/.github/workflows/validate.yml"), join(vault, ".github/workflows/validate.yml"));

const workflows = (root) =>
  readdirSync(join(root, ".github/workflows"))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => `.github/workflows/${f}`);
const trees = [
  { name: "this repo", root: ROOT, files: workflows(ROOT) },
  { name: "a vault (shipped by the template and the hosted app)", root: vault, files: workflows(vault) },
];

let failed = false;
try {
  for (const t of trees) {
    const r = spawnSync(actionlint, ["-no-color", ...t.files], { cwd: t.root, encoding: "utf8" });
    if (r.status === 0) {
      console.log(`✓ ${t.name}: ${t.files.join(", ")}`);
      continue;
    }
    failed = true;
    console.error(`✗ ${t.name}:\n${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim()}`);
  }
} finally {
  rmSync(vault, { recursive: true, force: true });
}
const version = probe.stdout.split("\n")[0];
if (failed) {
  console.error(`actionlint ${version} found problems`);
  process.exit(1);
}
console.log(`actionlint ${version}: all clean`);
