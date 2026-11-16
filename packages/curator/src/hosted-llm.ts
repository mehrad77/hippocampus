import { aiSdkLLM, stepLLM, type LLM, type LLMConfig } from "./llm.ts";
import type { Meter } from "./meter.ts";
import { STEPS, STEP_MAX_OUTPUT, mixLabel, priceOf, type HostedProvider, type Step, type StepMix } from "./pricing.ts";

/** A model the hosted curator can't price, so won't call. */
export class UnpricedModel extends Error {
  constructor(
    readonly provider: HostedProvider,
    readonly model: string,
  ) {
    super(`${provider}:${model} has no price in pricing.ts, so it can't be metered`);
  }
}

/** Seconds a hosted call may take, well under the meter's reservation lifetime (10 minutes). */
export const HOSTED_TIMEOUT_MS = 120_000;

/** How a hosted run calls one step's model. The eval runs the same settings, so a model is judged as it will be used. */
export function hostedCallConfig(provider: HostedProvider, model: string, step: Step, key: string, baseURL?: string): LLMConfig {
  return {
    provider,
    model,
    apiKey: key,
    ...(baseURL ? { baseURL } : {}),
    structured: "native",
    maxOutputTokens: STEP_MAX_OUTPUT[step],
    timeoutMs: HOSTED_TIMEOUT_MS,
    // Claude's newest models refuse sampling settings; Mistral takes 0 for repeatable answers.
    ...(provider === "mistral" ? { temperature: 0 } : {}),
    ...(provider === "anthropic" ? { providerOptions: { anthropic: { effort: "low" } } } : {}),
  };
}

/**
 * The curator's model for a hosted run: each step on its model from `mix`, every call paid for through
 * the step's meter first. Refuses a model without a price.
 */
export function hostedLLM(o: { provider: HostedProvider; key: string; mix: StepMix; meter: Meter | ((step: Step) => Meter); baseURL?: string }): LLM {
  const meterFor = typeof o.meter === "function" ? o.meter : () => o.meter as Meter;
  const steps = {} as Record<Step, LLM>;
  for (const step of STEPS) {
    const price = priceOf(o.provider, o.mix[step]);
    if (!price) throw new UnpricedModel(o.provider, o.mix[step]);
    steps[step] = aiSdkLLM({ ...hostedCallConfig(o.provider, o.mix[step], step, o.key, o.baseURL), meter: { meter: meterFor(step), price } });
  }
  return stepLLM(steps, steps.mentions, mixLabel(o.provider, o.mix));
}
