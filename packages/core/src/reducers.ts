import type { Entity } from "./entity.ts";
import type { Episode } from "./episode.ts";
import { channelOf, countsAsContact } from "./kinds.ts";
import type { Provenance } from "./ops.ts";
import type { DecisionEntry, EpisodeData, Guideline, QuestionEntry, Stats } from "./schema.ts";
import type { ResolvedKind } from "./schema-registry.ts";
import { hash, localParts, normalizeName, normalizeScope } from "./text.ts";
import type { Vault } from "./vault.ts";
import type { ChronicleEntryView } from "./views.ts";
import { parseLinks } from "./wikilink.ts";

// Deterministic bookkeeping the curator applies after (or instead of) the LLM steps: contact stats,
// decision and question logs, guidelines. Each one changes frontmatter only; renderEntity draws the regions.

const emptyStats = (): Stats => ({ last: {}, counts: {} });
const later = (a: string | undefined, b: string) => (!a || b > a ? b : a);
const earlier = (a: string | undefined, b: string) => (!a || b < a ? b : a);

/** Entities an episode's stats are about: `data.with`, else `about`, else what it touched (never agents or humans). */
export function statsTargets(vault: Vault, ep: Pick<Episode, "about" | "data">, touched: Entity[]): Entity[] {
  const resolveAll = (refs: string[]) => refs.map((r) => vault.resolve(r)).filter((e): e is Entity => !!e);
  const withRefs = ep.data?.with === undefined ? [] : (Array.isArray(ep.data.with) ? ep.data.with : [ep.data.with]).map(String);
  const picked = withRefs.length ? resolveAll(withRefs) : ep.about.length ? resolveAll(ep.about) : touched;
  const out = new Map<string, Entity>();
  for (const e of picked) {
    if (vault.schema.has(e.fm.type, "actor") || vault.human(e.slug)) continue;
    out.set(e.slug, e);
  }
  return [...out.values()];
}

function countOn(vault: Vault, e: Entity, kind: ResolvedKind, at: string, data: EpisodeData | undefined): void {
  const st = (e.fm.stats ??= emptyStats());
  const date = localParts(at, vault.config.timezone).date;
  const channel = channelOf(data);
  for (const key of channel ? [kind.name, `${kind.name}/${channel}`] : [kind.name]) {
    st.counts[key] = (st.counts[key] ?? 0) + 1;
    st.last[key] = later(st.last[key], date);
  }
  st.first_met = earlier(st.first_met, date);
  if (countsAsContact(kind, channel)) st.last_contact = later(st.last_contact, date);
  vault.touch(e);
}

/**
 * Count one episode on the entities it's about: per kind and `kind/channel`, the latest date per
 * kind, the first date ever, and `last_contact` when the kind (or its channel) counts as contact.
 * Returns the slugs it updated.
 */
export function applyStats(vault: Vault, ep: Pick<Episode, "at" | "about" | "data">, kind: ResolvedKind, touched: Entity[]): string[] {
  const targets = statsTargets(vault, ep, touched);
  for (const e of targets) countOn(vault, e, kind, ep.at, ep.data);
  return targets.map((e) => e.slug);
}

/**
 * Recount every entity's stats from the chronicle (oldest first), replacing what frontmatter says.
 * An entry counts on the entities its text links (a data line's `with [[x]]`), else on what it touched.
 */
export function rebuildStats(vault: Vault, entries: ChronicleEntryView[]): string[] {
  for (const e of vault.entities.values()) {
    if (e.fm.stats) {
      e.fm.stats = undefined;
      vault.touch(e);
    }
  }
  const updated = new Set<string>();
  for (const entry of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    const [name = "observation", channel] = entry.kind.split("/");
    const kind = vault.schema.kind(name).def;
    const linked = parseLinks(entry.text).map((l) => l.target);
    const touched = entry.touched.map((t) => vault.resolve(t)).filter((e): e is Entity => !!e);
    const ep = { at: entry.at, about: linked, data: channel ? { channel } : undefined };
    for (const slug of applyStats(vault, ep, kind, touched)) updated.add(slug);
  }
  return [...updated];
}

/** Log a decision on an entity. The same decision (by its words) is updated in place; the oldest go past `decisions_cap`. */
export function logDecision(vault: Vault, e: Entity, input: { what: string; why?: string; alternatives?: string[]; revisit?: string }, prov: Provenance): DecisionEntry {
  const what = input.what.trim();
  const id = `dec-${hash(normalizeName(what))}`;
  const list = (e.fm.decisions ??= []);
  const entry: DecisionEntry = {
    id,
    what,
    ...(input.why?.trim() ? { why: input.why.trim() } : {}),
    alternatives: (input.alternatives ?? []).map((a) => a.trim()).filter(Boolean),
    by: prov.by,
    at: prov.at,
    ...(input.revisit ? { revisit: input.revisit } : {}),
  };
  const i = list.findIndex((d) => d.id === id);
  if (i >= 0) list.splice(i, 1);
  list.push(entry);
  list.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const cap = vault.config.curator.decisions_cap;
  if (list.length > cap) list.splice(0, list.length - cap);
  vault.touch(e);
  return entry;
}

