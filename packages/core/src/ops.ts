import type { Entity } from "./entity.ts";
import { canonicalRelation } from "./config.ts";
import { AUTHORITY_RANK, capWas, priorOf, reconcileFact, sameValue, type Decision } from "./reconcile.ts";
import { applyGoalUpdate, goalProps, type Clock, type GoalUpdate } from "./goal.ts";
import type { FactValue } from "./schema.ts";
import { encryptSecret, isSecretRef, secretPath, secretRef } from "./secrets.ts";
import { factKey, hash, normalizeScope, parseFactKey, slugify, toFieldName } from "./text.ts";
import { VaultError, type Dispute, type Vault } from "./vault.ts";
import { link, unwrapLink } from "./wikilink.ts";

/** Who asserted a change, when, and which episodes back it. */
export interface Provenance {
  by: string;
  at: string;
  src: string[];
}

/** Why a secret wasn't stored: the vault has no `secrets.recipient`. The curator's next steps key off this text. */
export const NO_RECIPIENT = "no secrets recipient configured";

export interface FactResult {
  entity: string;
  /** The `facts:` key: the field, plus `@scope` when scoped. */
  field: string;
  decision: Decision["action"];
  reason?: string;
  secret?: boolean;
}

/** Qualifiers of one reported value. `scope` becomes part of the key (`field@scope`). */
export interface FactOptions {
  secret?: boolean;
  confidential?: boolean;
  scope?: string;
  validFrom?: string;
  validUntil?: string;
  confidence?: number;
  /** Why the value is believed, for a proposal the human reviews. */
  evidence?: string;
}

/** Whether `a` and `b` are the same source: the same agent, or the same human (a missing `by` is the primary human). */
function sameSource(vault: Vault, a: string | undefined, b: string | undefined): boolean {
  if (vault.isHuman(a) && vault.isHuman(b)) return vault.human(a) === vault.human(b);
  return a !== undefined && a === b;
}

