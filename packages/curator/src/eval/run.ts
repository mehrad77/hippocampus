// Runs the curator eval against real models, under hosted settings. Costs money and needs keys:
//   ANTHROPIC_API_KEY=… node_modules/.bin/tsx packages/curator/src/eval/run.ts --provider anthropic --model claude-haiku-5-5
//   MISTRAL_API_KEY=…   node_modules/.bin/tsx packages/curator/src/eval/run.ts --provider mistral --step mentions=mistral-small-2603 --step claims=mistral-large-4
// Flags: --provider, --model (every step) or --step <step>=<model> (repeatable, the rest fall back to --model),
// --cases a,b (default all), --repeat N (default 3), --label name. Answers are cached by (model, question),
// so a re-run or a re-score costs nothing. Results and the cache stay outside the repo, in
// ~/.cache/hippocampus/eval/: the privacy guard scans untracked files.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { hostedLLM } from "../hosted-llm.ts";
import type { LLM } from "../llm.ts";
import type { Meter, Reservation } from "../meter.ts";
import { STEPS, mixLabel, type HostedProvider, type Step, type StepMix } from "../pricing.ts";
import { CASES } from "./cases.ts";
import { runCase } from "./harness.ts";
import { scoreCase, type CaseScore } from "./score.ts";

export const EVAL_DIR = join(process.env.HIPPO_EVAL_DIR ?? join(homedir(), ".cache", "hippocampus", "eval"));

/** What one run of the eval measured: per case and repeat, the score, and per step the cost and time. */
export interface EvalRun {
  label: string;
  at: string;
  provider: HostedProvider;
  mix: StepMix;
  promptVersion: string;
  gitRef: string;
  results: { case: string; repeat: number; score: CaseScore; micros: Partial<Record<Step, number>>; ms: Partial<Record<Step, number>>; calls: Partial<Record<Step, number>> }[];
}

/** A meter that never refuses and adds up what each call cost. */
class Tally implements Meter {
  micros = 0;
  async reserve(micros: number): Promise<Reservation> {
    return { id: "", micros };
  }
  async settle(_r: Reservation, actual: number): Promise<void> {
    this.micros += actual;
  }
}

/** Answers from the cache when the same model got the same question before; records the cost it had. */
function cached(inner: LLM, model: string, tally: Tally, dir: string): LLM {
  return {
    name: inner.name,
    async object(req) {
      const key = createHash("sha256")
        .update(JSON.stringify([model, req.name, req.system, req.prompt, z.toJSONSchema(req.schema, { io: "input", unrepresentable: "any" })]))
        .digest("hex");
      const file = join(dir, `${key}.json`);
      if (existsSync(file)) {
        const hit = JSON.parse(readFileSync(file, "utf8")) as { output: unknown; micros: number };
        tally.micros += hit.micros;
        return req.schema.parse(hit.output);
      }
      const before = tally.micros;
      const output = await inner.object(req);
      writeFileSync(file, JSON.stringify({ output, micros: tally.micros - before }));
      return output;
    },
  };
}

/** The prompts' version: a hash of prompts.ts and the git commit it ran at. */
function promptVersion(): { promptVersion: string; gitRef: string } {
  const here = dirname(new URL(import.meta.url).pathname);
  const source = readFileSync(join(here, "..", "prompts.ts"), "utf8");
  let gitRef = "unknown";
  try {
    gitRef = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
  } catch {
    // Not a checkout: the hash still tells versions apart.
  }
  return { promptVersion: createHash("sha256").update(source).digest("hex").slice(0, 12), gitRef };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      step: { type: "string", multiple: true },
      cases: { type: "string" },
      repeat: { type: "string", default: "3" },
      label: { type: "string" },
    },
  });
  const provider = values.provider as HostedProvider;
  if (provider !== "anthropic" && provider !== "mistral") throw new Error("--provider anthropic or mistral");
  const picked = Object.fromEntries((values.step ?? []).map((s) => s.split("=") as [string, string]));
  for (const s of Object.keys(picked)) if (!(STEPS as readonly string[]).includes(s)) throw new Error(`unknown step ${s}: ${STEPS.join(", ")}`);
  const mix = Object.fromEntries(STEPS.map((s) => [s, picked[s] ?? values.model])) as StepMix;
  const missing = STEPS.filter((s) => !mix[s]);
  if (missing.length) throw new Error(`no model for ${missing.join(", ")}: pass --model or --step`);
  const key = provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.MISTRAL_API_KEY;
  if (!key) throw new Error(`set ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "MISTRAL_API_KEY"} in the environment (never on the command line)`);
  const cases = values.cases ? CASES.filter((c) => values.cases!.split(",").includes(c.id)) : CASES;
  const repeat = Math.max(1, Number(values.repeat));

  const cacheDir = join(EVAL_DIR, "cache");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(join(EVAL_DIR, "results"), { recursive: true });
  const run: EvalRun = { label: values.label ?? mixLabel(provider, mix), at: new Date().toISOString(), provider, mix, ...promptVersion(), results: [] };

  for (let r = 0; r < repeat; r++) {
    for (const c of cases) {
      const tallies = Object.fromEntries(STEPS.map((s) => [s, new Tally()])) as Record<Step, Tally>;
      const base = hostedLLM({ provider, key, mix, meter: (s) => tallies[s] });
      // Each repeat asks afresh (a different cache key), so repeats measure the model's variance.
      const perStep = Object.fromEntries(STEPS.map((s) => [s, cached(base, `${mix[s]}#${r}`, tallies[s], cacheDir)])) as Record<Step, LLM>;
      const llm: LLM = { name: base.name, object: (req) => (perStep[req.name as Step] ?? base).object(req) };
      const o = await runCase(c, llm);
      const score = await scoreCase(c, o);
      const ms: Partial<Record<Step, number>> = {};
      const calls: Partial<Record<Step, number>> = {};
      for (const x of o.calls) {
        ms[x.step as Step] = (ms[x.step as Step] ?? 0) + x.ms;
        calls[x.step as Step] = (calls[x.step as Step] ?? 0) + 1;
      }
      run.results.push({ case: c.id, repeat: r, score, micros: Object.fromEntries(STEPS.map((s) => [s, tallies[s].micros])), ms, calls });
      const gates = score.gates.secretRecall && score.gates.noLeak ? "gates ok" : "GATE FAILED";
      console.log(`${c.id} #${r}: ${score.endToEnd.toFixed(2)} (${gates})`);
    }
  }
  const out = join(EVAL_DIR, "results", `${run.at.replace(/[:.]/g, "-")}-${run.label.replace(/[^a-z0-9.-]+/gi, "_").slice(0, 80)}.json`);
  writeFileSync(out, JSON.stringify(run, null, 2));
  console.log(`\nWrote ${out}`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