/** Open a question on an entity, once (by its words). Past `questions_cap`, the oldest closed ones go first. */
export function openQuestion(vault: Vault, e: Entity, q: string, prov: Provenance): QuestionEntry {
  const text = q.trim();
  const id = `q-${hash(normalizeName(text))}`;
  const list = (e.fm.questions ??= []);
  const existing = list.find((x) => x.id === id);
  if (existing) {
    if (existing.status !== "open") {
      existing.status = "open";
      delete existing.answered_by;
      delete existing.answered_at;
      vault.touch(e);
    }
    return existing;
  }
  const entry: QuestionEntry = { id, q: text, by: prov.by, at: prov.at, status: "open" };
  list.push(entry);
  const cap = vault.config.curator.questions_cap;
  while (list.length > cap) {
    const closed = list.findIndex((x) => x.status !== "open");
    if (closed >= 0) list.splice(closed, 1);
    else {
      vault.warnings.push(`${e.slug}: more than ${cap} open questions; dropped the oldest ("${list[0]!.q}")`);
      list.shift();
    }
  }
  vault.touch(e);
  return entry;
}

/** Mark open questions answered by an episode. Returns the ids it closed (unknown or closed ids are skipped). */
export function answerQuestions(vault: Vault, e: Entity, ids: string[], ep: Pick<Episode, "agent" | "at">): string[] {
  const done: string[] = [];
  for (const q of e.fm.questions ?? []) {
    if (!ids.includes(q.id) || q.status !== "open") continue;
    q.status = "answered";
    q.answered_by = ep.agent;
    q.answered_at = ep.at;
    done.push(q.id);
  }
  if (done.length) vault.touch(e);
  return done;
}

const guidelineKey = (g: { rule: string; scope?: string }) => `${normalizeName(g.rule)}@${normalizeScope(g.scope ?? "")}`;

/**
 * Add a guideline to an entity. A human's is canon at once; an agent's is a rumor until
 * `canon_threshold` distinct sources say it. The same rule in the same scope is one guideline. Past
 * `guidelines_cap`, the oldest rumor goes first; canon ones are never dropped (a warning says so).
 */
export function addGuideline(vault: Vault, e: Entity, input: { rule: string; scope?: string }, prov: Provenance): Guideline | undefined {
  const rule = input.rule.trim();
  if (!rule) return undefined;
  const scope = input.scope ? normalizeScope(input.scope) || undefined : undefined;
  const human = vault.isHuman(prov.by);
  const by = human ? vault.human(prov.by)?.id ?? prov.by : prov.by;
  const list = (e.fm.guidelines ??= []);
  const key = guidelineKey({ rule, scope });
  let g = list.find((x) => guidelineKey(x) === key);
  if (g) {
    g.src = [...new Set([...g.src, ...prov.src])];
    if (human) {
      g.status = "canon";
      g.by = by;
      g.at = prov.at;
      delete g.seen_by;
    } else if (g.status === "rumor") {
      const seen = new Set([...(g.seen_by ?? [g.by ?? "human"]), prov.by]);
      if (seen.size >= vault.config.curator.canon_threshold) {
        g.status = "canon";
        delete g.seen_by;
      } else g.seen_by = [...seen];
      g.at = prov.at;
    }
  } else {
    g = { rule, ...(scope ? { scope } : {}), status: human ? "canon" : "rumor", by, at: prov.at, src: [...prov.src], ...(human ? {} : { seen_by: [prov.by] }) };
    if (!human && vault.config.curator.canon_threshold <= 1) {
      g.status = "canon";
      delete g.seen_by;
    }
    list.push(g);
  }
  const cap = vault.config.curator.guidelines_cap;
  while (list.length > cap) {
    // Oldest rumor first; among equal times, the one listed first.
    const rumors = list.map((x, i) => ({ x, i })).filter(({ x }) => x.status === "rumor");
    if (!rumors.length) {
      vault.warnings.push(`${e.slug}: ${list.length} canon guidelines, more than guidelines_cap (${cap}); none dropped`);
      break;
    }
    const oldest = rumors.reduce((a, b) => ((b.x.at ?? "") < (a.x.at ?? "") ? b : a));
    list.splice(oldest.i, 1);
  }
  vault.touch(e);
  return list.includes(g) ? g : undefined;
}