export async function applyFact(
  vault: Vault,
  entity: Entity,
  rawField: string,
  value: FactValue,
  prov: Provenance,
  opts: FactOptions = {},
): Promise<FactResult> {
  const field = factKey(rawField, opts.scope);
  const def = vault.schema.fieldDef(entity.fm.type, parseFactKey(field).field);
  const secret = opts.secret || !!def?.secret || isSecretRef(entity.fm.facts[field]?.value);
  // A confidential (or identity-key) field marks its facts, so search, views and tables can tell without the schema.
  if (def?.confidential) opts = { ...opts, confidential: true };
  const incomingAuthority = vault.authorityOf(prov.by, entity, field);
  const humanIn = AUTHORITY_RANK[incomingAuthority] >= AUTHORITY_RANK.human;

  if (def?.human_only && !humanIn && secret) {
    // Ciphertext can't be compared, so the claim is stored encrypted beside the field's own secret
    // (`secrets/<entity>/<field>.<episode>.age`) and waits for the human as a proposal.
    const recipient = vault.config.secrets.recipient;
    if (!recipient) {
      vault.warnings.push(`proposal for ${entity.slug}.${field} from ${prov.by} not stored: set secrets.recipient in _hippo/config.yaml (hippo secrets keygen)`);
      return { entity: entity.slug, field, decision: "propose", reason: `only a human sets this field; ${NO_RECIPIENT}`, secret };
    }
    const suffix = slugify(prov.src[0] ?? `p-${hash(`${prov.by}|${prov.at}`)}`);
    const ref = secretRef(entity.slug, field);
    vault.writeFile(secretPath(vault.config.folders.secrets, ref, suffix), await encryptSecret(recipient, String(value)));
    vault.openProposal(entity, field, { value: `${ref}.${suffix}`, by: prov.by, at: prov.at, src: prov.src, ...confidenceOf(opts), ...(opts.confidential ? { confidential: true } : {}) }, opts.evidence);
    return { entity: entity.slug, field, decision: "propose", reason: "only a human sets this field", secret };
  }

  if (secret) {
    // Ciphertext can't be compared, so secrets are last-writer-wins among equals, but a lower-ranked
    // source never replaces what a higher-ranked one holds, secret or not: an agent marking a value
    // secret can't overwrite the human's plain one.
    const held = entity.fm.facts[field];
    const live = held && held.status !== "retconned" ? held : undefined;
    if (live && AUTHORITY_RANK[incomingAuthority] < AUTHORITY_RANK[vault.authorityOf(live.by, entity, field)]) {
      vault.warnings.push(`secret ${entity.slug}.${field} not replaced: ${prov.by} outranked by ${live.by ?? "the human"}`);
      return { entity: entity.slug, field, decision: "keep", reason: `${live.by ?? "the human"} outranks ${prov.by}`, secret };
    }
    const ref = secretRef(entity.slug, field);
    const recipient = vault.config.secrets.recipient;
    if (!recipient) {
      vault.warnings.push(`secret ${entity.slug}.${field} not stored: set secrets.recipient in _hippo/config.yaml (hippo secrets keygen)`);
      return { entity: entity.slug, field, decision: "keep", reason: NO_RECIPIENT, secret };
    }
    vault.writeFile(secretPath(vault.config.folders.secrets, ref), await encryptSecret(recipient, String(value)));
    entity.fm.facts[field] = {
      value: ref,
      status: incomingAuthority === "none" ? "rumor" : "canon",
      by: prov.by,
      at: prov.at,
      src: prov.src,
      ...qualifiersOf(opts),
      ...(held?.confidential ? { confidential: true } : {}),
      ...(held ? { was: capWas([...(held.was ?? []), priorOf(held, "replaced")]) } : {}),
    };
    vault.touch(entity);
    return { entity: entity.slug, field, decision: "replace", reason: "secret updated", secret };
  }

  const existing = entity.fm.facts[field];
  const open = existing?.status === "disputed" ? vault.disputeFor(entity.slug, field) : undefined;
  const decision = reconcileFact({
    existing,
    incoming: { value, by: prov.by, at: prov.at, src: prov.src, ...qualifiersOf(opts) },
    incomingAuthority,
    existingAuthority: existing ? vault.authorityOf(existing.by, entity, field) : "none",
    canonThreshold: vault.config.curator.canon_threshold,
    def,
    sameAuthor: !!existing && sameSource(vault, existing.by, prov.by),
    ...(open?.fm.status === "open"
      ? { disputeClaims: open.fm.claims.map((c) => ({ authority: vault.authorityOf(c.by, entity, field), sameAuthor: sameSource(vault, c.by, prov.by) })) }
      : {}),
  });
  if (decision.action === "propose") {
    vault.openProposal(entity, field, decision.claim, opts.evidence);
    return { entity: entity.slug, field, decision: decision.action, reason: decision.reason };
  }
  const fact = decision.fact;
  // A confidential claim that disputes a value doesn't make that value confidential: the claim says so itself.
  if (opts.confidential && decision.action !== "keep" && decision.action !== "dispute") fact.confidential = true;
  entity.fm.facts[field] = fact;
  if (decision.action === "dispute") vault.openDispute(entity, field, decision.claims);
  if ((decision.action === "replace" || decision.action === "succeed") && existing?.status === "disputed") {
    const d = vault.disputeFor(entity.slug, field);
    if (d && d.fm.status === "open") vault.resolveDispute(d);
  }
  if (decision.action !== "keep") vault.touch(entity);
  return {
    entity: entity.slug,
    field,
    decision: decision.action,
    reason: "reason" in decision ? decision.reason : undefined,
  };
}

const confidenceOf = (opts: FactOptions) => (opts.confidence !== undefined ? { confidence: opts.confidence } : {});

function qualifiersOf(opts: FactOptions) {
  return {
    ...(opts.validFrom ? { valid_from: opts.validFrom } : {}),
    ...(opts.validUntil ? { valid_until: opts.validUntil } : {}),
    ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
    ...(opts.confidential ? { confidential: true } : {}),
  };
}

/**
 * The human withdraws a value: the fact becomes `retconned`, which reconcile treats as absent, so the
 * next report starts it over (keeping this value in `was`). Any open dispute about it closes.
 */
export function retractFact(vault: Vault, entity: Entity, rawField: string, by: string, opts: { scope?: string } = {}): string {
  if (!vault.isHuman(by)) throw new VaultError(`only a human can retract a fact; "${by}" is not one`);
  const field = factKey(rawField, opts.scope);
  const f = entity.fm.facts[field];
  if (!f) throw new VaultError(`${entity.slug} has no fact "${field}"`);
  if (f.status === "retconned") throw new VaultError(`${entity.slug}.${field} is already retracted`);
  f.status = "retconned";
  delete f.seen_by;
  const d = vault.disputeFor(entity.slug, field);
  if (d && d.fm.status === "open") vault.resolveDispute(d);
  vault.touch(entity, vault.human(by)?.id ?? by);
  return field;
}

