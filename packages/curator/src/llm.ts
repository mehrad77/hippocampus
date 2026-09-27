import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

/** The only thing the curator needs from a model: schema-validated structured output. */
export interface LLM {
  readonly name: string;
  object<T>(req: { name: string; schema: z.ZodType<T>; system: string; prompt: string }): Promise<T>;
}

export interface LLMConfig {
  provider: "lmstudio" | "ollama" | "openai-compatible" | "anthropic" | "xai";
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
    default: {
      const baseURL = cfg.baseURL ?? DEFAULT_BASE_URL[cfg.provider];
      if (!baseURL) throw new Error(`HIPPO_LLM_BASE_URL is required for provider ${cfg.provider}`);
      return createOpenAICompatible({ name: cfg.provider, baseURL, apiKey: cfg.apiKey, supportsStructuredOutputs: true })(cfg.model);
    }
  }
}

export function aiSdkLLM(cfg: LLMConfig): LLM {
  const model = languageModel(cfg);
  const mode = cfg.structured ?? (cfg.provider === "anthropic" || cfg.provider === "xai" ? "native" : "prompt");
  const timeoutMs = cfg.timeoutMs ?? 180_000;
  const common = () => ({
    model,
    temperature: cfg.temperature ?? 0.1,
    maxRetries: cfg.maxRetries ?? 2,
    maxOutputTokens: cfg.maxOutputTokens ?? 8192,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  return {
    name: `${cfg.provider}:${cfg.model}`,
    async object({ name, schema, system, prompt }) {
      if (mode === "native") {
        const res = await generateText({ ...common(), system, prompt, output: Output.object({ schema, name }) });
        return res.output as z.infer<typeof schema>;
      }
      const jsonSchema = JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
      const sys = `${system}\n\nRespond with ONLY one JSON object matching this JSON Schema. No prose, no code fences.\n${jsonSchema}`;
      let feedback = "";
      let lastError = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await generateText({ ...common(), system: sys, prompt: prompt + feedback });
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
    env.HIPPO_LLM_API_KEY ?? (provider === "anthropic" ? env.ANTHROPIC_API_KEY : provider === "xai" ? env.XAI_API_KEY : undefined);
  const model =
    env.HIPPO_LLM_MODEL ??
    (provider === "anthropic" ? "claude-haiku-4-5-20251001" : provider === "xai" ? "grok-4-fast" : "qwen/qwen3.5-9b");
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

  async object<T>({ name, schema, system, prompt }: { name: string; schema: z.ZodType<T>; system: string; prompt: string }): Promise<T> {
    this.calls.push({ name, system, prompt });
    const next = this.queues.get(name)?.shift() ?? this.always.get(name)?.({ prompt });
    if (next === undefined) throw new Error(`ScriptedLLM: no response queued for "${name}"`);
    return schema.parse(next);
  }
}
