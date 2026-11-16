// Compares the eval's runs and recommends a per-step model mix:
//   node_modules/.bin/tsx packages/curator/src/eval/compare.ts [--margin 0.03] [--provider mistral]
// For each provider and prompt version: per step, each model's gates, score, $ per 100 memories and
// time, from runs that used one model for every step. The recommended mix takes, per step, the
// cheapest model that passes the step's gates within `margin` of the step's best. It is accepted only
// once a run of that exact mix scores, end to end, within `margin` of the best single model.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { STEPS, mixLabel, type HostedProvider, type Step, type StepMix } from "../pricing.ts";
import type { EvalRun } from "./run.ts";
import type { CaseScore } from "./score.ts";

export interface StepStanding {
  model: string;
  passes: boolean;
  score: number;
  /** USD per 100 episodes for this step. */
  usdPer100: number;
  msPerCall: number;
}

/** Which gates a step answers for: secret flags come from claims; leaks from what writes names and summaries. */
const GATED: Record<Step, (s: CaseScore) => boolean> = {
  mentions: (s) => s.gates.noLeak,
  match: () => true,
  claims: (s) => s.gates.secretRecall && s.gates.noLeak,
  summary: (s) => s.gates.noLeak,
};

/** Schema-valid within a hosted call's one attempt, at least this often. */
export const MIN_SCHEMA_VALID = 0.99;

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const single = (r: EvalRun) => new Set(STEPS.map((s) => r.mix[s])).size === 1;

/** Each model's standing on each step, from its single-model runs. */
export function standings(runs: EvalRun[]): Record<Step, StepStanding[]> {
  const out = Object.fromEntries(STEPS.map((s) => [s, [] as StepStanding[]])) as Record<Step, StepStanding[]>;
  const byModel = new Map<string, EvalRun[]>();
  for (const r of runs.filter(single)) byModel.set(r.mix.mentions, [...(byModel.get(r.mix.mentions) ?? []), r]);
  for (const [model, rs] of byModel) {
    const results = rs.flatMap((r) => r.results);
    const episodes = results.reduce((n, x) => n + (x.calls.mentions ?? 0), 0) || results.length;
    for (const step of STEPS) {
      const scores = results.map((x) => x.score[step]).filter((v): v is number => v !== undefined);
      const valid = results.map((x) => x.score.schemaValid[step]).filter((v): v is number => v !== undefined);
      const calls = results.reduce((n, x) => n + (x.calls[step] ?? 0), 0);
      out[step].push({
        model,
        passes: results.every((x) => GATED[step](x.score)) && avg(valid) >= MIN_SCHEMA_VALID,
        score: avg(scores),
        usdPer100: (results.reduce((n, x) => n + (x.micros[step] ?? 0), 0) / 1e6 / episodes) * 100,
        msPerCall: calls ? results.reduce((n, x) => n + (x.ms[step] ?? 0), 0) / calls : 0,
      });
    }
  }
  return out;
}

/** Per step, the cheapest gate-passing model within `margin` of the step's best; undefined if a step has none. */
export function recommend(table: Record<Step, StepStanding[]>, margin: number): StepMix | undefined {
  const mix = {} as StepMix;
  for (const step of STEPS) {
    const ok = table[step].filter((s) => s.passes);
    if (!ok.length) return undefined;
    const best = Math.max(...ok.map((s) => s.score));
    mix[step] = ok.filter((s) => s.score >= best - margin).sort((a, b) => a.usdPer100 - b.usdPer100)[0]!.model;
  }
  return mix;
}

/** End-to-end score of a run, averaged over its cases and repeats. */
export const endToEnd = (r: EvalRun) => avg(r.results.map((x) => x.score.endToEnd));

function main(): void {
  const { values } = parseArgs({ options: { margin: { type: "string", default: "0.03" }, provider: { type: "string" }, dir: { type: "string" } } });
  const dir = join(values.dir ?? join(process.env.HIPPO_EVAL_DIR ?? join(process.env.HOME ?? "", ".cache", "hippocampus", "eval")), "results");
  const margin = Number(values.margin);
  const runs = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalRun)
    .filter((r) => !values.provider || r.provider === values.provider);
  const groups = new Map<string, EvalRun[]>();
  for (const r of runs) groups.set(`${r.provider} prompts ${r.promptVersion}`, [...(groups.get(`${r.provider} prompts ${r.promptVersion}`) ?? []), r]);
  for (const [group, rs] of groups) {
    console.log(`\n## ${group}`);
    const table = standings(rs);
    for (const step of STEPS) {
      console.log(`\n${step}`);
      for (const s of table[step].sort((a, b) => b.score - a.score))
        console.log(`  ${s.passes ? "✓" : "✗"} ${s.model.padEnd(28)} score ${s.score.toFixed(3)}  $${s.usdPer100.toFixed(3)}/100  ${Math.round(s.msPerCall)} ms`);
    }
    const mix = recommend(table, margin);
    if (!mix) {
      console.log("\nNo mix: some step has no model that passes its gates.");
      continue;
    }
    const provider = rs[0]!.provider as HostedProvider;
    const label = mixLabel(provider, mix);
    const bestSingle = Math.max(...rs.filter(single).map(endToEnd));
    const checked = rs.filter((r) => STEPS.every((s) => r.mix[s] === mix[s]));
    console.log(`\nRecommended: ${label}`);
    if (!checked.length) {
      const steps = STEPS.map((s) => `--step ${s}=${mix[s]}`).join(" ");
      console.log(`Not checked end to end yet. Run: node_modules/.bin/tsx packages/curator/src/eval/run.ts --provider ${provider} ${steps}`);
    } else {
      const score = avg(checked.map(endToEnd));
      console.log(`End to end ${score.toFixed(3)} vs best single model ${bestSingle.toFixed(3)}: ${score >= bestSingle - margin ? "accepted" : "rejected (outside the margin)"}`);
    }
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main();
