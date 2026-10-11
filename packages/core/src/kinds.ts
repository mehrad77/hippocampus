import { VaultError } from "./errors.ts";
import type { EpisodeData, FactValue, FieldDef } from "./schema.ts";
import type { ResolvedKind, SchemaRegistry } from "./schema-registry.ts";
import { isCalendarDay, slugify, truncate } from "./text.ts";
import { link, unwrapLink } from "./wikilink.ts";

/** Gist length when a `gist` kind doesn't set `gist_max`. */
export const DEFAULT_GIST_MAX = 280;

export interface EpisodeInput {
  kind?: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface ValidatedEpisode {
  /** The kind's registry name; an unknown kind becomes `observation`. */
  kind: string;
  /** Trimmed; cut to the gist for `gist` kinds; empty when the kind forbids text. */
  text: string;
  /** Typed per the kind's `data:` fields; undeclared keys are kept as given. */
  data?: EpisodeData;
  warnings: string[];
}

export const gistMax = (def: ResolvedKind) => def.gistMax ?? DEFAULT_GIST_MAX;

const isScalar = (v: unknown): v is FactValue => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** One value of a `data:` field, coerced to its kind. Throws a VaultError naming the field. */
function coerce(name: string, def: FieldDef, raw: unknown): FactValue {
  const bad = (what: string) => new VaultError(`data.${name} must be ${what}`);
  if (!isScalar(raw)) throw bad("a single value");
  switch (def.kind) {
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n)) throw bad("a number");
      return n;
    }
    case "bool": {
      if (typeof raw === "boolean") return raw;
      const s = String(raw).trim().toLowerCase();
      if (s === "true" || s === "yes") return true;
      if (s === "false" || s === "no") return false;
      throw bad("true or false");
    }
    case "date": {
      const s = String(raw).trim();
      if (!isCalendarDay(s)) throw bad("an ISO date (YYYY-MM-DD)");
      return s;
    }
    case "ref": {
      const s = unwrapLink(String(raw).trim());
      if (!s) throw bad("a [[link]] or a name");
      return `[[${s}]]`;
    }
    case "enum": {
      const s = String(raw).trim();
      const hit = (def.values ?? []).find((v) => v.toLowerCase() === s.toLowerCase());
      if (hit === undefined) throw bad(`one of ${(def.values ?? []).join(", ") || "(no values declared)"}`);
      return hit;
    }
    default: {
      const s = String(raw).trim();
      if (!s) throw bad("non-empty text");
      return s;
    }
  }
}

/** `data` checked against the kind's declared fields: required ones present, values of the right kind. */
function validateData(kind: ResolvedKind, input: Record<string, unknown> | undefined, warnings: string[]): EpisodeData | undefined {
  const out: EpisodeData = {};
  const given = input ?? {};
  for (const [name, def] of Object.entries(kind.data)) {
    const raw = given[name];
    const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0);
    if (empty) {
      if (def.required) throw new VaultError(`a ${kind.name} needs data.${name}`);
      continue;
    }
    if (Array.isArray(raw)) {
      if (!def.many) throw new VaultError(`data.${name} takes one value, not a list`);
      out[name] = raw.map((v) => coerce(name, def, v));
    } else {
      out[name] = def.many ? [coerce(name, def, raw)] : coerce(name, def, raw);
    }
  }
  for (const [name, raw] of Object.entries(given)) {
    if (name in kind.data || raw === undefined || raw === null || raw === "") continue;
    if (isScalar(raw)) out[name] = raw;
    else if (Array.isArray(raw) && raw.every(isScalar)) out[name] = raw;
    else throw new VaultError(`data.${name} must be a value or a list of values`);
    warnings.push(`data.${name} isn't a field of kind "${kind.name}"; kept as given`);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Check one new episode against its kind: the text policy (`required`, `optional`, `gist`,
 * `forbidden`) and typed `data`. An unknown kind is filed as an observation, with a warning.
 */
export function validateEpisode(schema: SchemaRegistry, input: EpisodeInput): ValidatedEpisode {
  const warnings: string[] = [];
  const resolved = schema.kind(input.kind);
  if (resolved.unknown) {
    const known = schema
      .kinds()
      .map((k) => k.name)
      .join(", ");
    warnings.push(`unknown kind "${input.kind}"; filed as an observation (known: ${known})`);
  }
  const kind = resolved.def;
  let text = (input.text ?? "").trim();
  switch (kind.text) {
    case "required":
      if (!text) throw new VaultError("text is required");
      break;
    case "forbidden":
      if (text) throw new VaultError(`a ${kind.name} carries no text, only data: put what matters in its data fields`);
      break;
    case "gist": {
      const max = gistMax(kind);
      if (text.length > 2 * max) throw new VaultError(`a ${kind.name} keeps only a gist of at most ${max} characters; this text is ${text.length}`);
      if (text.length > max) {
        text = truncate(text, max);
        warnings.push(`text cut to the ${max}-character gist a ${kind.name} keeps`);
      }
      break;
    }
  }
  const data = validateData(kind, input.data, warnings);
  if (!text && !data) throw new VaultError(`a ${kind.name} needs text or data`);
  return { kind: resolved.name, text, ...(data ? { data } : {}), warnings };
}

/** `data.channel` as a slug (`call`, `video-call`), when the episode has one. */
export function channelOf(data: EpisodeData | undefined): string | undefined {
  const c = data?.channel;
  const s = Array.isArray(c) ? c[0] : c;
  return s === undefined || s === "" ? undefined : slugify(String(s));
}

/** Whether an episode of `kind` over `channel` counts as contact with its targets. */
export function countsAsContact(kind: ResolvedKind, channel: string | undefined): boolean {
  const c = kind.countsAsContact;
  if (typeof c === "boolean") return c;
  return (channel !== undefined ? c[channel] : undefined) ?? c["*"] ?? false;
}

const show = (v: FactValue) => (typeof v === "string" && /^\[\[.*\]\]$/.test(v) ? link(unwrapLink(v)) : String(v));
const showAll = (v: FactValue | FactValue[]) => (Array.isArray(v) ? v.map(show).join(", ") : show(v));

/**
 * A deterministic one-line account of an episode's data, for kinds that keep no text:
 * `call with [[ana]] · went well`. Channel (else the kind), `with`, then the other fields in order.
 */
export function dataLine(kind: ResolvedKind, data: EpisodeData | undefined): string {
  const d = data ?? {};
  const head = d.channel !== undefined ? showAll(d.channel) : kind.name;
  const first = d.with !== undefined ? `${head} with ${showAll(d.with)}` : head;
  const declared = Object.keys(kind.data);
  const rest = [...declared, ...Object.keys(d).filter((k) => !declared.includes(k)).sort()]
    .filter((k) => k !== "channel" && k !== "with" && d[k] !== undefined)
    .map((k) => showAll(d[k]!));
  return [first, ...rest].join(" · ");
}
