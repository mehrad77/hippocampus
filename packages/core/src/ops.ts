import { getObjectives, setObjectives, type Entity } from "./entity.ts";
import { reconcileFact, type Decision } from "./reconcile.ts";
import { QuestStatus, type Clock, type FactValue } from "./schema.ts";
import { encryptSecret, isSecretRef, secretPath, secretRef } from "./secrets.ts";
import { normalizeName, toFieldName } from "./text.ts";
import { VaultError, type Dispute, type Vault } from "./vault.ts";
import { link, unwrapLink } from "./wikilink.ts";

/** Who asserted a change, when, and which episodes back it. */
export interface Provenance {
  by: string;
  at: string;
  src: string[];
}

export interface FactResult {
  entity: string;
  field: string;
  decision: Decision["action"];
  reason?: string;
  secret?: boolean;
}

export async function applyFact(
  vault: Vault,
  entity: Entity,
  rawField: string,
  value: FactValue,
  prov: Provenance,
  opts: { secret?: boolean } = {},
): Promise<FactResult> {
  const field = toFieldName(rawField);
  const secretFields = vault.config.types[entity.fm.type]?.secret_fields ?? [];
  const secret = opts.secret || secretFields.includes(field) || isSecretRef(entity.fm.facts[field]?.value);
  const incomingAuthority = vault.authorityOf(prov.by, entity);

  if (secret) {
    // Ciphertext can't be compared, so secrets are last-writer-wins among trusted sources.
    const ref = secretRef(entity.slug, field);
    const recipient = vault.config.secrets.recipient;
    if (!recipient) {
      vault.warnings.push(`secret ${entity.slug}.${field} not stored: set secrets.recipient in _hippo/config.yaml (hippo secrets keygen)`);
      return { entity: entity.slug, field, decision: "keep", reason: "no secrets recipient configured", secret };
    }
    vault.writeFile(secretPath(vault.config.folders.secrets, ref), await encryptSecret(recipient, String(value)));
    entity.fm.facts[field] = {
      value: ref,
      status: incomingAuthority === "none" ? "rumor" : "canon",
      by: prov.by,
      at: prov.at,
      src: prov.src,
    };
    vault.touch(entity);
    return { entity: entity.slug, field, decision: "replace", reason: "secret updated", secret };
  }

  const existing = entity.fm.facts[field];
  const decision = reconcileFact({
    existing,
    incoming: { value, by: prov.by, at: prov.at, src: prov.src },
    incomingAuthority,
    existingAuthority: existing ? vault.authorityOf(existing.by, entity) : "none",
    canonThreshold: vault.config.curator.canon_threshold,
  });
  entity.fm.facts[field] = decision.fact;
  if (decision.action === "dispute") vault.openDispute(entity, field, decision.claims);
  if (decision.action === "replace" && existing?.status === "disputed") {
    const d = vault.disputes.get(vault.disputeSlug(entity.slug, field));
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

export function addRelation(vault: Vault, from: Entity, rel: string, to: Entity, prov: Provenance): boolean {
  const relName = toFieldName(rel);
  const exists = from.fm.relations.some((r) => r.rel === relName && vault.resolve(r.target)?.slug === to.slug);
  if (exists || from.slug === to.slug) return false;
  from.fm.relations.push({ rel: relName, target: link(to.slug), by: prov.by, src: prov.src });
  vault.touch(from);
  return true;
}

export interface QuestUpdate {
  status?: string;
  complete?: string[];
  /** Objectives to mark not done again (fuzzy-matched; unknown ones are ignored). */
  reopen?: string[];
  add?: string[];
  clock?: Partial<Clock> & { name: string; tick?: number };
  deadline?: string;
  owner?: string;
}

export function applyQuestUpdate(vault: Vault, quest: Entity, update: QuestUpdate, by: string): string[] {
  const changes: string[] = [];
  if (update.status) {
    const status = QuestStatus.safeParse(update.status.toLowerCase());
    if (status.success && quest.fm.status !== status.data) {
      quest.fm.status = status.data;
      changes.push(`status → ${status.data}`);
    }
  }
  if (update.deadline) {
    quest.fm.deadline = update.deadline;
    changes.push(`deadline → ${update.deadline}`);
  }
  if (update.owner) {
    const owner = vault.resolve(update.owner);
    quest.fm.owner = link(owner?.slug ?? unwrapLink(update.owner));
    changes.push(`owner → ${quest.fm.owner}`);
  }
  const objectives = getObjectives(quest);
  let touchedObjectives = false;
  for (const text of update.complete ?? []) {
    const target = matchObjective(objectives, text);
    if (target && !target.done) {
      target.done = true;
      touchedObjectives = true;
      changes.push(`✓ ${target.text}`);
    } else if (!target) {
      objectives.push({ text, done: true });
      touchedObjectives = true;
      changes.push(`✓ ${text} (new)`);
    }
  }
  for (const text of update.reopen ?? []) {
    const target = matchObjective(objectives, text);
    if (target?.done) {
      target.done = false;
      touchedObjectives = true;
      changes.push(`○ ${target.text}`);
    }
  }
  for (const text of update.add ?? []) {
    if (!matchObjective(objectives, text)) {
      objectives.push({ text, done: false });
      touchedObjectives = true;
      changes.push(`+ ${text}`);
    }
  }
  if (touchedObjectives) setObjectives(quest, objectives);
  if (update.clock) {
    const clocks = (quest.fm.clocks ??= []);
    const key = normalizeName(update.clock.name);
    let c = clocks.find((x) => normalizeName(x.name) === key);
    if (!c) {
      c = { name: update.clock.name, segments: update.clock.segments ?? 6, filled: 0 };
      clocks.push(c);
    }
    if (update.clock.segments) c.segments = update.clock.segments;
    if (update.clock.filled !== undefined) c.filled = update.clock.filled;
    if (update.clock.tick) c.filled = Math.max(0, Math.min(c.segments, c.filled + update.clock.tick));
    if (update.clock.deadline) c.deadline = update.clock.deadline;
    // Shrinking `segments` or an explicit `filled` must not leave a clock overfull.
    c.filled = Math.max(0, Math.min(c.segments, c.filled));
    changes.push(`clock ${c.name} ${c.filled}/${c.segments}`);
  }
  if (changes.length) vault.touch(quest, by);
  return changes;
}

function matchObjective<T extends { text: string }>(items: T[], text: string): T | undefined {
  const key = normalizeName(text);
  return (
    items.find((i) => normalizeName(i.text) === key) ??
    items.find((i) => normalizeName(i.text).includes(key) || key.includes(normalizeName(i.text)))
  );
}

/** Apply human rulings written into dispute notes (`ruling:`), making them canon. */
export function applyRulings(vault: Vault): string[] {
  const applied: string[] = [];
  for (const d of vault.openDisputes()) {
    if (d.fm.ruling === undefined || d.fm.ruling === null || d.fm.ruling === "") continue;
    const result = applyRuling(vault, d, d.fm.ruling);
    if (result) applied.push(result);
  }
  return applied;
}

/** Settle one dispute with `value` as canon by the human. Returns `entity.field = value`, or undefined if the entity is gone. */
export function applyRuling(vault: Vault, d: Dispute, value: FactValue, by = vault.config.human): string | undefined {
  const entity = vault.resolve(d.fm.entity);
  if (!entity) return undefined;
  const existing = entity.fm.facts[d.fm.field];
  d.fm.ruling = value;
  entity.fm.facts[d.fm.field] = {
    value,
    status: "canon",
    by,
    at: vault.nowIso(),
    src: [...new Set(d.fm.claims.flatMap((c) => c.src))],
    was: existing ? [...(existing.was ?? []), { value: existing.value, by: existing.by, at: existing.at }].slice(-5) : undefined,
  };
  vault.touch(entity, by);
  vault.resolveDispute(d);
  return `${entity.slug}.${d.fm.field} = ${value}`;
}

/** Whether a field holds (or must hold) a secret, so its value may never be written in plain text. */
export function isSecretField(vault: Vault, entity: Entity, field: string): boolean {
  if ((vault.config.types[entity.fm.type]?.secret_fields ?? []).includes(field)) return true;
  if (isSecretRef(entity.fm.facts[field]?.value)) return true;
  const d = vault.disputes.get(vault.disputeSlug(entity.slug, field));
  return !!d?.fm.claims.some((c) => isSecretRef(c.value));
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
 * The id an agent files under, normalized. Agents are their exact party slug: no alias or title
 * lookup, and never the human, whose word outranks everyone's.
 */
export function assertAgentId(vault: Vault, id: string): string {
  const norm = id.trim().toLowerCase();
  if (!AGENT_ID.test(norm)) throw new VaultError(`agent id "${id}" must be lowercase letters, digits and dashes`);
  if (vault.isHuman(norm)) throw new VaultError(`"${norm}" is the human, not an agent`);
  if ((RESERVED_AGENT_IDS as readonly string[]).includes(norm)) throw new VaultError(`"${norm}" is reserved, not an agent id`);
  return norm;
}

/** Add an agent to the party (`party/<id>.md`), as the human. */
export function addPartyMember(vault: Vault, input: NewPartyMember): Entity {
  const id = assertAgentId(vault, input.id);
  if (vault.entities.has(id)) throw new VaultError(`"${id}" already exists (${vault.entities.get(id)!.path})`);
  const known = new Set(vault.config.domains.map((d) => d.toLowerCase()));
  const authority = [...new Set((input.authority ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean))];
  const unknown = authority.filter((d) => !known.has(d));
  if (unknown.length) throw new VaultError(`unknown domain${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; known: ${vault.config.domains.join(", ") || "(none)"}`);
  const e = vault.createEntity({ type: "party", title: input.title.trim() || id, slug: id, by: vault.config.human });
  e.fm.lane = input.lane?.trim() || undefined;
  e.fm.authority = authority;
  e.fm.host = input.host?.trim() || undefined;
  return e;
}
