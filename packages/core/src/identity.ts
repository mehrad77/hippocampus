import { displayName, type Entity } from "./entity.ts";
import type { FactValue } from "./schema.ts";
import { isSecretRef } from "./secrets.ts";
import { fold, parseFactKey } from "./text.ts";
import type { Dispute, Vault } from "./vault.ts";

// Identity keys (an email, a repo url) say which real-world thing a note is. A name alone still
// resolves as before; only a key match may add an alias, and only a key conflict raises a merge.

export interface IdentityMatch {
  entity: Entity;
  /** The identity-key field that matched (without scope). */
  field: string;
}

/** An identity value as compared: folded, whitespace-collapsed, without a trailing slash. */
export function identityValue(v: FactValue): string {
  return fold(String(v)).trim().replace(/\s+/g, " ").replace(/\/+$/, "");
}

/** The identity-key fields of `type`. */
export function identityFields(vault: Vault, type: string): string[] {
  return Object.entries(vault.schema.type(type)?.fields ?? {})
    .filter(([, def]) => def.identity_key)
    .map(([name]) => name);
}

/**
 * Entities whose identity keys match `facts` (raw field names or `facts:` keys): any note whose type
 * declares the same field an identity key, compared by `identityValue`. Secrets are never compared.
 */
export function matchIdentity(vault: Vault, type: string, facts: Record<string, FactValue>): IdentityMatch[] {
  const keys = new Set(identityFields(vault, type));
  const wanted = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(facts)) {
    const field = parseFactKey(k).field;
    if (!keys.has(field) || isSecretRef(v) || !String(v).trim()) continue;
    if (!wanted.has(field)) wanted.set(field, new Set());
    wanted.get(field)!.add(identityValue(v));
  }
  const out: IdentityMatch[] = [];
  if (!wanted.size) return out;
  for (const e of vault.entities.values()) {
    for (const [k, f] of Object.entries(e.fm.facts)) {
      const field = parseFactKey(k).field;
      const values = wanted.get(field);
      if (!values || f.status === "retconned" || isSecretRef(f.value) || !vault.schema.fieldDef(e.fm.type, field)?.identity_key) continue;
      if (values.has(identityValue(f.value)) && !out.some((m) => m.entity === e)) out.push({ entity: e, field });
    }
  }
  return out;
}

/** Ask the human whether `a` and `b` are one thing: a `kind: merge` dispute note. */
export function proposeMerge(vault: Vault, a: Entity, b: Entity, field: string): Dispute {
  const evidence = `${displayName(a)} and ${displayName(b)} share the same ${field}, which identifies one ${vault.schema.type(a.fm.type)?.label ?? a.fm.type}.`;
  return vault.openMerge(a, b, field, evidence);
}

/**
 * Whether a note of type `a` may be folded into one of type `b` when an identity key says they're one:
 * the same type, or types sharing a capability. A person and a company with the same email are not
 * one note; the human decides (a merge proposal).
 */
export function foldable(vault: Vault, a: string, b: string): boolean {
  if (a === b) return true;
  const caps = vault.schema.type(b)?.capabilities ?? [];
  return (vault.schema.type(a)?.capabilities ?? []).some((c) => caps.includes(c));
}

export interface Identified {
  entity?: Entity;
  /** `name`: the name resolved it; `key`: an identity key did (the caller may add the name as an alias). */
  via?: "name" | "key";
  /** Raised when the named note and the key's note differ. */
  merge?: Dispute;
  /** Several notes share the key: nothing is picked. */
  ambiguous?: Entity[];
  /** Notes of an unrelated type with the key: never picked, only proposed as a merge. */
  foreign?: IdentityMatch[];
}

/**
 * Which note a report is about, given the note its name resolved to (if any) and the facts it
 * carries. The name wins; a key that points at another note raises a merge proposal instead of
 * moving anything. Without a name, a key that matches exactly one note of a `foldable` type picks it;
 * notes of other types come back as `foreign`, for a merge proposal.
 */
export function identify(vault: Vault, type: string, named: Entity | undefined, facts: Record<string, FactValue>): Identified {
  const all = matchIdentity(vault, type, facts);
  if (named) {
    const other = all.find((m) => m.entity.slug !== named.slug);
    if (!other || all.some((m) => m.entity.slug === named.slug)) return { entity: named, via: "name" };
    return { entity: named, via: "name", merge: proposeMerge(vault, named, other.entity, other.field) };
  }
  const matches = all.filter((m) => foldable(vault, type, m.entity.fm.type));
  const foreign = all.filter((m) => !matches.includes(m));
  const other = foreign.length ? { foreign } : {};
  if (matches.length === 1) return { entity: matches[0]!.entity, via: "key", ...other };
  return matches.length ? { ambiguous: matches.map((m) => m.entity), ...other } : other;
}
