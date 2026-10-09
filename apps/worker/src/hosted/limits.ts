import { hashToken } from "../auth.ts";

// Rate limits and request logs for the hosted app. Logs carry no paths with queries, no bodies and
// no raw vault ids: a log line shouldn't say whose memory a request touched, or what was in it.

/** A Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc). */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/** Whether `key` may go ahead. No binding means no limit, and a failing limiter lets requests through rather than lock everyone out. */
export async function rateLimit(binding: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch {
    return true;
  }
}

export interface LogEvent {
  /** A route name like `POST setup/init`, not the URL. */
  route: string;
  vault?: string;
  status: number;
  code?: string;
  ms: number;
}

/** One JSON line per request. The vault id is hashed (enough to group lines, not to look it up), and anything after `?` is dropped. */
export async function logEvent(e: LogEvent, log: (line: string) => void = console.log): Promise<void> {
  const line: Record<string, unknown> = { route: e.route.split("?")[0], status: e.status, ms: Math.round(e.ms) };
  if (e.vault) line.vault = (await hashToken(`vault:${e.vault}`)).slice(0, 12);
  if (e.code) line.code = e.code;
  log(JSON.stringify(line));
}
