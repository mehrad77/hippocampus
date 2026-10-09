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

/** snake_case field names for facts. */
export function toFieldName(input: string): string {
  return (
    fold(input)
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "note"
  );
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
