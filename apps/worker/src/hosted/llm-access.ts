import { STEPS, priceOf, type HostedProvider, type StepMix } from "@hippocampus/curator";
import type { SqlDriver } from "@hippocampus/index";
import { HttpError } from "@hippocampus/dashboard";
import { monthOf, monthSpend } from "./llm-spend.ts";
import { open, seal } from "./token-box.ts";

// An account's model key for hosted curation, sealed in the registry the way GitLab tokens are
// (token-box.ts, HIPPO_TOKEN_KEY, bound to the account id). The key is write-only: status shows its
// last four characters, never the rest, and no error or log carries it. It only ever goes to the
// provider's own API: owners get no base-URL field.

export const HOSTED_PROVIDERS: readonly HostedProvider[] = ["anthropic", "mistral"];

/** Where each provider is reached. Only a local fake replaces it, on a loopback Worker (settings.ts). */
export const PROVIDER_URL: Record<HostedProvider, string> = { anthropic: "https://api.anthropic.com/v1", mistral: "https://api.mistral.ai/v1" };

export interface LlmSettings {
  provider: HostedProvider;
  steps: StepMix;
  /** The key's last four characters, for the person to recognize it. */
  keyHint: string;
  monthCapMicros: number;
  runCapMicros: number;
  /** Why hosted runs wait: `auth` or `credit` until a key is saved, `budget:<YYYY-MM>` until that month is over. */
  paused?: string;
  updated: string;
}

interface Row {
  provider: string;
  steps: string;
  secret: string;
  key_hint: string;
  month_cap_micros: number;
  run_cap_micros: number;
  paused: string | null;
  updated: string;
}

const aad = (accountId: number) => `llm-key:${accountId}`;
const hint = (key: string) => `…${key.trim().slice(-4)}`;

/** Whether a stored pause still holds at `at`: a budget pause lapses when its month is over. */
export function pausedNow(paused: string | undefined, at: Date): string | undefined {
  if (!paused) return undefined;
  const m = /^budget:(\d{4}-\d{2})$/.exec(paused);
  return m && m[1] !== monthOf(at) ? undefined : paused;
}

/** A key's check against the provider, without spending: its model list. */
export type KeyCheck = { ok: true } | { ok: false; code: "auth" | "unreachable" | "models_missing"; missing?: string[] };

