import type { Claim, Fact, FactValue } from "./schema.ts";
import { fold } from "./text.ts";
import type { Authority } from "./vault.ts";

export interface IncomingFact {
  value: FactValue;
  by: string;
  at: string;
  src: string[];
}

export type Decision =
  | { action: "create"; fact: Fact }
  | { action: "corroborate"; fact: Fact; promoted: boolean }
  | { action: "replace"; fact: Fact; reason: string }
  | { action: "dispute"; fact: Fact; claims: Claim[] }
  | { action: "keep"; fact: Fact; reason: string };

export interface ReconcileInput {
  existing?: Fact;
  incoming: IncomingFact;
  incomingAuthority: Authority;
  existingAuthority: Authority;
  /** Distinct agents needed to promote a rumor to canon. */
  canonThreshold: number;
}

export function sameValue(a: FactValue, b: FactValue): boolean {
  const norm = (v: FactValue) =>
    fold(String(v))
      .replace(/\s+/g, " ")
      .replace(/[.。]+$/, "")
      .trim();
  return norm(a) === norm(b);
}

const RANK: Record<Authority, number> = { none: 0, authority: 1, human: 2 };

/**
 * Archivist's rules, as a pure function. Precedence: human > lane authority > corroboration > recency.
 *
 * | existing ↓ / incoming →      | human   | authority | none        |
 * | ---------------------------- | ------- | --------- | ----------- |
 * | absent                       | canon   | canon     | rumor       |
 * | same value                   | confirm | promote   | corroborate |
 * | differs, existing by human   | replace | dispute   | dispute     |
 * | differs, existing authority  | replace | dispute   | keep        |
 * | differs, existing none       | replace | replace   | dispute     |
 * | differs, same author, newer  | replace (self-correction)          |
 * | existing disputed            | replace | add claim | add claim   |
 */
export function reconcileFact(input: ReconcileInput): Decision {
  const { existing, incoming, incomingAuthority, existingAuthority, canonThreshold } = input;
  const trusted = incomingAuthority !== "none";

  if (!existing || existing.status === "retconned") {
    return {
      action: "create",
      fact: {
        value: incoming.value,
        status: trusted ? "canon" : "rumor",
        by: incoming.by,
        at: incoming.at,
        src: [...incoming.src],
        ...(existing ? { was: [...(existing.was ?? []), prior(existing)] } : {}),
      },
    };
  }

  const claimOf = (f: { value: FactValue; by?: string; at?: string; src?: string[] }): Claim => ({
    value: f.value,
    by: f.by,
    at: f.at,
    src: [...(f.src ?? [])],
  });

  if (existing.status === "disputed") {
    if (incomingAuthority === "human") return replace(existing, incoming, "canon", "human ruling settles the dispute");
    return { action: "dispute", fact: { ...existing }, claims: [claimOf(incoming)] };
  }

  if (sameValue(existing.value, incoming.value)) {
    const seen = new Set([...existing.seen_by ?? [], existing.by ?? "human", incoming.by]);
    const promote =
      existing.status === "rumor" && (trusted || seen.size >= canonThreshold);
    const fact: Fact = {
      ...existing,
      at: latest(existing.at, incoming.at),
      src: [...new Set([...existing.src, ...incoming.src])],
      status: promote ? "canon" : existing.status,
    };
    if (fact.status === "rumor") fact.seen_by = [...seen];
    else delete fact.seen_by;
    if (incomingAuthority === "human") fact.by = incoming.by;
    return { action: "corroborate", fact, promoted: promote };
  }

  // Values differ.
  if (incomingAuthority === "human") return replace(existing, incoming, "canon", "human says otherwise");

  const sameAuthor = existing.by !== undefined && existing.by === incoming.by;
  if (sameAuthor && latest(existing.at, incoming.at) === incoming.at) {
    return replace(existing, incoming, trusted ? "canon" : existing.status, "source updated its own report");
  }

  if (RANK[incomingAuthority] > RANK[existingAuthority] && existing.status !== "canon") {
    return replace(existing, incoming, "canon", "authoritative source overrides rumor");
  }
  if (RANK[incomingAuthority] > RANK[existingAuthority]) {
    return replace(existing, incoming, "canon", `lane authority (${incoming.by}) overrides ${existing.by ?? "unknown"}`);
  }
  if (existingAuthority === "authority" && incomingAuthority === "none") {
    return { action: "keep", fact: existing, reason: `${existing.by} has lane authority; ${incoming.by}'s claim not adopted` };
  }

  return {
    action: "dispute",
    fact: { ...existing, status: "disputed" },
    claims: [claimOf(existing), claimOf(incoming)],
  };
}

function prior(f: Fact) {
  return { value: f.value, by: f.by, at: f.at };
}

function replace(existing: Fact, incoming: IncomingFact, status: Fact["status"], reason: string): Decision {
  return {
    action: "replace",
    reason,
    fact: {
      value: incoming.value,
      status,
      by: incoming.by,
      at: incoming.at,
      src: [...incoming.src],
      was: [...(existing.was ?? []), prior(existing)].slice(-5),
    },
  };
}

function latest(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}