export interface RelationOptions {
  role?: string;
  scope?: string;
  validFrom?: string;
  validUntil?: string;
}

/**
 * Link `from` to `to`. A relation is the same when rel, target, scope and role all match. A declared
 * inverse name (`used_by` of `depends_on`) is stored as its forward relation, from `to` to `from`.
 */
export function addRelation(vault: Vault, from: Entity, rel: string, to: Entity, prov: Provenance, opts: RelationOptions = {}): boolean {
  const canon = canonicalRelation(vault.config, toFieldName(rel));
  const [src, dst] = canon.flip ? [to, from] : [from, to];
  const scope = opts.scope ? normalizeScope(opts.scope) || undefined : undefined;
  const role = opts.role?.trim() || undefined;
  const exists = src.fm.relations.some(
    (r) => r.rel === canon.rel && (r.scope ?? undefined) === scope && (r.role ?? undefined) === role && vault.resolve(r.target)?.slug === dst.slug,
  );
  if (exists || src.slug === dst.slug) return false;
  src.fm.relations.push({
    rel: canon.rel,
    target: link(dst.slug),
    ...(role ? { role } : {}),
    ...(scope ? { scope } : {}),
    ...(opts.validFrom ? { valid_from: opts.validFrom } : {}),
    ...(opts.validUntil ? { valid_until: opts.validUntil } : {}),
    by: prov.by,
    src: prov.src,
  });
  vault.touch(src);
  return true;
}

/** @deprecated v1 shape of `GoalUpdate`: a named clock and a `deadline`. */
export interface QuestUpdate {
  status?: string;
  complete?: string[];
  /** Objectives to mark not done again (fuzzy-matched; unknown ones are ignored). */
  reopen?: string[];
  add?: string[];
  /** A goal has one progress now: any clock name updates it (`segments` → total, `filled` → done). */
  clock?: Partial<Clock> & { name: string; tick?: number };
  deadline?: string;
  owner?: string;
}

/** The v1 update in goal terms: a clock becomes `progress`, a deadline (the update's, else the clock's) `due`. */
export function questToGoalUpdate(goal: Entity, update: QuestUpdate): GoalUpdate {
  const { clock, deadline, ...rest } = update;
  const out: GoalUpdate = { ...rest };
  if (clock) {
    // A clock new to the goal started at 6 segments; keep that default for callers that don't say.
    const total = clock.segments ?? (goalProps(goal).progress ? undefined : 6);
    out.progress = { total, done: clock.filled, tick: clock.tick };
  }
  const due = deadline ?? clock?.deadline;
  if (due) out.due = due;
  return out;
}

/** @deprecated Use `applyGoalUpdate`. */
export function applyQuestUpdate(vault: Vault, quest: Entity, update: QuestUpdate, by: string): string[] {
  return applyGoalUpdate(vault, quest, questToGoalUpdate(quest, update), by);
}

/**
 * Apply what the human wrote into dispute notes: a `ruling:` makes its value canon (conflicts and
 * proposals alike), `state: declined` closes a proposal or merge without a change, and a pending
 * proposal whose value the human has since set themselves closes as `already_present`.
 * Merges are only closed here; merging two notes is the human's to do.
 */
export function applyRulings(vault: Vault): string[] {
  const applied: string[] = [];
  for (const d of vault.openDisputes()) {
    if (d.fm.state === "declined" && (d.fm.kind === "proposal" || d.fm.kind === "merge")) {
      declineProposal(vault, d);
      applied.push(`${unwrapLink(d.fm.entity)}.${d.fm.field}: declined`);
      continue;
    }
    if (d.fm.kind === "merge") continue;
    if (d.fm.ruling === undefined || d.fm.ruling === null || d.fm.ruling === "") {
      if (d.fm.kind === "proposal" && settleIfPresent(vault, d)) applied.push(`${unwrapLink(d.fm.entity)}.${d.fm.field}: already present`);
      continue;
    }
    const result = applyRuling(vault, d, d.fm.ruling);
    if (result) applied.push(result);
  }
  return applied;
}

