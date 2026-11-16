// A Durable Object has one alarm, and several jobs want it: the sleep run's lease, the blob cache's
// clean-up, the next scheduled hosted night, and the next slice of a hosted run. Each job says when
// it is next due; the alarm is set to the earliest, and every alarm asks each job whether it is due.
// So setting one job's time never overwrites another's.

import type { SqlStorageLike } from "@hippocampus/index";

export type AlarmJob = "lease" | "gc" | "night" | "slice";

/** When each job is next due, in ms since the epoch; undefined for a job with nothing to do. */
export type AlarmJobs = Record<AlarmJob, number | undefined>;

/** The object's alarm, as far as the jobs need it. */
export interface AlarmPort {
  setAlarm?(at: number): Promise<void>;
  deleteAlarm?(): Promise<void>;
  getAlarm?(): Promise<number | null>;
}

const JOBS_TABLE = "CREATE TABLE IF NOT EXISTS alarm_jobs (job TEXT PRIMARY KEY, at INTEGER NOT NULL)";

/**
 * Each job's due time, kept in the object's SQLite so it survives eviction, and the alarm set to the
 * earliest. Reads only this table, never the registry: the lease is renewed on every save of a run.
 */
export class AlarmBook {
  constructor(
    private readonly sql: SqlStorageLike,
    private readonly alarm: AlarmPort,
  ) {
    sql.exec(JOBS_TABLE).toArray();
  }

  jobs(): Partial<AlarmJobs> {
    const rows = this.sql.exec("SELECT job, at FROM alarm_jobs").toArray() as { job: AlarmJob; at: number }[];
    return Object.fromEntries(rows.map((r) => [r.job, r.at]));
  }

  get(job: AlarmJob): number | undefined {
    return this.jobs()[job];
  }

  /** Records when `job` is next due (undefined: it has nothing to do), and re-arms. */
  async set(job: AlarmJob, at: number | undefined): Promise<void> {
    this.put(job, at);
    await this.arm();
  }

  /** Records without re-arming, for several changes then one `arm`. */
  put(job: AlarmJob, at: number | undefined): void {
    if (at === undefined || !Number.isFinite(at)) this.sql.exec("DELETE FROM alarm_jobs WHERE job = ?", job).toArray();
    else this.sql.exec("INSERT INTO alarm_jobs (job, at) VALUES (?, ?) ON CONFLICT (job) DO UPDATE SET at = excluded.at", job, Math.round(at)).toArray();
  }

  /** Drops every job due by `now`: the alarm handles them, and each sets its next time. */
  due(now: number): Set<AlarmJob> {
    const due = new Set(Object.entries(this.jobs()).filter(([, at]) => at! <= now).map(([job]) => job as AlarmJob));
    for (const job of due) this.put(job, undefined);
    return due;
  }

  /** Sets the alarm to the earliest job, or clears it when none is left. */
  async arm(): Promise<void> {
    const at = nextAlarm(this.jobs());
    if (at === undefined) await this.alarm.deleteAlarm?.();
    else await this.alarm.setAlarm?.(at);
  }

  /** The Cron's backstop: re-arms only a missing or late alarm. Whether it did. */
  async ensure(): Promise<boolean> {
    const at = nextAlarm(this.jobs());
    if (!this.alarm.getAlarm || !alarmLate(await this.alarm.getAlarm(), at)) return false;
    await this.alarm.setAlarm?.(at!);
    return true;
  }
}

/** The time the alarm should go off: the earliest job, or undefined when none is due. */
export function nextAlarm(jobs: Partial<AlarmJobs>): number | undefined {
  const times = Object.values(jobs).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  return times.length ? Math.min(...times) : undefined;
}

/** The next time a vault's night starts at `hourUtc`, strictly after `now`. */
export function nextNight(hourUtc: number, now: Date): number {
  const at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc);
  return at > now.getTime() ? at : at + 24 * 60 * 60_000;
}

/**
 * Whether the alarm the object has, if any, will fire in time for `due`: the Cron's backstop re-arms
 * only an alarm that is missing or later than its earliest job.
 */
export function alarmLate(current: number | null | undefined, due: number | undefined): boolean {
  if (due === undefined) return false;
  return current === null || current === undefined || current > due;
}
