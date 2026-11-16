import { BudgetExhausted, type Meter, type Reservation } from "@hippocampus/curator";
import type { SqlDriver } from "@hippocampus/index";

// What an account may still spend on models this month, kept in the registry so every vault of the
// account draws on one budget. A reservation is made in one conditional statement: it lands only when
// the month's spend plus every live reservation plus this one stays under the cap, so two vaults
// reserving at once can't both pass. Money is integer micro-dollars.

/** How long a reservation holds before it counts as spent: longer than any hosted call may take. */
export const RESERVATION_MS = 10 * 60_000;

/** The UTC month a time falls in, `YYYY-MM`. */
export const monthOf = (at: Date) => at.toISOString().slice(0, 7);

/** A run's own spend, kept with the run (Durable Object storage), against the per-run cap. */
export interface RunLedger {
  /** Spent by the run so far, and by the unit in flight. */
  get(): { micros: number; unitMicros: number; calls: number };
  add(micros: number): void;
}

/** What the account spent this month, settled reservations only. */
export async function monthSpend(db: SqlDriver, accountId: number, at: Date): Promise<number> {
  const [row] = await db.all<{ micros: number }>("SELECT micros FROM llm_spend WHERE account_id = ? AND month = ?", [accountId, monthOf(at)]);
  return row?.micros ?? 0;
}

/**
 * Reservations past their time count as spent and are let go: an object evicted mid-call never
 * settled them, and the provider may have billed the call.
 */
export async function sweepReservations(db: SqlDriver, accountId: number, at: Date): Promise<void> {
  const expired = await db.all<{ id: string; month: string; micros: number }>("DELETE FROM llm_reservations WHERE account_id = ? AND expires <= ? RETURNING id, month, micros", [accountId, at.toISOString()]);
  if (!expired.length) return;
  const byMonth = new Map<string, number>();
  for (const r of expired) byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + r.micros);
  await db.batch(
    [...byMonth].map(([month, micros]) => ({
      sql: "INSERT INTO llm_spend (account_id, month, micros) VALUES (?, ?, ?) ON CONFLICT (account_id, month) DO UPDATE SET micros = micros + excluded.micros",
      params: [accountId, month, micros],
    })),
  );
}

/** The account's meter for one run: the month's cap in the registry, the run's cap in its ledger. */
export class AccountMeter implements Meter {
  private held = 0;

  constructor(
    private readonly db: SqlDriver,
    private readonly o: { accountId: number; monthCapMicros: number; runCapMicros: number; run: RunLedger; now?: () => Date },
  ) {}

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  async reserve(micros: number): Promise<Reservation | undefined> {
    const run = this.o.run.get();
    if (run.micros + this.held + micros > this.o.runCapMicros) {
      // Everything this run spent went into the unit in flight: the episode alone doesn't fit.
      throw new BudgetExhausted(run.micros === run.unitMicros);
    }
    const at = this.now();
    await sweepReservations(this.db, this.o.accountId, at);
    const month = monthOf(at);
    const id = crypto.randomUUID();
    const rows = await this.db.all<{ id: string }>(
      `INSERT INTO llm_reservations (id, account_id, month, micros, expires)
       SELECT ?, ?, ?, ?, ?
       WHERE COALESCE((SELECT micros FROM llm_spend WHERE account_id = ? AND month = ?), 0)
           + COALESCE((SELECT SUM(micros) FROM llm_reservations WHERE account_id = ? AND month = ?), 0)
           + ? <= ?
       RETURNING id`,
      [id, this.o.accountId, month, micros, new Date(at.getTime() + RESERVATION_MS).toISOString(), this.o.accountId, month, this.o.accountId, month, micros, this.o.monthCapMicros],
    );
    if (!rows.length) return undefined;
    this.held += micros;
    return { id, micros };
  }

  async settle(r: Reservation, actualMicros: number): Promise<void> {
    this.held -= r.micros;
    const spent = Math.min(r.micros, Math.max(0, Math.ceil(actualMicros)));
    this.o.run.add(spent);
    // Swept already (it ran past its time): it was counted in full then.
    const [gone] = await this.db.all<{ month: string }>("DELETE FROM llm_reservations WHERE id = ? RETURNING month", [r.id]);
    if (!gone) return;
    await this.db.all("INSERT INTO llm_spend (account_id, month, micros) VALUES (?, ?, ?) ON CONFLICT (account_id, month) DO UPDATE SET micros = micros + excluded.micros", [
      this.o.accountId,
      gone.month,
      spent,
    ]);
  }
}
