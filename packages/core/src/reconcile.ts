import type { Claim, Fact, FactValue, FieldDef, PriorValue, PriorWhy } from "./schema.ts";
import { fold } from "./text.ts";
import type { Authority } from "./vault.ts";

export interface IncomingFact {
  value: FactValue;
  by: string;
  at: string;
  src: string[];
  /** When the value started or stopped being true, if the report says. */
  valid_from?: string;
  valid_until?: string;
  confidence?: number;
}

export type Decision =
  | { action: "create"; fact: Fact }
  | { action: "corroborate"; fact: Fact; promoted: boolean }
  | { action: "replace"; fact: Fact; reason: string }
  | { action: "dispute"; fact: Fact; claims: Claim[] }
  | { action: "keep"; fact: Fact; reason: string }
  /** A succession field moved on: the old value is closed (`valid_until`) and kept in `was`. */
  | { action: "succeed"; fact: Fact; reason: string }
  /** A succession field heard an older value: it goes into `was`; the current value stays. */
  | { action: "backfill"; fact: Fact; reason: string }
  /** A `human_only` field reported by someone else: the fact is untouched, the claim waits for the human. */
  | { action: "propose"; fact: Fact | undefined; claim: Claim; reason: string };

export interface ReconcileInput {
  existing?: Fact;
  incoming: IncomingFact;
  incomingAuthority: Authority;
  existingAuthority: Authority;
  /** Distinct agents needed to promote a rumor to canon. */
  canonThreshold: number;
  /** The field's definition, for `succession` and `human_only`. */
  def?: FieldDef;
  /**
   * Whether the existing value and the incoming one come from the same source. Callers that know
   * the humans pass it, since a missing `by` is the primary human; otherwise `by` must match.
   */
  sameAuthor?: boolean;
}

export function sameValue(a: FactValue, b: FactValue): boolean {
  const norm = (v: FactValue) =>
    fold(String(v))
      .replace(/\s+/g, " ")
      .replace(/[.。]+$/, "")
      .trim();
  return norm(a) === norm(b);
}

export const AUTHORITY_RANK: Record<Authority, number> = { none: 0, authority: 1, human: 2, human_domain: 3 };
const RANK = AUTHORITY_RANK;
const isHumanRank = (a: Authority) => RANK[a] >= RANK.human;

/** Prior values kept per fact. */
export const MAX_WAS = 5;

/**
 * Archivist's rules, as a pure function. Precedence: human (with the domain, then any) > lane
 * authority > corroboration > recency. "Human" columns are any of the vault's humans; a human whose
 * domains cover the entity or field (`human_domain`) outranks the others.
 *
 * | existing ↓ / incoming →                     | human               | authority | none        |
 * | ------------------------------------------- | ------------------- | --------- | ----------- |
 * | absent                                      | canon               | canon     | rumor       |
 * | same value                                  | confirm             | promote   | corroborate |
 * | differs, existing by human                  | see two humans ↓    | dispute   | dispute     |
 * | differs, existing authority                 | replace             | dispute   | keep        |
 * | differs, existing none                      | replace             | replace   | dispute     |
 * | differs, same author, newer                 | replace (self-correction, prior `why: retconned`)    |
 * | existing disputed                           | replace¹            | add claim | add claim   |
 * | two humans: same human                      | replace             |           |             |
 * | two humans: incoming has the domain         | replace             |           |             |
 * | two humans: existing has the domain         | keep                |           |             |
 * | two humans: equal rank                      | dispute             |           |             |
 * | succession field, newer, rank ≥ existing,   | succeed: old value closed (`valid_until`) into  |
 * |   existing not human-held²                  |   `was` with `why: succeeded`                   |
 * | succession field, older than existing       | backfill into `was`; current value stays        |
 * | human_only field, incoming not human        | propose: fact untouched (same value corroborates) |
 * | different scopes (`field@scope`)            | never compared: each scope is its own key       |
 *
 * ¹ Unless the dispute's value is held by another human of equal or higher rank: then it adds a claim.
 * ² Succession never closes a human-held value (it disputes as above), except by that same human.
 */
