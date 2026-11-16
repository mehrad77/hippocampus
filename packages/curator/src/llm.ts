import { createAnthropic } from "@ai-sdk/anthropic";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { generateText, Output, type LanguageModel, type LanguageModelUsage } from "ai";
import { z } from "zod";
import { metered, promptTokenBound, type Meter } from "./meter.ts";
import { STEPS, type Price, type Step, type Usage } from "./pricing.ts";

/** The only thing the curator needs from a model: schema-validated structured output. */
export interface LLM {
  readonly name: string;
  object<T>(req: { name: string; schema: z.ZodType<T>; system: string; prompt: string }): Promise<T>;
}

export interface LLMConfig {
  provider: "lmstudio" | "ollama" | "openai-compatible" | "anthropic" | "xai" | "mistral";
  model: string;
  baseURL?: string;
  apiKey?: string;
  temperature?: number;
  maxRetries?: number;
  /**
   * native: provider-enforced JSON schema (best for hosted APIs).
   * prompt: schema in the prompt, JSON extracted from the answer and validated, with a retry on errors.
   *   Default for local servers: grammar-constrained decoding suppresses thinking in reasoning models
   *   and some servers return the JSON in the reasoning channel.
   */
  structured?: "native" | "prompt";
  /** Cap on generated tokens per call (reasoning included on most servers). */
  maxOutputTokens?: number;
  /** Per-call timeout in ms, so a runaway reasoning loop can't stall the night. */
  timeoutMs?: number;
  /**
   * Pays for every attempt before it is made (hosted curation). With a meter, the SDK's own retries
   * are off, since one reservation covers one request.
   */
  meter?: { meter: Meter; price: Price };
  /** Passed to the provider as is, e.g. `{ anthropic: { effort: "low" } }`. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

const DEFAULT_BASE_URL: Partial<Record<LLMConfig["provider"], string>> = {
  lmstudio: "http://localhost:1234/v1",
  ollama: "http://localhost:11434/v1",
};

function languageModel(cfg: LLMConfig): LanguageModel {
  switch (cfg.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(cfg.model);
    case "xai":
      return createXai({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(cfg.model);
    case "mistral":
      return createMistral({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(cfg.model);
    default: {
      const baseURL = cfg.baseURL ?? DEFAULT_BASE_URL[cfg.provider];
      if (!baseURL) throw new Error(`HIPPO_LLM_BASE_URL is required for provider ${cfg.provider}`);
      return createOpenAICompatible({ name: cfg.provider, baseURL, apiKey: cfg.apiKey, supportsStructuredOutputs: true })(cfg.model);
    }
  }
}

/** `model` overrides the provider's model (tests pass a mock). */
export function aiSdkLLM(cfg: LLMConfig, model: LanguageModel = languageModel(cfg)): LLM {
  const mode = cfg.structured ?? (cfg.provider === "anthropic" || cfg.provider === "xai" || cfg.provider === "mistral" ? "native" : "prompt");
  const timeoutMs = cfg.timeoutMs ?? 180_000;
  const maxOutputTokens = cfg.maxOutputTokens ?? 8192;
  const common = () => ({
    model,
    // Newer Claude models refuse sampling settings; the provider drops them there, with a warning.
    ...(cfg.meter && cfg.temperature === undefined ? {} : { temperature: cfg.temperature ?? 0.1 }),
    maxRetries: cfg.meter ? 0 : (cfg.maxRetries ?? 2),
    maxOutputTokens,
    abortSignal: AbortSignal.timeout(timeoutMs),
    ...(cfg.providerOptions ? { providerOptions: cfg.providerOptions as never } : {}),
  });
  // One request, paid for in advance when there's a meter. The bound counts the schema too: native
  // structured output sends it alongside the prompt.
  const call = async <R extends { usage: LanguageModelUsage }>(parts: string[], run: () => Promise<R>): Promise<R> => {
    if (!cfg.meter) return run();
    return metered(cfg.meter.meter, cfg.meter.price, { promptTokens: promptTokenBound(parts), maxOutputTokens }, async () => {
      const res = await run();
      return { value: res, usage: usageOf(res.usage) };
    });
  };
  return {
    name: `${cfg.provider}:${cfg.model}`,
    async object({ name, schema, system, prompt }) {
      const jsonSchema = JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
      if (mode === "native") {
        const res = await call([system, prompt, jsonSchema], () => generateText({ ...common(), system, prompt, output: Output.object({ schema, name }) }));
        return res.output as z.infer<typeof schema>;
      }
      const sys = `${system}\n\nRespond with ONLY one JSON object matching this JSON Schema. No prose, no code fences.\n${jsonSchema}`;
      let feedback = "";
      let lastError = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await call([sys, prompt + feedback], () => generateText({ ...common(), system: sys, prompt: prompt + feedback }));
        const raw = extractJson(res.text) ?? extractJson(res.reasoningText ?? "");
        if (raw === undefined) {
          lastError = "no JSON object found in the answer";
        } else {
          const parsed = schema.safeParse(raw);
          if (parsed.success) return parsed.data;
          lastError = z.prettifyError(parsed.error);
        }
        feedback = `\n\nYour previous answer was invalid (${lastError}). Answer again with only the corrected JSON object.`;
      }
      throw new Error(`${name}: model output invalid after 3 attempts: ${lastError}`);
    },
  };
}

