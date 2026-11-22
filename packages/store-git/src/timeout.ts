import { VaultError } from "@hippocampus/core";

/**
 * How long one call to a git host may take, body included. Without a bound, a call that never
 * answers holds the hosted app's single writer forever, and every later write waits behind it.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** A git host's call that took longer than its timeout. */
export class RequestTimeoutError extends VaultError {
  constructor(what: string, ms: number) {
    super(`${what} didn't answer within ${ms / 1000}s; try again`);
    this.name = "RequestTimeoutError";
  }
}

/** `fetch` given up after `ms`, as a `RequestTimeoutError` naming `what`. The signal also cuts off a body still being read. */
export async function fetchWithin(fetch: typeof globalThis.fetch, url: string, init: RequestInit, ms: number, what: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new RequestTimeoutError(what, ms);
    throw err;
  }
}
