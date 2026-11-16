import { costMicros, worstCaseMicros, type Price, type Usage } from "./pricing.ts";

// Every hosted model call is paid for before it is made: the meter reserves the call's worst case,
// and settles it to what the provider reports afterwards, refunding the rest. So spend can't pass
// the cap, whatever the model does. A call whose usage never comes back keeps its whole reservation.

/** Money held for one call until it settles. */
export interface Reservation {
  id: string;
  micros: number;
}

/** Where reservations are kept: in memory for the CLI and tests, the account's ledger on the Worker. */
export interface Meter {
  /** Holds `micros`, or refuses (undefined) when that would pass a cap. May instead throw its own `BudgetExhausted`, to say more. */
  reserve(micros: number): Promise<Reservation | undefined>;
  /** Turns the reservation into spend of `actualMicros` (never more than it held), releasing the rest. */
  settle(r: Reservation, actualMicros: number): Promise<void>;
}

/**
 * A reason to stop the whole run, not a fault of the episode in hand: the episode stays in the inbox
 * and isn't counted as failed. `sleep()` and the relay stop at the first one.
 */
export class RunStop extends Error {
  constructor(
    readonly stop: StopReason,
    message: string,
  ) {
    super(message);
  }
}

export type StopReason = "budget" | "auth" | "credit" | "rate_limit" | "provider";

/**
 * The meter refused a call: a cap would be passed. `tooLarge` when the episode alone, with the run's
 * whole cap to itself, still wouldn't fit: it is passed over rather than tried again every night.
 */
export class BudgetExhausted extends RunStop {
  constructor(readonly tooLarge = false) {
    super("budget", tooLarge ? "too large for the per-run budget" : "budget reached");
  }
}

/** The provider refused or failed in a way the next episode would meet too. Carries a code, never the provider's message. */
export class ProviderStop extends RunStop {
  constructor(stop: Exclude<StopReason, "budget">, readonly status?: number) {
    super(stop, `model provider stopped the run (${stop}${status ? ` ${status}` : ""})`);
  }
}

/**
 * Whether a failed call stops the run, and why. A refused key, spent credit, a rate limit, a server
 * error or a timeout would fail every episode alike; anything else (a bad answer, a prompt the
 * provider turns down) is the episode's own failure. Only the status and a match on the body decide:
 * the provider's text never leaves this function.
 */
export function stopFor(err: unknown): ProviderStop | undefined {
  const e = err as { statusCode?: unknown; responseBody?: unknown; name?: unknown; message?: unknown } | undefined;
  const status = typeof e?.statusCode === "number" ? e.statusCode : undefined;
  const body = `${typeof e?.responseBody === "string" ? e.responseBody : ""} ${typeof e?.message === "string" ? e.message : ""}`;
  if (status === 401 || status === 403) return new ProviderStop("auth", status);
  if (status === 402 || (status !== undefined && status < 500 && /credit balance|insufficient (credit|funds|balance)|billing|payment required/i.test(body)))
    return new ProviderStop("credit", status);
  if (status === 429) return new ProviderStop("rate_limit", status);
  if (status !== undefined && status >= 500) return new ProviderStop("provider", status);
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return new ProviderStop("provider");
  return undefined;
}

/**
 * A prompt's tokens, bounded from above: these providers' tokenizers never put less than one byte in
 * a token, so the UTF-8 length bounds the count. `overhead` covers what the provider adds around it
 * (the structured-output wrapper, message framing).
 */
export function promptTokenBound(parts: readonly string[], overhead = PROMPT_OVERHEAD_TOKENS): number {
  const enc = new TextEncoder();
  return parts.reduce((n, p) => n + enc.encode(p).length, 0) + overhead;
}

/** Tokens a provider adds around a prompt. Generous; settling refunds what wasn't used. */
export const PROMPT_OVERHEAD_TOKENS = 2_000;

/** Pays for one call through `meter`: reserves its worst case, runs it, settles to its usage. */
export async function metered<T>(
  meter: Meter,
  price: Price,
  bound: { promptTokens: number; maxOutputTokens: number },
  call: () => Promise<{ value: T; usage?: Usage }>,
): Promise<T> {
  const held = await meter.reserve(worstCaseMicros(bound.promptTokens, bound.maxOutputTokens, price));
  if (!held) throw new BudgetExhausted();
  let result: { value: T; usage?: Usage };
  try {
    result = await call();
  } catch (err) {
    // Tokens may have been billed before the error: keep the reservation as spent.
    await meter.settle(held, held.micros);
    throw stopFor(err) ?? err;
  }
  await meter.settle(held, result.usage ? Math.min(held.micros, costMicros(result.usage, price)) : held.micros);
  return result.value;
}

/** A meter in memory with a cap, for the CLI and tests: what it spent, and how many calls. */
export class CappedMeter implements Meter {
  spent = 0;
  held = 0;
  calls = 0;
  private next = 0;

  constructor(readonly capMicros: number) {}

  async reserve(micros: number): Promise<Reservation | undefined> {
    if (this.spent + this.held + micros > this.capMicros) return undefined;
    this.held += micros;
    return { id: String(++this.next), micros };
  }

  async settle(r: Reservation, actualMicros: number): Promise<void> {
    this.held -= r.micros;
    this.spent += Math.min(r.micros, Math.max(0, actualMicros));
    this.calls++;
  }
}
