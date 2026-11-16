import { MemoryStore, buildVaultFiles, generateKeyPair } from "@hippocampus/core";
import { SEEDS, TEMPLATE } from "@hippocampus/template";
import type { z } from "zod";
import type { LLM } from "../llm.ts";
import { sleep, type SleepReport } from "../sleep.ts";
import type { EvalCase } from "./cases.ts";

/** One model call during a case's night, as the scorer sees it. */
export interface Call {
  step: string;
  prompt: string;
  output?: unknown;
  /** Why the call failed (the schema didn't parse, the provider refused). The text stays on this machine. */
  error?: string;
  ms: number;
}

/** What a case's night did: every call, the report, and the vault's files before and after. */
export interface Observation {
  case: string;
  calls: Call[];
  report: SleepReport;
  before: Record<string, string>;
  after: Record<string, string>;
}

/** The night every case runs at, so dates in the episodes ("tomorrow") mean one thing. */
export const EVAL_NOW = new Date("2026-03-06T21:00:00.000Z");

/** The seed vault with the case's notes and inbox laid over it, and a secrets key so secret facts can be sealed. */
export async function caseFiles(c: EvalCase, now = EVAL_NOW): Promise<Record<string, string>> {
  const files = { ...(await buildVaultFiles(TEMPLATE, { seed: SEEDS["example-relocation"], now })), ...c.notes };
  const { recipient } = await generateKeyPair();
  files["_hippo/config.yaml"] = files["_hippo/config.yaml"]!.replace(/recipient: null/, `recipient: ${recipient}`);
  c.episodes.forEach((e, i) => {
    const flags = `${e.secret ? "secret: true\n" : ""}${e.confidential ? "confidential: true\n" : ""}`;
    files[`inbox/${e.agent}/${e.at.slice(0, 19).replace(/:/g, "")}-${i}.md`] = `---\nagent: ${e.agent}\nkind: fact\nat: ${e.at}\n${flags}---\n${e.text}\n`;
  });
  return files;
}

/** Records every call `llm` answers, by step, failures included. */
export function tap(llm: LLM, calls: Call[]): LLM {
  return {
    name: llm.name,
    async object<T>(req: { name: string; schema: z.ZodType<T>; system: string; prompt: string }): Promise<T> {
      const started = Date.now();
      try {
        const output = await llm.object(req);
        calls.push({ step: req.name, prompt: req.prompt, output, ms: Date.now() - started });
        return output;
      } catch (err) {
        calls.push({ step: req.name, prompt: req.prompt, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started });
        throw err;
      }
    },
  };
}

/** Runs one case's night with `llm`, the real `sleep()` over a store in memory. */
export async function runCase(c: EvalCase, llm: LLM, now = EVAL_NOW): Promise<Observation> {
  const before = await caseFiles(c, now);
  const store = new MemoryStore(before);
  const calls: Call[] = [];
  const report = await sleep({ store, llm: tap(llm, calls), now: () => now, log: () => {} });
  return { case: c.id, calls, report, before, after: Object.fromEntries(store.files) };
}
