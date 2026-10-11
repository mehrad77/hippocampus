import type { Episode } from "./episode.ts";
import type { EpisodeData, FactValue, FieldDef } from "./schema.ts";
import type { ResolvedKind } from "./schema-registry.ts";
import { isSecretRef } from "./secrets.ts";
import { isCalendarDay, parseFactKey } from "./text.ts";
import type { Vault } from "./vault.ts";
import { unwrapLink } from "./wikilink.ts";

// Advisory checks of notes and episodes against the schema. Validation never blocks a write: these
// findings go to the morning review and `hippo validate`. Messages name paths and fields, never values,
// so they are safe in CI logs.

export type ShapeRule = "undeclared-field" | "kind-mismatch" | "unknown-kind" | "unresolved-ref";

export interface ShapeFinding {
  path: string;
  rule: ShapeRule;
  message: string;
}

const LINK = /^\[\[.+\]\]$/;

/** Why `value` doesn't fit `def`'s kind, or undefined when it does. A `ref` fits when it resolves to a note. */
export function kindMismatch(vault: Vault, def: FieldDef, value: FactValue): string | undefined {
  if (isSecretRef(value)) return undefined;
  const s = String(value).trim();
  switch (def.kind) {
    case "number":
      return typeof value === "number" || (s !== "" && Number.isFinite(Number(s))) ? undefined : "a number";
    case "bool":
      return typeof value === "boolean" || /^(true|false|yes|no)$/i.test(s) ? undefined : "true or false";
    case "date":
      return isCalendarDay(s) ? undefined : "an ISO date";
    case "enum":
      return (def.values ?? []).some((v) => v.toLowerCase() === s.toLowerCase()) ? undefined : `one of ${(def.values ?? []).join(", ") || "(no values declared)"}`;
    case "ref":
      return vault.resolve(unwrapLink(s)) ? undefined : "a link to an existing note";
    default:
      return undefined;
  }
}

/**
 * References an episode's data makes: fields its kind declares as `ref`, `with` (who the episode was
 * with), and any `[[link]]` value. Each value once, as written.
 */
export function dataRefs(kind: ResolvedKind, data: EpisodeData | undefined): { field: string; ref: string }[] {
  const out: { field: string; ref: string }[] = [];
  for (const [field, raw] of Object.entries(data ?? {})) {
    const isRef = kind.data[field]?.kind === "ref" || field === "with";
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      if (typeof v !== "string" || !v.trim()) continue;
      if (isRef || LINK.test(v.trim())) out.push({ field, ref: v.trim() });
    }
  }
  return out;
}

/** Data refs of an episode that match no note (agents, humans and resolvable notes are fine). */
export function unresolvedRefs(vault: Vault, ep: Pick<Episode, "kind" | "data">): { field: string; ref: string }[] {
  const kind = vault.schema.kind(ep.kind).def;
  return dataRefs(kind, ep.data).filter(({ ref }) => {
    const name = unwrapLink(ref);
    return !vault.resolve(name) && !vault.isHuman(name);
  });
}

/** Shape findings about one pending episode: an unknown kind, data refs that match no note. */
export function episodeShapeFindings(vault: Vault, ep: Pick<Episode, "path" | "kind" | "data">): ShapeFinding[] {
  const out: ShapeFinding[] = [];
  if (vault.schema.kind(ep.kind).unknown) out.push({ path: ep.path, rule: "unknown-kind", message: `unknown kind "${ep.kind}"; filed as an observation` });
  for (const { field } of unresolvedRefs(vault, ep)) out.push({ path: ep.path, rule: "unresolved-ref", message: `data.${field} links to no note` });
  return out;
}

/**
 * Advisory findings across the vault: facts of fields a shaped type (one that declares fields)
 * doesn't declare, values that don't fit their field's kind, and pending episodes of unknown kinds or
 * with data refs that match no note. Agents' own notes are skipped.
 */
export function validateShapes(vault: Vault): ShapeFinding[] {
  const out: ShapeFinding[] = [];
  for (const e of vault.entities.values()) {
    const type = vault.schema.type(e.fm.type);
    if (!type || type.capabilities.includes("actor")) continue;
    const shaped = Object.keys(type.fields).length > 0;
    for (const [key, f] of Object.entries(e.fm.facts)) {
      const { field } = parseFactKey(key);
      const def = type.fields[field];
      if (!def) {
        if (shaped) out.push({ path: e.path, rule: "undeclared-field", message: `${field} isn't a field of type "${type.name}"` });
        continue;
      }
      if (f.status === "retconned") continue;
      const want = kindMismatch(vault, def, f.value);
      if (want) out.push({ path: e.path, rule: "kind-mismatch", message: `${key} should be ${want}` });
    }
  }
  for (const ep of vault.episodes) out.push(...episodeShapeFindings(vault, ep));
  return out;
}

export interface FieldUsage {
  type: string;
  /** Undeclared fields, most used first. */
  fields: { field: string; count: number }[];
}

/** Per type, the fields notes use that the type doesn't declare, most used first (at most `top` each): candidates for the schema. */
export function fieldUsage(vault: Vault, top = 5): FieldUsage[] {
  const counts = new Map<string, Map<string, number>>();
  for (const e of vault.entities.values()) {
    const type = vault.schema.type(e.fm.type);
    if (!type || type.capabilities.includes("actor")) continue;
    for (const key of Object.keys(e.fm.facts)) {
      const { field } = parseFactKey(key);
      if (type.fields[field]) continue;
      const m = counts.get(type.name) ?? new Map<string, number>();
      m.set(field, (m.get(field) ?? 0) + 1);
      counts.set(type.name, m);
    }
  }
  return [...counts]
    .map(([type, m]) => ({
      type,
      fields: [...m]
        .map(([field, count]) => ({ field, count }))
        .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field))
        .slice(0, top),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}
