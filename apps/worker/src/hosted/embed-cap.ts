import { createEmbedder, embedConfigFromEnv, type AiLike } from "@hippocampus/embeddings";
import type { Embedder } from "@hippocampus/index";
import type { DailyCounter } from "./quotas.ts";

// Semantic recall for hosted vaults: off unless the operator configures an embedder, and capped
// per vault per day, since every vault's notes and queries go through the operator's account.

/** Texts embedded per vault per UTC day when HIPPO_EMBED_DAILY_LIMIT isn't set. */
export const DEFAULT_EMBED_DAILY_LIMIT = 5000;

export interface EmbedVars {
  HIPPO_EMBED_PROVIDER?: string;
  HIPPO_EMBED_MODEL?: string;
  HIPPO_EMBED_BASE_URL?: string;
  HIPPO_EMBED_API_KEY?: string;
  HIPPO_EMBED_DAILY_LIMIT?: string;
}

export interface HostedEmbedding {
  embedder: Embedder;
  minSimilarity?: number;
  dailyLimit: number;
}

/** The operator's embedder, or none. Unlike the CLI there's no default provider: a Worker can't reach a local model. */
export function hostedEmbedding(env: EmbedVars, bindings: { ai?: AiLike } = {}): HostedEmbedding | undefined {
  if (!env.HIPPO_EMBED_PROVIDER?.trim()) return undefined;
  const cfg = embedConfigFromEnv({ ...env });
  if (!cfg) return undefined;
  const limit = Number(env.HIPPO_EMBED_DAILY_LIMIT);
  return {
    embedder: createEmbedder(cfg, bindings),
    minSimilarity: cfg.minSimilarity,
    dailyLimit: Number.isInteger(limit) && limit >= 0 && env.HIPPO_EMBED_DAILY_LIMIT?.trim() ? limit : DEFAULT_EMBED_DAILY_LIMIT,
  };
}

/**
 * `inner`, refusing once the day's texts are spent. The index treats the refusal like an embedder
 * outage: search falls back to keywords and unembedded notes wait for tomorrow. Keeps `inner`'s id,
 * so stored vectors stay valid.
 */
export function cappedEmbedder(inner: Embedder, counter: DailyCounter, limit: number): Embedder {
  return {
    id: inner.id,
    embed(texts) {
      if (!counter.take("embed", texts.length, limit)) return Promise.reject(new Error(`daily embedding limit reached (${limit} texts)`));
      return inner.embed(texts);
    },
  };
}