/** The SDK's usage as the meter prices it: plain input apart from cache reads and writes. Undefined when the provider reported none. */
export function usageOf(u: LanguageModelUsage | undefined): Usage | undefined {
  if (!u || u.inputTokens === undefined || u.outputTokens === undefined) return undefined;
  const cacheRead = u.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = u.inputTokenDetails?.cacheWriteTokens ?? 0;
  const input = u.inputTokenDetails?.noCacheTokens ?? Math.max(0, u.inputTokens - cacheRead - cacheWrite);
  return { input, output: u.outputTokens, cacheRead, cacheWrite };
}

/**
 * One LLM that sends each curator step to its own model, by the request's `name`. Requests that
 * aren't a step (a ping) go to `fallback`. `name` is the mix's label, for the `Hippo-Model` trailer.
 */
export function stepLLM(steps: Record<Step, LLM>, fallback: LLM, name: string): LLM {
  const isStep = (n: string): n is Step => (STEPS as readonly string[]).includes(n);
  return {
    name: name.length <= 120 ? name : `${name.slice(0, 119)}…`,
    object: (req) => (isStep(req.name) ? steps[req.name] : fallback).object(req),
  };
}

export interface PingResult {
  ok: boolean;
  model: string;
  ms: number;
  error?: string;
}

const Ping = z.object({ ok: z.boolean() });

/**
 * One tiny schema-validated call through the same adapter the curator uses, to check that the
 * model answers and its structured output parses. Never throws.
 */
export async function pingLLM(cfg: LLMConfig, opts: { timeoutMs?: number; model?: LanguageModel } = {}): Promise<PingResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const started = Date.now();
  const done = (r: { ok: boolean; error?: string }): PingResult => ({ ...r, model: cfg.model, ms: Date.now() - started });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Reasoning models think even about trivia: leave room for it, but don't retry a dead server.
    const llm = aiSdkLLM({ ...cfg, timeoutMs, maxRetries: 0, maxOutputTokens: cfg.maxOutputTokens ?? 2048 }, opts.model);
    const call = llm.object({
      name: "ping",
      schema: Ping,
      system: "You are a health check for a JSON API.",
      prompt: 'Answer with exactly this JSON object: {"ok": true}',
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    });
    const answer = await Promise.race([call, timeout]);
    return done(answer.ok ? { ok: true } : { ok: false, error: "the model answered, but not with ok: true" });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
    return done({ ok: false, error: message.length > 300 ? `${message.slice(0, 300)}…` : message || "unknown error" });
  } finally {
    // Workers' clearTimeout takes no undefined.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Find the first balanced JSON object in text (tolerates prose and code fences around it). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return extractJson(text.slice(i + 1));
      }
    }
  }
  return undefined;
}

export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LLMConfig {
  const provider = (env.HIPPO_LLM_PROVIDER ?? "lmstudio") as LLMConfig["provider"];
  const apiKey =
    env.HIPPO_LLM_API_KEY ??
    (provider === "anthropic" ? env.ANTHROPIC_API_KEY : provider === "xai" ? env.XAI_API_KEY : provider === "mistral" ? env.MISTRAL_API_KEY : undefined);
  const model =
    env.HIPPO_LLM_MODEL ??
    (provider === "anthropic" ? "claude-haiku-4-5-20251001" : provider === "xai" ? "grok-4-fast" : provider === "mistral" ? "mistral-small-2603" : "qwen/qwen3.5-9b");
  const structured = env.HIPPO_LLM_STRUCTURED as LLMConfig["structured"];
  const num = (v: string | undefined) => (v ? Number(v) : undefined);
  return {
    provider,
    model,
    apiKey,
    baseURL: env.HIPPO_LLM_BASE_URL,
    structured,
    maxOutputTokens: num(env.HIPPO_LLM_MAX_TOKENS),
    timeoutMs: num(env.HIPPO_LLM_TIMEOUT_MS),
  };
}

/** Test double: returns queued responses per request name, validating them against the schema. */
export class ScriptedLLM implements LLM {
  readonly name = "scripted";
  readonly calls: { name: string; system: string; prompt: string }[] = [];
  private readonly queues: Map<string, unknown[]>;
  private readonly always = new Map<string, (req: { prompt: string }) => unknown>();

  constructor(script: Record<string, unknown[]> = {}) {
    this.queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  }

  push(name: string, ...responses: unknown[]): this {
    if (!this.queues.has(name)) this.queues.set(name, []);
    this.queues.get(name)!.push(...responses);
    return this;
  }

  /** Answer every request named `name` with `fn` once its queue is empty. */
  respond(name: string, fn: (req: { prompt: string }) => unknown): this {
    this.always.set(name, fn);
    return this;
  }

  private billing?: { meter: Meter; price: Price; usage: Usage; maxOutputTokens: number };

  /** Pay for every call through `meter`, as a hosted model would, each call using `usage`. */
  bill(meter: Meter, price: Price, usage: Usage, maxOutputTokens = usage.output): this {
    this.billing = { meter, price, usage, maxOutputTokens };
    return this;
  }

  async object<T>(req: { name: string; schema: z.ZodType<T>; system: string; prompt: string }): Promise<T> {
    const b = this.billing;
    if (!b) return this.answer(req);
    const bound = { promptTokens: promptTokenBound([req.system, req.prompt]), maxOutputTokens: b.maxOutputTokens };
    return metered(b.meter, b.price, bound, async () => ({ value: await this.answer(req), usage: b.usage }));
  }

  private async answer<T>({ name, schema, system, prompt }: { name: string; schema: z.ZodType<T>; system: string; prompt: string }): Promise<T> {
    this.calls.push({ name, system, prompt });
    const next = this.queues.get(name)?.shift() ?? this.always.get(name)?.({ prompt });
    if (next === undefined) throw new Error(`ScriptedLLM: no response queued for "${name}"`);
    return schema.parse(next);
  }
}
