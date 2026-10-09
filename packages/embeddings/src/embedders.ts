import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Embedder } from "@hippocampus/index";
import { embedMany } from "ai";

export interface EmbedConfig {
  provider: "lmstudio" | "ollama" | "openai-compatible" | "workers-ai";
  model: string;
  baseURL?: string;
  apiKey?: string;
  /** Vector matches below this cosine similarity are ignored (model-dependent). */
  minSimilarity?: number;
  timeoutMs?: number;
}

// The same local servers the curator defaults to; both serve OpenAI-compatible /v1/embeddings.
const DEFAULT_BASE_URL: Partial<Record<EmbedConfig["provider"], string>> = {
  lmstudio: "http://localhost:1234/v1",
  ollama: "http://localhost:11434/v1",
};

export const DEFAULT_WORKERS_AI_MODEL = "@cf/baai/bge-m3";

/**
 * Embedding settings from `HIPPO_EMBED_*`. Semantic recall is opt-in: without `HIPPO_EMBED_MODEL`
 * (or the Workers AI provider) this returns undefined and search stays keyword-only.
 */
export function embedConfigFromEnv(vars: Record<string, unknown>): EmbedConfig | undefined {
  // Worker env objects also hold bindings; only string settings matter here.
  const env = Object.fromEntries(Object.entries(vars).filter(([k, v]) => k.startsWith("HIPPO_EMBED_") && typeof v === "string" && v)) as Record<string, string | undefined>;
  const provider = (env.HIPPO_EMBED_PROVIDER ?? "lmstudio") as EmbedConfig["provider"];
  if (provider === ("off" as string)) return undefined;
  if (!["lmstudio", "ollama", "openai-compatible", "workers-ai"].includes(provider)) throw new Error(`unknown HIPPO_EMBED_PROVIDER "${provider}"`);
  const model = env.HIPPO_EMBED_MODEL ?? (provider === "workers-ai" ? DEFAULT_WORKERS_AI_MODEL : undefined);
  if (!model) return undefined;
  const minSimilarity = env.HIPPO_EMBED_MIN_SIMILARITY ? Number(env.HIPPO_EMBED_MIN_SIMILARITY) : undefined;
  return { provider, model, baseURL: env.HIPPO_EMBED_BASE_URL, apiKey: env.HIPPO_EMBED_API_KEY, minSimilarity, timeoutMs: env.HIPPO_EMBED_TIMEOUT_MS ? Number(env.HIPPO_EMBED_TIMEOUT_MS) : undefined };
}

/** Any server with an OpenAI-compatible `/embeddings` endpoint: LM Studio, Ollama, or a hosted API. */
export function openAICompatibleEmbedder(cfg: EmbedConfig): Embedder {
  const baseURL = cfg.baseURL ?? DEFAULT_BASE_URL[cfg.provider];
  if (!baseURL) throw new Error(`HIPPO_EMBED_BASE_URL is required for provider ${cfg.provider}`);
  const model = createOpenAICompatible({ name: cfg.provider, baseURL, apiKey: cfg.apiKey }).embeddingModel(cfg.model);
  return {
    id: `${cfg.provider}:${cfg.model}`,
    async embed(values) {
      const { embeddings } = await embedMany({ model, values, maxRetries: 1, abortSignal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000) });
      return embeddings.map((e) => Float32Array.from(e));
    },
  };
}

/** The slice of the Workers AI binding we use, typed structurally. */
export interface AiLike {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}

/** Cloudflare Workers AI, for the Worker (where a local model isn't reachable). */
export function workersAIEmbedder(ai: AiLike, model = DEFAULT_WORKERS_AI_MODEL): Embedder {
  return {
    id: `workers-ai:${model}`,
    async embed(text) {
      const out = (await ai.run(model, { text })) as { data?: number[][] };
      if (!Array.isArray(out.data)) throw new Error(`Workers AI ${model} returned no embeddings`);
      return out.data.map((e) => Float32Array.from(e));
    },
  };
}

export function createEmbedder(cfg: EmbedConfig, bindings: { ai?: AiLike } = {}): Embedder {
  if (cfg.provider !== "workers-ai") return openAICompatibleEmbedder(cfg);
  if (!bindings.ai) throw new Error("HIPPO_EMBED_PROVIDER=workers-ai needs the AI binding (see apps/worker/wrangler.jsonc)");
  return workersAIEmbedder(bindings.ai, cfg.model);
}
