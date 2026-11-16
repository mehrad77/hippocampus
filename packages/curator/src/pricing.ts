// What hosted curation may spend, in integer micro-dollars (1 USD = 1,000,000). Prices are copied from
// each provider's own pages, dated, with the source next to each row: never from memory. When two of a
// provider's pages disagree, the row takes the higher price, so the meter can only over-reserve.
// A model missing here can't be metered, so a hosted run refuses it.

export type HostedProvider = "anthropic" | "mistral";

/** The curator's four model steps, by the `name` each LLM request carries. */
export const STEPS = ["mentions", "match", "claims", "summary"] as const;
export type Step = (typeof STEPS)[number];

/** USD per million tokens. */
export interface Price {
  provider: HostedProvider;
  model: string;
  input: number;
  output: number;
  /** Cache reads; equal to `input` where the provider publishes no discount. */
  cacheRead: number;
  /** Cache writes (5-minute TTL); equal to `input` where caching isn't used or priced. */
  cacheWrite: number;
  /** A higher tier for long prompts: above `tokens` input tokens, the whole request is priced at these rates. */
  above?: { tokens: number; input: number; output: number };
  /** When the row was copied, and from where. */
  checked: string;
  source: string;
  note?: string;
}

const ANTHROPIC_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

export const PRICES: readonly Price[] = [
  {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    above: { tokens: 100_000, input: 0.5, output: 2.5 },
    checked: "2026-11-16",
    source: ANTHROPIC_SOURCE,
  },
  { provider: "anthropic", model: "claude-sonnet-5-5", input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, checked: "2026-11-16", source: ANTHROPIC_SOURCE },
  { provider: "anthropic", model: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, checked: "2026-11-16", source: ANTHROPIC_SOURCE },
  {
    provider: "mistral",
    model: "ministral-14b-2512",
    input: 0.2,
    output: 0.2,
    cacheRead: 0.2,
    cacheWrite: 0.2,
    checked: "2026-11-16",
    source: "https://docs.mistral.ai/models/ministral-3-14b-25-12",
    note: "The model card lists $0.2 twice without labels; read as input and output.",
  },
  {
    provider: "mistral",
    model: "mistral-small-2603",
    input: 0.15,
    output: 0.6,
    cacheRead: 0.15,
    cacheWrite: 0.15,
    checked: "2026-11-16",
    source: "https://docs.mistral.ai/models/mistral-small-4-0-26-03",
    note: "The model card lists $0.15 and $0.6 without labels; read as input and output. No cached-input price published.",
  },
  {
    provider: "mistral",
    model: "mistral-large-4",
    input: 0.7,
    output: 2.1,
    cacheRead: 0.07,
    cacheWrite: 0.7,
    checked: "2026-11-16",
    source: "https://docs.mistral.ai/models/mistral-large-4-0",
    note: "mistral.ai/pricing shows $0.5 / $1.5; the model card's higher $0.7 / $2.1 is used. Confirm the API id against GET /v1/models before the first eval run.",
  },
];

/** The price row for a model, or undefined: such a model can't be metered. */
export function priceOf(provider: HostedProvider, model: string): Price | undefined {
  return PRICES.find((p) => p.provider === provider && p.model === model);
}

/** Tokens one call used, as the provider reports them. `input` excludes cache reads and writes. */
export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** What `usage` costs at `price`, in micro-dollars, rounded up so rounding never undercounts. */
export function costMicros(usage: Usage, price: Price): number {
  const promptTokens = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const long = price.above && promptTokens > price.above.tokens ? price.above : undefined;
  const scale = long ? long.input / price.input : 1;
  // USD per million tokens equals micro-dollars per token.
  const micros =
    usage.input * (long?.input ?? price.input) +
    (usage.cacheRead ?? 0) * price.cacheRead * scale +
    (usage.cacheWrite ?? 0) * price.cacheWrite * scale +
    usage.output * (long?.output ?? price.output);
  return Math.ceil(micros - 1e-9);
}

/**
 * The most a call can cost: every prompt token at the dearest input rate (a cache write costs more
 * than plain input), and every allowed output token at the output rate, long-prompt tier included.
 */
export function worstCaseMicros(promptTokens: number, maxOutputTokens: number, price: Price): number {
  const long = price.above && promptTokens > price.above.tokens ? price.above : undefined;
  const inputRate = Math.max(price.input, price.cacheWrite) * (long ? long.input / price.input : 1);
  return Math.ceil(promptTokens * inputRate + maxOutputTokens * (long?.output ?? price.output));
}

/** Which model answers each step. */
export type StepMix = Record<Step, string>;

/**
 * The eval's recommended mix per provider: for each step, the cheapest model that passes its hard
 * gates and scores within the margin of the best, checked end to end. Empty until the eval has run
 * (packages/curator/src/eval); hosted curation offers a provider only once its mix is here.
 */
export const RECOMMENDED: Partial<Record<HostedProvider, { mix: StepMix; checked: string; promptVersion: string }>> = {
  // 2026-11-16: Haiku, Sonnet and Opus 5.5, 9 cases × 3 repeats. Every model passed every gate; Haiku
  // scored best or tied on each step at about 1/30 of the cost, end to end 0.803 against Opus's 0.821.
  anthropic: {
    mix: { mentions: "claude-haiku-5-5", match: "claude-haiku-5-5", claims: "claude-haiku-5-5", summary: "claude-haiku-5-5" },
    checked: "2026-11-16",
    promptVersion: "abd07fd2fa03",
  },
};

/**
 * Output tokens a hosted call may generate, per step (reasoning included). Provisional; the eval
 * sets them from the longest valid answer it saw, with headroom.
 */
export const STEP_MAX_OUTPUT: Record<Step, number> = { mentions: 2048, match: 512, claims: 4096, summary: 1024 };

/** A compact label for a mix, for the `Hippo-Model` trailer: `anthropic:claude-haiku-5-5(mentions,match)+claude-sonnet-5-5(claims,summary)`, at most 120 characters. */
export function mixLabel(provider: HostedProvider, mix: StepMix): string {
  const byModel = new Map<string, Step[]>();
  for (const s of STEPS) byModel.set(mix[s], [...(byModel.get(mix[s]) ?? []), s]);
  const label =
    byModel.size === 1 ? `${provider}:${mix.mentions}` : `${provider}:${[...byModel].map(([m, steps]) => `${m}(${steps.join(",")})`).join("+")}`;
  return label.length <= 120 ? label : `${label.slice(0, 119)}…`;
}
