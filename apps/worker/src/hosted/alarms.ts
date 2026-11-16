// A Durable Object has one alarm, and several jobs want it: the sleep run's lease, the blob cache's
// clean-up, the next scheduled hosted night, and the next slice of a hosted run. Each job says when
// it is next due; the alarm is set to the earliest, and every alarm asks each job whether it is due.
// So setting one job's time never overwrites another's.

/** When each job is next due, in ms since the epoch; undefined for a job with nothing to do. */
export type AlarmJobs = Record<"lease" | "gc" | "night" | "slice", number | undefined>;

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