export function reconcileFact(input: ReconcileInput): Decision {
  const { existing, incoming, incomingAuthority, existingAuthority, canonThreshold, def } = input;
  const trusted = incomingAuthority !== "none";
  const humanIn = isHumanRank(incomingAuthority);
  const humanHeld = isHumanRank(existingAuthority);
  const live = existing && existing.status !== "retconned" ? existing : undefined;
  const sameAuthor = input.sameAuthor ?? (existing?.by !== undefined && existing.by === incoming.by);

  if (def?.human_only && !humanIn && !(live && sameValue(live.value, incoming.value))) {
    return { action: "propose", fact: existing, claim: claimOf(incoming), reason: `only a human sets this field; ${incoming.by}'s value waits for them` };
  }

  if (!live) {
    return {
      action: "create",
      fact: {
        ...fresh(incoming, trusted ? "canon" : "rumor"),
        ...(existing ? { was: capWas([...(existing.was ?? []), priorOf(existing)]) } : {}),
      },
    };
  }

  if (live.status === "disputed") {
    if (humanIn && (RANK[incomingAuthority] > RANK[existingAuthority] || sameAuthor)) return replace(live, incoming, "canon", "human ruling settles the dispute");
    return { action: "dispute", fact: { ...live }, claims: [claimOf(incoming)] };
  }

  if (sameValue(live.value, incoming.value)) {
    const seen = new Set([...(live.seen_by ?? []), live.by ?? "human", incoming.by]);
    const promote = live.status === "rumor" && (trusted || seen.size >= canonThreshold);
    const fact: Fact = {
      ...live,
      at: latest(live.at, incoming.at),
      src: [...new Set([...live.src, ...incoming.src])],
      status: promote ? "canon" : live.status,
    };
    if (fact.status === "rumor") fact.seen_by = [...seen];
    else delete fact.seen_by;
    if (humanIn) fact.by = incoming.by;
    return { action: "corroborate", fact, promoted: promote };
  }

  // Values differ.
  const newer = latest(live.at, incoming.at) === incoming.at;
  if (def?.succession) {
    const inTime = incoming.valid_from ?? incoming.at;
    const exTime = live.valid_from ?? live.at;
    if (exTime && inTime < exTime) return backfill(live, incoming);
    const later = !exTime || inTime > exTime;
    if (later && RANK[incomingAuthority] >= RANK[existingAuthority] && (!humanHeld || sameAuthor)) {
      return succeed(live, incoming, trusted ? "canon" : "rumor");
    }
  }

  if (humanIn) {
    if (!humanHeld) return replace(live, incoming, "canon", "human says otherwise");
    if (sameAuthor) return replace(live, incoming, "canon", "human corrected their own value", newer ? "retconned" : "replaced");
    if (RANK[incomingAuthority] > RANK[existingAuthority]) return replace(live, incoming, "canon", `${incoming.by} has the domain; overrides ${live.by ?? "the human"}`);
    if (RANK[incomingAuthority] < RANK[existingAuthority]) {
      return { action: "keep", fact: live, reason: `${live.by ?? "the human"} has the domain; ${incoming.by}'s value not adopted` };
    }
    return dispute(live, incoming);
  }

  if (sameAuthor && newer) {
    return replace(live, incoming, trusted ? "canon" : live.status, "source updated its own report", "retconned");
  }

  if (RANK[incomingAuthority] > RANK[existingAuthority] && live.status !== "canon") {
    return replace(live, incoming, "canon", "authoritative source overrides rumor");
  }
  if (RANK[incomingAuthority] > RANK[existingAuthority]) {
    return replace(live, incoming, "canon", `lane authority (${incoming.by}) overrides ${live.by ?? "unknown"}`);
  }
  if (existingAuthority === "authority" && incomingAuthority === "none") {
    return { action: "keep", fact: live, reason: `${live.by} has lane authority; ${incoming.by}'s claim not adopted` };
  }

  return dispute(live, incoming);
}

function claimOf(f: { value: FactValue; by?: string; at?: string; src?: string[]; confidence?: number }): Claim {
  return { value: f.value, by: f.by, at: f.at, src: [...(f.src ?? [])], ...(f.confidence !== undefined ? { confidence: f.confidence } : {}) };
}

function dispute(existing: Fact, incoming: IncomingFact): Decision {
  return { action: "dispute", fact: { ...existing, status: "disputed" }, claims: [claimOf(existing), claimOf(incoming)] };
}

/** Undefined qualifiers left out, so notes only carry what is known. */
function qualifiers(f: { valid_from?: string; valid_until?: string; confidence?: number }) {
  return {
    ...(f.valid_from !== undefined ? { valid_from: f.valid_from } : {}),
    ...(f.valid_until !== undefined ? { valid_until: f.valid_until } : {}),
    ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
  };
}

function fresh(incoming: IncomingFact, status: Fact["status"]): Fact {
  return { value: incoming.value, status, by: incoming.by, at: incoming.at, src: [...incoming.src], ...qualifiers(incoming) };
}

export function priorOf(f: Pick<Fact, "value" | "by" | "at" | "valid_from" | "valid_until">, why?: PriorWhy, validUntil?: string): PriorValue {
  const until = validUntil ?? f.valid_until;
  return {
    value: f.value,
    by: f.by,
    at: f.at,
    ...(f.valid_from !== undefined ? { valid_from: f.valid_from } : {}),
    ...(until !== undefined ? { valid_until: until } : {}),
    ...(why ? { why } : {}),
  };
}

/** Oldest dropped first. */
export const capWas = (was: PriorValue[]) => was.slice(-MAX_WAS);

const keepConfidential = (existing: Fact) => (existing.confidential ? { confidential: true } : {});

function replace(existing: Fact, incoming: IncomingFact, status: Fact["status"], reason: string, why: PriorWhy = "replaced"): Decision {
  return {
    action: "replace",
    reason,
    fact: { ...fresh(incoming, status), ...keepConfidential(existing), was: capWas([...(existing.was ?? []), priorOf(existing, why)]) },
  };
}

function succeed(existing: Fact, incoming: IncomingFact, status: Fact["status"]): Decision {
  const closed = priorOf(existing, "succeeded", existing.valid_until ?? incoming.valid_from ?? incoming.at);
  return {
    action: "succeed",
    reason: `${incoming.value} succeeds ${existing.value}`,
    fact: { ...fresh(incoming, status), ...keepConfidential(existing), was: capWas([...(existing.was ?? []), closed]) },
  };
}

function backfill(existing: Fact, incoming: IncomingFact): Decision {
  const was = existing.was ?? [];
  if (was.some((w) => sameValue(w.value, incoming.value))) {
    return { action: "keep", fact: existing, reason: `${incoming.value} is already in the history` };
  }
  const old = priorOf(incoming, "succeeded", incoming.valid_until ?? existing.valid_from ?? existing.at);
  // Closed values sort by when they ended, others by when they began or were seen.
  const time = (w: PriorValue) => w.valid_until ?? w.valid_from ?? w.at ?? "";
  const merged = [...was, old].sort((a, b) => time(a).localeCompare(time(b)));
  return { action: "backfill", reason: `${incoming.value} is older than ${existing.value}`, fact: { ...existing, was: capWas(merged) } };
}

function latest(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}
