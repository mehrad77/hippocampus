// Human-friendly dates and numbers. Pure, so they are unit-tested in format.test.ts.

const DAY = 86400_000;
const RTF = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }) : undefined;

/** "3 hours ago", "in 2 days", "yesterday". */
export function relTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = t - now;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * DAY],
    ["month", 30 * DAY],
    ["week", 7 * DAY],
    ["day", DAY],
    ["hour", 3600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) if (abs >= ms) return RTF ? RTF.format(Math.round(diff / ms), unit) : `${Math.round(diff / ms)} ${unit}s`;
  return "just now";
}

/** Days until a date as a short phrase: "today", "tomorrow", "in 5 days", "3 days overdue". */
export function daysLeftLabel(days: number | undefined): string {
  if (days === undefined) return "";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "1 day overdue";
  return days > 0 ? `in ${days} days` : `${-days} days overdue`;
}

export function urgency(days: number | undefined): "overdue" | "soon" | "near" | "far" | undefined {
  if (days === undefined) return undefined;
  if (days < 0) return "overdue";
  if (days <= 7) return "soon";
  if (days <= 21) return "near";
  return "far";
}

/** "12 Oct 2026" (or "Mon 12 Oct" with weekday). */
export function shortDate(iso: string | undefined, opts: { weekday?: boolean; year?: boolean } = {}): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: opts.year === false ? undefined : "numeric", weekday: opts.weekday ? "short" : undefined, timeZone: iso.length === 10 ? "UTC" : undefined });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
}

/** snake_case field names read as words: `move_in_date` → "move in date". */
export function fieldLabel(field: string): string {
  return field.replace(/_/g, " ");
}

/** Agent ids to display names when we don't have the party note: `residency-agent` → "Residency Agent". */
export function titleCase(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
