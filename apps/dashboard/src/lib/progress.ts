// Pure helpers for a goal's progress (`done` of `total` steps): how to draw it, and the date math a
// repeating goal needs. Unit-tested in progress.test.ts.

/** Totals up to this are drawn as one cell per step; larger ones as a plain bar. */
export const MAX_SEGMENTS = 12;

export interface ProgressShape {
  done: number;
  total: number;
  /** One cell per step (`total` ≤ MAX_SEGMENTS), or a continuous bar. */
  segmented: boolean;
  /** 0–100, rounded. */
  percent: number;
}

/** `done` clamped to 0…`total`, and how to draw it. A total under 1 counts as 1. */
export function progressShape(done: number, total: number): ProgressShape {
  const t = Math.max(1, Math.round(total));
  const d = Math.max(0, Math.min(t, Math.round(done)));
  return { done: d, total: t, segmented: t <= MAX_SEGMENTS, percent: Math.round((d / t) * 100) };
}

/** "3 of 6" for screen readers and captions. */
export function progressLabel(done: number, total: number): string {
  const p = progressShape(done, total);
  return `${p.done} of ${p.total}`;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/**
 * `day` (YYYY-MM-DD) plus `spec` (`3d`, `2w`, `1m`, `1y`), like core's `addDuration`: months and
 * years are calendar ones, and 31 Jan + 1 month is the end of February. Undefined for a bad spec.
 */
export function addInterval(day: string, spec: string): string | undefined {
  const m = /^\s*(\d+)\s*(d|days?|w|weeks?|m|months?|y|years?)\s*$/i.exec(spec);
  if (!m || !ISO_DAY.test(day)) return undefined;
  const n = Number(m[1]);
  if (n <= 0) return undefined;
  const unit = m[2]!.toLowerCase()[0]!;
  const [y, mo, d] = day.slice(0, 10).split("-").map(Number) as [number, number, number];
  if (unit === "d" || unit === "w") return new Date(Date.UTC(y, mo - 1, d + n * (unit === "w" ? 7 : 1))).toISOString().slice(0, 10);
  const first = new Date(Date.UTC(y, mo - 1 + (unit === "m" ? n : 12 * n), 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** Intervals the dashboard offers for a repeat, in the reader's words. */
export const REPEAT_CHOICES: readonly { every: string; label: string }[] = [
  { every: "1w", label: "every week" },
  { every: "2w", label: "every 2 weeks" },
  { every: "1m", label: "every month" },
  { every: "3m", label: "every 3 months" },
  { every: "1y", label: "every year" },
];

/** "every month", or "every 5d" for an interval the dashboard doesn't offer. */
export function repeatLabel(repeat: { every?: string; after_last?: string } | undefined): string | undefined {
  if (!repeat?.every) return undefined;
  const base = REPEAT_CHOICES.find((c) => c.every === repeat.every)?.label ?? `every ${repeat.every}`;
  return repeat.after_last ? `${base} after the last ${repeat.after_last}` : base;
}