/** Lists the provider's models with `key`, and checks that every model in `steps` is among them. Free, and never echoes the key. */
export async function checkKey(provider: HostedProvider, key: string, steps: StepMix, o: { fetch?: typeof fetch; baseURL?: string } = {}): Promise<KeyCheck> {
  const base = o.baseURL ?? PROVIDER_URL[provider];
  const headers: Record<string, string> = provider === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` };
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(`${base}/models?limit=1000`, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    return { ok: false, code: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, code: "auth" };
  if (!res.ok) return { ok: false, code: "unreachable" };
  const body = (await res.json().catch(() => ({}))) as { data?: { id?: unknown; aliases?: unknown }[] };
  const ids = new Set((body.data ?? []).flatMap((m) => [m.id, ...(Array.isArray(m.aliases) ? m.aliases : [])]).filter((x): x is string => typeof x === "string"));
  const missing = [...new Set(STEPS.map((s) => steps[s]))].filter((m) => !ids.has(m));
  return missing.length ? { ok: false, code: "models_missing", missing } : { ok: true };
}

export class LlmAccess {
  constructor(
    private readonly db: SqlDriver,
    private readonly tokenKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async settings(accountId: number): Promise<LlmSettings | undefined> {
    const [row] = await this.db.all<Row>("SELECT * FROM llm_credentials WHERE account_id = ?", [accountId]);
    if (!row) return undefined;
    const paused = pausedNow(row.paused ?? undefined, this.now());
    return {
      provider: row.provider as HostedProvider,
      steps: JSON.parse(row.steps) as StepMix,
      keyHint: row.key_hint,
      monthCapMicros: row.month_cap_micros,
      runCapMicros: row.run_cap_micros,
      ...(paused ? { paused } : {}),
      updated: row.updated,
    };
  }

  /** What the account spent on models this UTC month, in micro-dollars. */
  spentThisMonth(accountId: number): Promise<number> {
    return monthSpend(this.db, accountId, this.now());
  }

  /** The key itself, for the Durable Object that runs the night. Never for a response. */
  async keyFor(accountId: number): Promise<string | undefined> {
    const [row] = await this.db.all<{ secret: string }>("SELECT secret FROM llm_credentials WHERE account_id = ?", [accountId]);
    return row ? (await open<{ key: string }>(this.tokenKey, aad(accountId), row.secret))?.key : undefined;
  }

  /**
   * Saves the provider, the step mix and the caps, and the key when given (required the first time).
   * Every model must have a price, or it couldn't be metered. A new key lifts an `auth` or `credit`
   * pause; a cap raised above this month's spend lifts a budget pause.
   */
  async save(accountId: number, s: { provider: HostedProvider; steps: StepMix; key?: string; monthCapMicros: number; runCapMicros: number }): Promise<LlmSettings> {
    if (!HOSTED_PROVIDERS.includes(s.provider)) throw new HttpError(400, "provider: anthropic or mistral", "INVALID");
    const unpriced = STEPS.filter((step) => !priceOf(s.provider, s.steps[step]));
    if (unpriced.length) throw new HttpError(400, `no price for ${unpriced.map((step) => `${step} (${s.steps[step]})`).join(", ")}: pick a listed model`, "INVALID");
    for (const [name, v] of [
      ["monthly cap", s.monthCapMicros],
      ["per-run cap", s.runCapMicros],
    ] as const)
      if (!Number.isSafeInteger(v) || v < 0) throw new HttpError(400, `${name}: a whole number of micro-dollars, 0 or more`, "INVALID");
    const prior = await this.settings(accountId);
    const key = s.key?.trim();
    if (!key && !prior) throw new HttpError(400, "key: paste the provider's API key", "INVALID");
    if (key && key.length > 400) throw new HttpError(400, "key: that's too long to be an API key", "INVALID");
    const at = this.now();
    let paused = prior?.paused;
    if (key && (paused === "auth" || paused === "credit")) paused = undefined;
    if (paused?.startsWith("budget:") && s.monthCapMicros > (await monthSpend(this.db, accountId, at))) paused = undefined;
    // The same key, a new provider: the stored one belongs to the old provider.
    if (!key && prior && prior.provider !== s.provider) throw new HttpError(400, "key: a new provider needs its own key", "INVALID");
    const secret = key ? await seal(this.tokenKey, aad(accountId), { key }) : undefined;
    await this.db.all(
      `INSERT INTO llm_credentials (account_id, provider, steps, secret, key_hint, month_cap_micros, run_cap_micros, paused, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET provider = excluded.provider, steps = excluded.steps,
         secret = COALESCE(?, llm_credentials.secret), key_hint = COALESCE(?, llm_credentials.key_hint),
         month_cap_micros = excluded.month_cap_micros, run_cap_micros = excluded.run_cap_micros, paused = excluded.paused, updated = excluded.updated`,
      [
        accountId,
        s.provider,
        JSON.stringify(s.steps),
        secret ?? "",
        key ? hint(key) : "",
        s.monthCapMicros,
        s.runCapMicros,
        paused ?? null,
        at.toISOString(),
        secret ?? null,
        key ? hint(key) : null,
      ],
    );
    return (await this.settings(accountId))!;
  }

  /** Runs wait: the key was refused (`auth`), credit ran out (`credit`), or the month's budget is spent. */
  async pause(accountId: number, reason: "auth" | "credit" | "budget"): Promise<void> {
    const value = reason === "budget" ? `budget:${monthOf(this.now())}` : reason;
    await this.db.all("UPDATE llm_credentials SET paused = ?, updated = ? WHERE account_id = ?", [value, this.now().toISOString(), accountId]);
  }

  async remove(accountId: number): Promise<void> {
    await this.db.batch([
      { sql: "DELETE FROM llm_reservations WHERE account_id = ?", params: [accountId] },
      { sql: "DELETE FROM llm_spend WHERE account_id = ?", params: [accountId] },
      { sql: "DELETE FROM llm_credentials WHERE account_id = ?", params: [accountId] },
    ]);
  }

  // ── Per vault ───────────────────────────────────────────────────────────────

  /** The vault's nightly hour (UTC), or undefined when hosted curation is off for it. */
  async schedule(vaultId: string): Promise<{ hourUtc: number } | undefined> {
    const [row] = await this.db.all<{ hosted_curator: string | null }>("SELECT hosted_curator FROM vaults WHERE id = ?", [vaultId]);
    if (!row?.hosted_curator) return undefined;
    const v = JSON.parse(row.hosted_curator) as { hourUtc?: unknown };
    return typeof v.hourUtc === "number" && Number.isInteger(v.hourUtc) && v.hourUtc >= 0 && v.hourUtc < 24 ? { hourUtc: v.hourUtc } : undefined;
  }

  async setSchedule(vaultId: string, hourUtc: number | null): Promise<void> {
    if (hourUtc !== null && !(Number.isInteger(hourUtc) && hourUtc >= 0 && hourUtc < 24)) throw new HttpError(400, "hour: 0 to 23 (UTC)", "INVALID");
    await this.db.all("UPDATE vaults SET hosted_curator = ? WHERE id = ?", [hourUtc === null ? null : JSON.stringify({ hourUtc }), vaultId]);
  }

  /** Vaults with hosted curation on, for the Cron's backstop. */
  async scheduledVaults(): Promise<string[]> {
    return (await this.db.all<{ id: string }>("SELECT id FROM vaults WHERE hosted_curator IS NOT NULL AND status = 'ready' ORDER BY id")).map((r) => r.id);
  }
}
