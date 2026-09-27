import { getObjectives, setObjectives, type Entity } from "./entity.ts";
import { reconcileFact, type Decision } from "./reconcile.ts";
import { QuestStatus, type Clock, type FactValue } from "./schema.ts";
import { encryptSecret, isSecretRef, secretPath, secretRef } from "./secrets.ts";
import { normalizeName, toFieldName } from "./text.ts";
import type { Vault } from "./vault.ts";
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
    const entity = vault.resolve(d.fm.entity);
    if (!entity) continue;
    const existing = entity.fm.facts[d.fm.field];
    entity.fm.facts[d.fm.field] = {
      value: d.fm.ruling,
      status: "canon",
      by: vault.config.human,
      at: vault.nowIso(),
      src: [...new Set(d.fm.claims.flatMap((c) => c.src))],
      was: existing ? [...(existing.was ?? []), { value: existing.value, by: existing.by, at: existing.at }].slice(-5) : undefined,
    };
    vault.touch(entity, vault.config.human);
    vault.resolveDispute(d);
    applied.push(`${entity.slug}.${d.fm.field} = ${d.fm.ruling}`);
  }
  return applied;
}