/** A pending proposal the human has made moot by setting the same value: closed as `already_present`. */
function settleIfPresent(vault: Vault, d: Dispute): boolean {
  const entity = vault.resolve(d.fm.entity);
  const f = entity?.fm.facts[d.fm.field];
  if (!f || f.status === "retconned" || !vault.isHuman(f.by)) return false;
  if (!d.fm.claims.some((c) => !isSecretRef(c.value) && sameValue(c.value, f.value))) return false;
  d.fm.state = "already_present";
  vault.resolveDispute(d);
  return true;
}

/** Settle one dispute with `value` as canon by the human. Returns `entity.field = value`, or undefined if the entity is gone. */
export function applyRuling(vault: Vault, d: Dispute, value: FactValue, by = vault.config.human): string | undefined {
  const entity = vault.resolve(d.fm.entity);
  if (!entity) return undefined;
  if (d.fm.kind === "merge") throw new VaultError(`${d.slug} is a possible duplicate, not a value: merge the notes by hand, or decline it`);
  const existing = entity.fm.facts[d.fm.field];
  // A confidential claim stays confidential once it's the value.
  const confidential = !!existing?.confidential || d.fm.claims.some((c) => c.confidential && String(c.value) === String(value));
  d.fm.ruling = value;
  entity.fm.facts[d.fm.field] = {
    value,
    status: "canon",
    by,
    at: vault.nowIso(),
    src: [...new Set(d.fm.claims.flatMap((c) => c.src))],
    was: existing ? capWas([...(existing.was ?? []), priorOf(existing, "ruled")]) : undefined,
    ...(confidential ? { confidential: true } : {}),
  };
  if (d.fm.kind === "proposal") d.fm.state = "applied";
  vault.touch(entity, by);
  vault.resolveDispute(d);
  return `${entity.slug}.${d.fm.field} = ${value}`;
}

/** The human turns a proposal (or a possible merge) down: it closes as `declined`, and nothing changes. */
export function declineProposal(vault: Vault, d: Dispute): void {
  if (d.fm.kind !== "proposal" && d.fm.kind !== "merge") throw new VaultError(`${d.slug} is a conflict between sources: it needs a ruling, not a decline`);
  d.fm.state = "declined";
  vault.resolveDispute(d);
}

/** Whether a field holds (or must hold) a secret, so its value may never be written in plain text. */
export function isSecretField(vault: Vault, entity: Entity, field: string): boolean {
  if (vault.schema.isSecretField(entity.fm.type, field)) return true;
  if (isSecretRef(entity.fm.facts[field]?.value)) return true;
  // A proposal's encrypted claim makes the field secret too, so it's never ruled in plain text.
  return [vault.disputeFor(entity.slug, field), vault.disputeFor(entity.slug, field, "proposal")].some((d) => !!d?.fm.claims.some((c) => isSecretRef(c.value)));
}

export interface NewPartyMember {
  id: string;
  title: string;
  lane?: string;
  authority?: string[];
  host?: string;
}

/** Same rule as agent ids in the Worker's OAuth consent, so ids work everywhere. */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Names that stand for the human, the curator or a missing author in provenance, so no agent may file under them. */
export const RESERVED_AGENT_IDS = ["human", "curator", "unknown", "hippocampus"] as const;

/**
 * How an agent names itself, told to every agent (server instructions, tool descriptions, the
 * Handbook). One connection usually serves one app with several agents in it, so the name is the
 * agent's own, not the app's.
 */
export const AGENT_NAMING =
  "Name yourself `<platform>-<role>`: lowercase letters, digits and dashes, like `claude-code-home-finder` or `grok-bot-trip-planner`. Use the same id in every session and every call. Never a person's name, `human`, `curator`, `unknown` or `hippocampus`, and never an id another app uses.";

/** How many agents may seat themselves (`introduce`): a shared key can invent names, and each makes a card. */
export const SELF_SEATED_LIMIT = 50;

/**
 * The id an agent files under, normalized. Agents are their exact party slug: no alias or title
 * lookup, and never the human, whose word outranks everyone's.
 */
