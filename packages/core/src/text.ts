import { VaultError } from "./errors.ts";

/** Fold diacritics (incl. Turkish dotless ı / dotted İ) and lowercase, for matching. */
export function fold(input: string): string {
  return input
    .replace(/İ/g, "i")
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** Normalize a free-form name for alias lookup: folded, punctuation-insensitive. */
export function normalizeName(input: string): string {
  return fold(input)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Filesystem- and wikilink-safe slug. */
export function slugify(input: string): string {
  const slug = fold(input)
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

/**
 * snake_case field names for facts. A `@scope` suffix (`Greeting@lang:pt` → `greeting@lang:pt`) is
 * kept: a fact's scope is part of its key in `facts:`, so each scope holds its own value.
 */
export function toFieldName(input: string): string {
  const at = input.indexOf("@");
  if (at >= 0) return factKey(input.slice(0, at), input.slice(at + 1));
  // Split camelCase before folding: `fold` lowercases, which would hide the boundaries.
  return (
    fold(input.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "note"
  );
}

/**
 * A scope as written in a fact key: folded, lowercase, letters and digits of any script with
 * `:`/`.`/`-`/`_` kept (`lang:pt`, `org:harbor-university`, `lang:日本語`). A scope that has
 * something but normalizes to nothing throws: dropping it would merge its value into the unscoped one.
 */
export function normalizeScope(input: string): string {
  const out = fold(input)
    .trim()
    .replace(/[^\p{L}\p{N}:._-]+/gu, "-")
    .replace(/-*:-*/g, ":")
    .replace(/^[-:]+|[-:]+$/g, "");
  if (!out && input.trim()) throw new VaultError(`scope "${input.trim()}" has no letters or digits`);
  return out;
}

/** The `facts:` key of `field` in `scope`: `field@scope`, or just `field` without a scope. */
export function factKey(field: string, scope?: string): string {
  const parsed = parseFactKey(field);
  const base = toFieldName(parsed.field);
  const s = normalizeScope(scope ?? parsed.scope ?? "");
  return s ? `${base}@${s}` : base;
}

/** A `facts:` key split into its field and scope. */
export function parseFactKey(key: string): { field: string; scope?: string } {
  const at = key.indexOf("@");
  return at < 0 ? { field: key } : { field: key.slice(0, at), scope: key.slice(at + 1) || undefined };
}

/** Small deterministic string hash (cyrb53), returned as base36. */
export function hash(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit time + 80-bit randomness, Crockford base32. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = "";
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return time + rand;
}

export function isoDate(d: Date | string): string {
  return (typeof d === "string" ? new Date(d) : d).toISOString().slice(0, 10);
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Local date (YYYY-MM-DD) and time (HH:MM) of an ISO instant in an IANA timezone. */
export function localParts(iso: string, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** The ISO instant of a local date (YYYY-MM-DD) and time (HH:MM) in an IANA timezone; the inverse of `localParts`. */
export function fromLocal(date: string, time: string, timeZone: string): string {
  const guess = Date.parse(`${date}T${time}:00Z`);
  if (Number.isNaN(guess)) return `${date}T${time}`;
  // The zone's offset at that moment; a second pass settles instants near DST changes.
  let at = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(at).toISOString(), timeZone);
    at -= Date.parse(`${p.date}T${p.time}:00Z`) - guess;
  }
  return new Date(at).toISOString();
}

const DURATION_DAYS = { d: 1, w: 7, m: 30, y: 365 } as const;
export type DurationUnit = keyof typeof DURATION_DAYS;

/**
 * A duration like `3d`, `2w`, `1m` or `1y` (also `2 weeks`, `1 month`): a whole positive count and a
 * unit. The one parser behind due dates, repeats and cadences, so they all accept the same specs.
 */
export function durationSpec(input: string | undefined): { n: number; unit: DurationUnit } | undefined {
  const m = /^\s*(\d+)\s*(d|days?|w|weeks?|m|months?|y|years?)\s*$/i.exec(input ?? "");
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 ? { n, unit: m[2]!.toLowerCase()[0] as DurationUnit } : undefined;
}

/** A duration (see `durationSpec`) in days; months count 30 days and years 365. Undefined for anything else, including `none`. */
export function parseDuration(input: string | undefined): number | undefined {
  const spec = durationSpec(input);
  return spec ? spec.n * DURATION_DAYS[spec.unit] : undefined;
}

/** Whether `s` is exactly a real calendar day, `YYYY-MM-DD` (not `2026-02-30`, not a timestamp). */
export function isCalendarDay(s: string | undefined): boolean {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
