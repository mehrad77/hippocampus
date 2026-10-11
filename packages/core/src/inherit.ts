import type { Entity } from "./entity.ts";
import type { FactValue, Guideline } from "./schema.ts";
import { MAX_EXTENDS_DEPTH } from "./schema-registry.ts";
import { normalizeName, normalizeScope, parseDuration } from "./text.ts";
import type { Vault } from "./vault.ts";
import { unwrapLink } from "./wikilink.ts";

/** A guideline with the slug of the note it comes from (the entity itself, an ancestor or a mixin). */
export type InheritedGuideline = Guideline & { source: string };

export interface Inheritance {
  /** `extends:` ancestors, nearest first, at most `MAX_EXTENDS_DEPTH`. */
  chain: Entity[];
  /** Entities of an `inheritable` type that the entity's tags name, in tag order. */
  mixins: Entity[];
  /** Own defaults over the chain's (nearest first) over the mixins' (first tag first). */
  defaults: Record<string, FactValue>;
  /** Own, then the chain's, then the mixins'; the same rule in the same scope appears once, the nearest winning. */
  guidelines: InheritedGuideline[];
  /** How often to be in touch: `2w`, `none`, or undefined when nothing says. */
  cadence?: string;
  warnings: string[];
}

const NONE = "none";

/** The `extends:` chain of `e`, nearest first, cut at cycles, unknown notes and `MAX_EXTENDS_DEPTH`. */
function chainOf(vault: Vault, e: Entity, warnings: string[]): Entity[] {
  const chain: Entity[] = [];
  const seen = new Set([e.slug]);
  for (let ref = e.fm.extends, from = e; ref; ref = from.fm.extends) {
    const parent = vault.resolve(unwrapLink(ref));
    if (!parent) {
      warnings.push(`${from.slug} extends "${unwrapLink(ref)}", which doesn't exist`);
      break;
    }
    if (seen.has(parent.slug)) {
      warnings.push(`${e.slug}: extends cycle at ${parent.slug}; ignoring the repeat`);
      break;
    }
    if (chain.length >= MAX_EXTENDS_DEPTH) {
      warnings.push(`${e.slug}: extends chain deeper than ${MAX_EXTENDS_DEPTH}; ignoring ${parent.slug} and above`);
      break;
    }
    chain.push(parent);
    seen.add(parent.slug);
    from = parent;
  }
  return chain;
}

function mixinsOf(vault: Vault, e: Entity, skip: Set<string>): Entity[] {
  const out: Entity[] = [];
  for (const tag of e.fm.tags) {
    const m = vault.entities.get(tag.toLowerCase().replace(/^#/, ""));
    if (!m || skip.has(m.slug) || !vault.schema.type(m.fm.type)?.inheritable) continue;
    skip.add(m.slug);
    out.push(m);
  }
  return out;
}

/**
 * The cadence of `own`, else of its candidates (the chain's nearest, mixins, groups it's a `member_of`): any
 * `none` wins (someone said not to keep in touch), else the most common value, the shortest on a tie.
 */
export function meshCadence(own: string | undefined, candidates: (string | undefined)[], warnings: string[] = []): string | undefined {
  const norm = (c: string | undefined) => c?.trim().toLowerCase() || undefined;
  if (norm(own)) return norm(own);
  const values: string[] = [];
  for (const raw of candidates) {
    const c = norm(raw);
    if (!c) continue;
    if (c !== NONE && parseDuration(c) === undefined) {
      warnings.push(`cadence "${raw}" isn't a duration like 2w, 1m or none; ignored`);
      continue;
    }
    values.push(c);
  }
  if (values.includes(NONE)) return NONE;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || parseDuration(a[0])! - parseDuration(b[0])! || a[0].localeCompare(b[0]))[0]?.[0];
}

/** What `e` inherits from the notes it `extends` and the inheritable notes its tags name. The entity's own values win. */
export function resolveInheritance(vault: Vault, e: Entity): Inheritance {
  const warnings: string[] = [];
  const chain = chainOf(vault, e, warnings);
  const mixins = mixinsOf(vault, e, new Set([e.slug, ...chain.map((c) => c.slug)]));

  const defaults: Record<string, FactValue> = {};
  for (const src of [...[...mixins].reverse(), ...[...chain].reverse(), e]) Object.assign(defaults, src.fm.defaults ?? {});

  const guidelines: InheritedGuideline[] = [];
  const seen = new Set<string>();
  for (const src of [e, ...chain, ...mixins]) {
    for (const g of src.fm.guidelines ?? []) {
      const key = `${normalizeName(g.rule)}@${normalizeScope(g.scope ?? "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      guidelines.push({ ...g, source: src.slug });
    }
  }

  const groups = e.fm.relations
    .filter((r) => r.rel === "member_of")
    .map((r) => vault.resolve(r.target))
    .filter((g): g is Entity => !!g);
  // Along the `extends:` chain the nearest cadence wins (colleague's 1m over stranger's none), as
  // with every inherited value; only parallel sources (that one, mixins, groups) are meshed.
  const nearest = chain.find((c) => c.fm.cadence?.trim())?.fm.cadence;
  const cadence = meshCadence(
    e.fm.cadence,
    [nearest, ...[...mixins, ...groups].map((c) => c.fm.cadence)],
    warnings,
  );
  return { chain, mixins, defaults, guidelines, ...(cadence ? { cadence } : {}), warnings };
}