export function assertAgentId(vault: Vault, id: string): string {
  const norm = id.trim().toLowerCase();
  if (!AGENT_ID.test(norm)) throw new VaultError(`agent id "${id}" must be lowercase letters, digits and dashes`);
  if (vault.isHuman(norm)) throw new VaultError(`"${norm}" is ${vault.config.humans.length > 1 ? "one of the humans" : "the human"}, not an agent`);
  if ((RESERVED_AGENT_IDS as readonly string[]).includes(norm)) throw new VaultError(`"${norm}" is reserved, not an agent id`);
  return norm;
}

/** Add an agent to the party (a note of the vault's actor type, e.g. `party/<id>.md`), as the human. */
export function addPartyMember(vault: Vault, input: NewPartyMember): Entity {
  const id = assertAgentId(vault, input.id);
  const type = vault.schema.defaultTypeFor("actor");
  if (!type) throw new VaultError("no entity type has the actor capability, so agents have nowhere to go");
  if (vault.entities.has(id)) throw new VaultError(`"${id}" already exists (${vault.entities.get(id)!.path})`);
  const authority = knownDomains(vault, input.authority ?? []);
  const e = vault.createEntity({ type, title: input.title.trim() || id, slug: id, by: vault.config.human });
  e.fm.lane = input.lane?.trim() || undefined;
  e.fm.authority = authority;
  e.fm.host = input.host?.trim() || undefined;
  return e;
}

/** `domains`, lowercased and each once, all from the vault's `domains:`; throws naming any that aren't. */
export function knownDomains(vault: Vault, domains: string[]): string[] {
  const known = new Set(vault.config.domains.map((d) => d.toLowerCase()));
  const out = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  const unknown = out.filter((d) => !known.has(d));
  if (unknown.length) throw new VaultError(`unknown domain${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; known: ${vault.config.domains.join(", ") || "(none)"}`);
  return out;
}

/** What an agent says about itself on its own card. */
export const SELF_CARD_FIELDS = ["lane", "host", "model"] as const;

/**
 * An agent seats itself (`introduce`): its own card, as itself, with no authority, so its word stays a
 * rumor until the human gives it some. On a card it already has, it only fills in what's blank, never
 * over the human's edits. Returns the card, and the fields it filled.
 */
export function seatSelf(vault: Vault, agent: string, input: { title: string; lane?: string; host?: string; model?: string; about?: string }): { card: Entity; created: boolean; filled: string[] } {
  const id = assertAgentId(vault, agent);
  const line = (v: string | undefined) => v?.replace(/\s+/g, " ").trim() || undefined;
  const own: Record<(typeof SELF_CARD_FIELDS)[number], string | undefined> = { lane: line(input.lane), host: line(input.host), model: line(input.model) };
  const existing = vault.actorMember(id);
  if (existing) {
    const filled = SELF_CARD_FIELDS.filter((k) => own[k] && !existing.fm[k]);
    for (const k of filled) existing.fm[k] = own[k];
    if (filled.length) vault.markDirty(existing);
    return { card: existing, created: false, filled };
  }
  const type = vault.schema.defaultTypeFor("actor");
  if (!type) throw new VaultError("no entity type has the actor capability, so agents have nowhere to go");
  if (vault.entities.has(id)) throw new VaultError(`"${id}" is already a note (${vault.entities.get(id)!.path}); name yourself something else`);
  if (vault.withCapability("actor").length >= SELF_SEATED_LIMIT) throw new VaultError(`the vault already has ${SELF_SEATED_LIMIT} agents; ask the person to remove some on the Agents page`);
  const card = vault.createEntity({ type, title: line(input.title) || id, slug: id, by: id });
  for (const k of SELF_CARD_FIELDS) if (own[k]) card.fm[k] = own[k];
  card.fm.authority = [];
  const about = input.about?.trim();
  if (about) card.body = `${card.body.replace(/\s+$/, "")}\n\n## About\n\n${about}\n`;
  return { card, created: true, filled: [] };
}

/** The human sets what an agent is responsible for: its authority domains, from the vault's own. */
export function setAuthority(vault: Vault, agent: string, domains: string[]): Entity {
  const id = assertAgentId(vault, agent);
  const card = vault.actorMember(id);
  if (!card) throw new VaultError(`"${id}" isn't one of this vault's agents yet`);
  card.fm.authority = knownDomains(vault, domains);
  vault.markDirty(card);
  return card;
}
