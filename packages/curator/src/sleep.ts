import {
  ACTOR_TRAILER,
  AuditError,
  CURATOR_RULES_PATH,
  HANDBOOK_PATH,
  MODEL_TRAILER,
  REVIEW_PATH,
  Vault,
  VaultError,
  activeQuests,
  addGuideline,
  addRelation,
  answerQuestions,
  applyFact,
  applyGoalUpdate,
  applyRulings,
  applyStats,
  auditChanges,
  dataRefs,
  displayName,
  factKey,
  fieldUsage,
  findings,
  goalProps,
  identify,
  identityFields,
  isHiddenFact,
  isSecretRef,
  link,
  logDecision,
  matchIdentity,
  miniSearcher,
  normalizeName,
  openQuestion,
  parseDoc,
  parseFactKey,
  redact,
  renderDoc,
  renderHandbook,
  setSummary,
  slugify,
  truncate,
  unwrapLink,
  validateShapes,
  viewContext,
  withTrailers,
  type Behaviour,
  type Entity,
  type Episode,
  type FactResult,
  type FactValue,
  type GoalUpdate,
  type SearcherFactory,
  type VaultStore,
} from "@hippocampus/core";
import type { LLM } from "./llm.ts";
import {
  claimsPrompt,
  claimsSchema,
  matchPrompt,
  matchSchema,
  mentionsPrompt,
  mentionsSchema,
  openQuestions,
  summaryPrompt,
  summarySchema,
  type Claims,
  type Commitment,
} from "./prompts.ts";

export interface EpisodeReport {
  id: string;
  agent: string;
  created: string[];
  touched: string[];
  facts: FactResult[];
  relations: string[];
  /** `slug: change, change` per goal the episode moved or created. */
  goals: string[];
  /** @deprecated Runs stored before goals replaced quests report goal progress here. */
  quests?: string[];
  /** `slug.field` of values that wait for a human (`human_only` fields). */
  proposals: string[];
  /** Slugs of merge notes raised: two notes that may be one thing. */
  merges: string[];
  /** Slugs whose contact stats the episode counted on. */
  stats: string[];
  /** `slug: decision-id`. */
  decisions: string[];
  /** `? id on slug` opened, `✓ id on slug` answered. */
  questions: string[];
  /** Slugs that got a guideline. */
  guidelines: string[];
  /** Advisory notes for the review: unknown kind, data links to no note, what a confidential episode left out. Never values. */
  notes: string[];
}

export interface SleepReport {
  model: string;
  rulings: string[];
  consolidated: EpisodeReport[];
  failed: { id: string; path: string; error: string }[];
  summaries: string[];
  remaining: number;
  changed: string[];
  warnings: string[];
}

export interface SleepOptions {
  store: VaultStore;
  llm: LLM;
  now?: () => Date;
  /** Max episodes this run (defaults to curator.batch_size). */
  limit?: number;
  dryRun?: boolean;
  log?: (msg: string) => void;
  /** Search used to match mentions to existing entities (defaults to in-memory MiniSearch). */
  searcher?: SearcherFactory;
}

export interface EpisodeOutcome extends EpisodeReport {
  /**
   * What the summary step may read about this episode: redacted text, a placeholder for secret-bearing
   * and confidential ones, or nothing for one curated from its data alone (it rewrites no summary).
   */
  evidence: string;
  /** Plaintext secret values this episode carried. In memory only, never persisted or reported. */
  secrets: string[];
}

/**
 * One consolidation pass: inbox episodes → canon, like sleep turning episodic into semantic memory.
 * Composes the exported steps, which a run driven from outside (one step per call) replays the same way.
 */
export async function sleep(opts: SleepOptions): Promise<SleepReport> {
  const log = opts.log ?? (() => {});
  const llm = timed(opts.llm, log);
  const vault = await Vault.load(opts.store, { now: opts.now });
  const houseRules = await loadHouseRules(opts.store);
  const report: SleepReport = { model: opts.llm.name, rulings: [], consolidated: [], failed: [], summaries: [], remaining: 0, changed: [], warnings: [] };

  report.rulings = beginRun(vault);
  for (const r of report.rulings) log(`⚖ ruling applied: ${r}`);

  const evidence = new Map<string, string[]>();
  const secrets: string[] = [];
  for (const ep of pickBatch(vault, opts.limit)) {
    log(`… ${ep.id} (${ep.agent}): ${ep.secret ? "(secret)" : ep.confidential ? "(confidential)" : ep.text.slice(0, 70).replace(/\s+/g, " ")}`);
    const before = vault.snapshot();
    try {
      const { evidence: text, secrets: seen, ...r } = await consolidate(vault, llm, ep, opts.searcher ?? miniSearcher, { houseRules });
      report.consolidated.push(r);
      secrets.push(...seen);
      if (text) for (const slug of r.touched) evidence.set(slug, [...(evidence.get(slug) ?? []), text]);
      log(`  ✓ touched ${r.touched.join(", ") || "nothing"}${r.created.length ? `; new: ${r.created.join(", ")}` : ""}`);
    } catch (err) {
      // Half an episode (say, an entity created from a mention whose claims then failed) would be
      // committed without its chronicle entry, and before its secrets were redacted.
      vault.restore(before);
      const message = err instanceof Error ? err.message : String(err);
      report.failed.push({ id: ep.id, path: ep.path, error: message });
      log(`  ✗ ${message.slice(0, 200)} (left in inbox)`);
    }
  }

  for (const { entity, texts } of summaryTargets(vault, evidence)) {
    try {
      await summarize(vault, llm, entity, texts, { houseRules });
      report.summaries.push(entity.slug);
    } catch (err) {
      report.warnings.push(`summary for ${entity.slug} failed: ${(err as Error).message}`);
    }
  }

  finishRun(vault, report);
  const violations = await auditChanges({ before: opts.store, changes: vault.changes(), actor: { kind: "curator" }, forbidden: secrets });
  if (violations.length) throw new AuditError(violations);
  if (!opts.dryRun) report.changed = await vault.flush({ message: commitMessage(report), author: CURATOR_AUTHOR });
  return report;
}

/** Start a run: apply the human's rulings written into dispute notes since the last one. */
export function beginRun(vault: Vault): string[] {
  return applyRulings(vault);
}

/** The episodes this run consolidates, oldest first. */
export function pickBatch(vault: Vault, limit?: number): Episode[] {
  return vault.episodes.slice(0, limit ?? vault.config.curator.batch_size);
}

/** Entities whose summary this run rewrites, with the evidence gathered for each (never party notes). */
export function summaryTargets(vault: Vault, evidence: ReadonlyMap<string, readonly string[]>): { entity: Entity; texts: string[] }[] {
  if (!vault.config.curator.summaries) return [];
  const out: { entity: Entity; texts: string[] }[] = [];
  for (const [slug, texts] of evidence) {
    const entity = vault.entities.get(slug);
    if (entity && !vault.schema.has(entity.fm.type, "actor")) out.push({ entity, texts: [...texts] });
  }
  return out;
}

/** Rewrite one entity's summary region. Errors propagate: the caller decides whether a failed summary matters. */
export async function summarize(vault: Vault, llm: LLM, entity: Entity, texts: string[], o: { houseRules?: string } = {}): Promise<void> {
  const { summary } = await llm.object({ name: "summary", schema: summarySchema, ...summaryPrompt(vault, entity, texts, o.houseRules) });
  setSummary(entity, summary);
  vault.markDirty(entity);
}

/** End a run: write the morning review and the handbook, and fill in what's left and what went wrong. */
export function finishRun(vault: Vault, report: SleepReport): void {
  // Counted first: the review reports it.
  report.remaining = vault.episodes.length;
  vault.writeFile(REVIEW_PATH, renderReview(vault, report));
  vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
  report.warnings.push(...vault.warnings);
}

/** The human's house rules (`_hippo/curator.md`) without frontmatter or comments, or undefined when there are none. */
export async function loadHouseRules(store: VaultStore): Promise<string | undefined> {
  const raw = await store.read(CURATOR_RULES_PATH);
  if (!raw) return undefined;
  // Comments are notes to the human (hidden in Obsidian's reading view), not rules for the model.
  const rules = parseDoc(raw)
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/%%[\s\S]*?%%/g, "")
    .trim();
  return rules || undefined;
}

/** Git identity for the curator's commits, so they're easy to tell apart from the human's. */
export const CURATOR_AUTHOR = { name: "Hippocampus", email: "hippocampus@users.noreply.github.com" };

const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What one episode did, in a line: touched notes, new ones, disputes, goal progress, managed memory. Never values. */
export function describeEpisode(c: EpisodeReport): string {
  const goals = c.goals ?? c.quests ?? [];
  const count = (xs: string[] | undefined, word: string) => (xs?.length ? n(xs.length, word) : "");
  return [
    c.touched.length ? `touched ${c.touched.join(", ")}` : "nothing durable",
    c.created.length ? `new ${c.created.join(", ")}` : "",
    c.facts.some((f) => f.decision === "dispute") ? "⚖ dispute" : "",
    goals.length ? goals.join("; ") : "",
    count(c.proposals, "proposal"),
    count(c.merges, "possible duplicate"),
    c.stats?.length ? `stats ${c.stats.join(", ")}` : "",
    count(c.decisions, "decision"),
    count(c.questions, "question"),
    count(c.guidelines, "guideline"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The run's commit message, with the trailers `hippo audit` checks each commit by. */
export function commitMessage(r: SleepReport): string {
  const lines = r.consolidated.map((c) => `- ${c.id} (${c.agent}): ${describeEpisode(c)}`);
  const message = [
    `chore(sleep): consolidate ${r.consolidated.length} episode${r.consolidated.length === 1 ? "" : "s"}`,
    "",
    ...r.rulings.map((x) => `- ruling: ${x}`),
    ...lines,
    ...r.failed.map((f) => `- ✗ ${f.id}: ${f.error.slice(0, 120)}`),
    "",
    `model: ${r.model}`,
  ].join("\n");
  return withTrailers(message, { [ACTOR_TRAILER]: "curator", [MODEL_TRAILER]: r.model });
}

/** Reducers each behaviour runs; a kind's `reducers:` adds to them. */
const BEHAVIOUR_REDUCERS: Partial<Record<Behaviour, string[]>> = {
  interaction: ["stats"],
  decision: ["decision"],
  question: ["question"],
  task: ["task"],
};

/**
 * Whether an episode goes through the model at all. A kind that forbids text, or an episode without
 * any, is curated from its data alone: no mentions, no claims.
 */
export function needsModel(vault: Vault, ep: Episode): boolean {
  return vault.schema.kind(ep.kind).def.text !== "forbidden" && ep.text.trim().length > 0;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;
const isoDay = (v: string | undefined) => (v && ISO_DAY.test(v.trim()) ? v.trim().slice(0, 10) : undefined);
const first = (v: FactValue | FactValue[] | undefined) => (Array.isArray(v) ? v[0] : v);
const text = (v: FactValue | FactValue[] | undefined) => (v === undefined ? undefined : String(first(v)).trim() || undefined);
const texts = (v: FactValue | FactValue[] | undefined) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean));

/**
 * Consolidate one episode: mentions → entities → claims → canon, then the kind's reducers (contact
 * stats, decisions, questions, goals from commitments), then into the chronicle and out of the inbox.
 * On error the vault is left half-changed: snapshot it first and restore on failure.
 */
export async function consolidate(vault: Vault, llm: LLM, ep: Episode, searcher: SearcherFactory, o: { houseRules?: string } = {}): Promise<EpisodeOutcome> {
  const report: EpisodeReport = {
    id: ep.id,
    agent: ep.agent,
    created: [],
    touched: [],
    facts: [],
    relations: [],
    goals: [],
    proposals: [],
    merges: [],
    stats: [],
    decisions: [],
    questions: [],
    guidelines: [],
    notes: [],
  };
  const prov = { by: ep.agent, at: ep.at, src: [ep.id] };
  const kind = vault.schema.kind(ep.kind);
  if (kind.unknown) report.notes.push(`unknown kind "${ep.kind}"; filed as an observation`);
  const entities = new Map<string, Entity>();
  /** Names each entity had before this episode, so only names it adds are checked for leaks. */
  const namesBefore = new Map<string, Set<string>>();
  const take = (e: Entity, isNew = false) => {
    if (!namesBefore.has(e.slug)) namesBefore.set(e.slug, new Set(isNew ? [] : [e.fm.title ?? "", ...e.fm.aliases]));
    entities.set(e.slug, e);
  };
  const usable = (e: Entity | undefined): e is Entity => !!e && !vault.schema.has(e.fm.type, "actor");

  // Hints the agent gave us, and the notes its data links to, are resolved without the model.
  const hinted: Entity[] = [];
  for (const hint of ep.about) {
    const e = vault.resolve(hint);
    if (usable(e)) hinted.push(e);
  }
  for (const { field, ref } of dataRefs(kind.def, ep.data)) {
    const name = unwrapLink(ref);
    const e = vault.resolve(name);
    if (usable(e)) hinted.push(e);
    else if (!e && !vault.isHuman(name)) report.notes.push(`data.${field} links to no note; left unlinked`);
  }
  for (const e of hinted) take(e);

  const secretsSeen: string[] = [];
  const skipped = new Set<string>();
  const commitments: Commitment[] = [];
  if (needsModel(vault, ep)) {
    // 1. Mentions
    const { entities: mentions } = await llm.object({ name: "mentions", schema: mentionsSchema(vault.schema), ...mentionsPrompt(vault, ep, o.houseRules) });

    // 2. Resolve each mention to an existing entity, or create one. A type with identity keys learns
    // no names from a name-only match: only a key match below confirms them.
    const pendingAliases = new Map<string, string[]>();
    for (const m of mentions) {
      if (!m.name.trim() || !vault.schema.type(m.type)) continue;
      let e = [m.name, ...m.aliases].map((x) => vault.resolve(x)).find(usable);
      if (!e) {
        // Built per mention: earlier mentions in this episode may have created entities.
        const index = await searcher(vault);
        const candidates = (await index.search(m.name, { kind: "entity", limit: 5 })).map((h) => vault.entities.get(h.id)!).filter(usable);
        if (candidates.length) {
          const { match } = await llm.object({ name: "match", schema: matchSchema(candidates.map((c) => c.slug)), ...matchPrompt(m.name, m.type, ep, candidates, o.houseRules) });
          e = match === "new" ? undefined : vault.entities.get(match);
        }
      }
      if (e) {
        take(e);
        const names = [m.name, ...m.aliases].filter((a) => normalizeName(a) !== normalizeName(e!.slug));
        if (identityFields(vault, e.fm.type).length) pendingAliases.set(e.slug, [...(pendingAliases.get(e.slug) ?? []), ...names]);
        else vault.addAliases(e, names);
      } else {
        const allowed = new Set(vault.config.domains.map((d) => d.toLowerCase()));
        let tags = m.domains.map((d) => d.toLowerCase()).filter((d) => allowed.has(d));
        if (!tags.length) tags = authorityTags(vault, ep.agent);
        e = vault.createEntity({ type: m.type, title: m.name, aliases: m.aliases, tags, by: ep.agent });
        report.created.push(e.slug);
        take(e, true);
      }
    }

    // 3. Claims about the resolved entities.
    const goals = activeQuests(vault);
    const list = [...entities.values()];
    if (list.length) {
      const slugs = list.map((e) => e.slug);
      const claims = await llm.object({
        name: "claims",
        schema: claimsSchema(vault, slugs, { goals: goals.map((q) => q.slug), questions: openQuestions(list).map((q) => q.id) }),
        ...claimsPrompt(vault, ep, list, goals, o.houseRules),
      });

      // 4. Reconcile & apply (deterministic). Identity keys first: they may show a new note is an old one.
      const moved = resolveIdentities(vault, claims, entities, report, pendingAliases, take);
      const target = (slug: string) => moved.get(slug) ?? entities.get(slug);
      for (const f of claims.facts) {
        const e = target(f.entity);
        const value = f.value.trim();
        if (!e || !value || /^(unknown|n\/a|none|null)$/i.test(value)) continue;
        const secret = f.secret || (ep.secret === true && looksLikeIdentifier(value));
        const result = await applyFact(vault, e, f.field, value, prov, {
          secret,
          confidential: f.confidential || ep.confidential || undefined,
          scope: f.scope?.trim() || ep.scope,
          validFrom: isoDay(f.valid_from),
          validUntil: isoDay(f.valid_until),
        });
        // A secret field or an existing secret:// ref makes a fact secret even when the model didn't say so.
        if (result.secret) secretsSeen.push(value);
        if (result.decision === "propose") report.proposals.push(`${e.slug}.${result.field}`);
        report.facts.push(result);
      }
      for (const r of claims.relations) {
        const from = target(r.from);
        const to = target(r.to);
        const opts = { role: r.role, scope: ep.scope, validFrom: isoDay(r.valid_from), validUntil: isoDay(r.valid_until) };
        if (from && to && addRelation(vault, from, r.rel, to, prov, opts)) report.relations.push(`${from.slug} —${r.rel}→ ${to.slug}`);
      }
      for (const g of claims.goals) {
        const goal = vault.entities.get(g.goal);
        if (!goal) continue;
        // A confidential episode may move a goal along, but its words don't become objectives.
        if (ep.confidential && g.added.length) skipped.add("new objectives");
        const update: GoalUpdate = { status: g.status === "unchanged" ? undefined : g.status, complete: g.completed, add: ep.confidential ? [] : g.added, ...(g.progress ? { progress: g.progress } : {}) };
        const changes = tryGoalUpdate(vault, goal, update, ep.agent);
        if (changes.length) {
          report.goals.push(`${goal.slug}: ${changes.join(", ")}`);
          take(goal);
        }
      }
      commitments.push(...claims.commitments);
      for (const g of claims.guidelines) {
        const e = target(g.entity);
        if (!e || !g.rule.trim()) continue;
        if (ep.confidential) {
          skipped.add("guidelines");
          continue;
        }
        if (addGuideline(vault, e, { rule: g.rule, scope: g.scope?.trim() || ep.scope }, prov)) report.guidelines.push(e.slug);
      }
      const answered = claims.answered ?? [];
      if (answered.length) for (const e of entities.values()) for (const id of answerQuestions(vault, e, answered, ep)) report.questions.push(`✓ ${id} on ${e.slug}`);
    }
  }

  // 5. The kind's reducers, by its behaviour (and any it names), on what the episode is about.
  const reducers = new Set([...(BEHAVIOUR_REDUCERS[kind.def.behaviour] ?? []), ...kind.def.reducers]);
  const touched = () => [...entities.values()].filter(usable);
  // Decisions and questions go on the notes the episode names (hints, data links), else on all it touched.
  const subjects = () => (hinted.length ? [...new Set(hinted)] : touched().filter((e) => !vault.schema.has(e.fm.type, "goal")));
  if (reducers.has("stats")) {
    for (const slug of applyStats(vault, ep, kind.def, touched())) {
      report.stats.push(slug);
      take(vault.entities.get(slug)!);
    }
  }
  if (reducers.has("decision")) {
    const what = text(ep.data?.what) ?? (ep.text.trim() ? truncate(ep.text, 300) : undefined);
    if (what && ep.confidential) skipped.add("the decision");
    else if (what) {
      const input = { what, why: text(ep.data?.why), alternatives: texts(ep.data?.alternatives), revisit: isoDay(text(ep.data?.revisit)) };
      for (const e of subjects()) report.decisions.push(`${e.slug}: ${logDecision(vault, e, input, prov).id}`);
    }
  }
  if (reducers.has("question")) {
    const q = text(ep.data?.question) ?? text(ep.data?.q) ?? (ep.text.trim() ? truncate(ep.text, 300) : undefined);
    if (q && ep.confidential) skipped.add("the question");
    else if (q) for (const e of subjects()) report.questions.push(`? ${openQuestion(vault, e, q, prov).id} on ${e.slug}`);
  }
  if (reducers.has("task")) {
    const title = text(ep.data?.title);
    if (title) {
      const counterparty = text(ep.data?.counterparty) ?? text(ep.data?.with);
      commitments.push({ title, owner: text(ep.data?.owner), counterparty: counterparty && unwrapLink(counterparty), due: text(ep.data?.due), objectives: texts(ep.data?.objectives) });
    }
  }
  if (commitments.length && ep.confidential) skipped.add("commitments");
  else for (const c of commitments) applyCommitment(vault, c, ep, report, take, kind.def.goalType);
  if (skipped.size) report.notes.push(`confidential: ${[...skipped].join(", ")} kept out of shared notes`);

  // Belt and braces: a model may echo a secret as a name or alias; it must never reach a note.
  if (secretsSeen.length) {
    // A file name can't be redacted after the fact (links point at it), so the episode fails instead.
    const slugs = secretsSeen.map(slugify).filter((s) => s.length >= 6);
    if (report.created.some((slug) => slugs.some((s) => slug.includes(s)))) throw new Error("a new note would be named after a secret value");
    for (const e of entities.values()) {
      const leaks = (v: string) => secretsSeen.some((s) => v.includes(s));
      const before = e.fm.aliases.length;
      e.fm.aliases = e.fm.aliases.filter((a) => !leaks(a));
      if (e.fm.title && leaks(e.fm.title)) e.fm.title = redact(e.fm.title, secretsSeen);
      if (e.fm.aliases.length !== before || e.fm.title?.includes("[redacted]")) vault.markDirty(e);
    }
  }
  // Confidential values (and identity keys) stay out of names this episode adds, and out of the chronicle.
  const hidden = confidentialValues(vault);
  if (hidden.length) {
    const leaks = (v: string) => hidden.some((h) => occurrences(v, h) > 0);
    for (const e of entities.values()) {
      const before = namesBefore.get(e.slug) ?? new Set<string>();
      if (report.created.includes(e.slug) && e.fm.title && leaks(e.fm.title)) throw new Error("a new note would be named after a confidential value");
      const kept = e.fm.aliases.filter((a) => before.has(a) || !leaks(a));
      if (kept.length !== e.fm.aliases.length) {
        e.fm.aliases = kept;
        vault.markDirty(e);
      }
    }
  }

  report.touched = [...new Set([...entities.keys()])];
  // 6. Episodic → chronicle (secrets and confidential values redacted), then out of the inbox.
  const redacted = redactAll(redact(ep.text, secretsSeen), hidden);
  // A kind without text shows its data instead: that line is redacted the same way.
  const data = ep.data && Object.fromEntries(Object.entries(ep.data).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => scrub(x, secretsSeen, hidden)) : scrub(v, secretsSeen, hidden)]));
  await vault.appendChronicle(data ? { ...ep, data } : ep, report.touched, redacted);
  vault.archiveEpisode(ep);
  // Summaries read the evidence: never a confidential episode's words, nothing for one curated from data alone.
  const evidence = ep.secret ? "(secret-bearing episode)" : ep.confidential ? "(confidential)" : needsModel(vault, ep) ? redacted : "";
  return { ...report, evidence, secrets: secretsSeen };
}

/** The agent's lane domains, as tags for the notes it brings in. */
function authorityTags(vault: Vault, agent: string): string[] {
  return (vault.actorMember(agent)?.fm.authority ?? []).map((d) => d.toLowerCase());
}

/**
 * Identity keys among the claimed facts. A note created this episode whose key matches exactly one
 * existing note is that note after all: it's dropped and its names become the other's aliases. A
 * named note whose key belongs to another note raises a merge proposal; one whose key it holds itself
 * learns the names this episode used for it. Returns the created slugs that moved, and where.
 */
function resolveIdentities(
  vault: Vault,
  claims: Claims,
  entities: Map<string, Entity>,
  report: EpisodeReport,
  pendingAliases: Map<string, string[]>,
  take: (e: Entity) => void,
): Map<string, Entity> {
  const moved = new Map<string, Entity>();
  for (const e of [...entities.values()]) {
    const fields = identityFields(vault, e.fm.type);
    if (!fields.length) continue;
    const facts: Record<string, FactValue> = {};
    for (const f of claims.facts) {
      const key = factKey(f.field, f.scope);
      if (f.entity === e.slug && !f.secret && f.value.trim() && fields.includes(parseFactKey(key).field)) facts[key] = f.value.trim();
    }
    if (!Object.keys(facts).length) continue;
    if (report.created.includes(e.slug)) {
      const found = identify(vault, e.fm.type, undefined, facts);
      if (found.via !== "key" || !found.entity || found.entity === e) continue;
      const existing = found.entity;
      const names = [e.fm.title ?? "", ...e.fm.aliases].filter((a) => a && normalizeName(a) !== normalizeName(existing.slug));
      vault.discardEntity(e);
      entities.delete(e.slug);
      report.created = report.created.filter((s) => s !== e.slug);
      moved.set(e.slug, existing);
      take(existing);
      vault.addAliases(existing, names);
      continue;
    }
    const found = identify(vault, e.fm.type, e, facts);
    if (found.merge) {
      if (!report.merges.includes(found.merge.slug)) report.merges.push(found.merge.slug);
    } else if (matchIdentity(vault, e.fm.type, facts).some((m) => m.entity === e)) {
      vault.addAliases(e, pendingAliases.get(e.slug) ?? []);
    }
  }
  return moved;
}

function tryGoalUpdate(vault: Vault, goal: Entity, update: GoalUpdate, by: string): string[] {
  try {
    return applyGoalUpdate(vault, goal, update, by);
  } catch (err) {
    // A bad status or progress from the model leaves the goal as it was.
    if (!(err instanceof VaultError)) throw err;
    vault.warnings.push(`${goal.slug}: ${err.message}`);
    return [];
  }
}

/**
 * A promise becomes a goal of the kind's `goal_type` (else the vault's default goal type), unless an
 * open goal with the same title (normalized) and the same counterparty already tracks it: then that
 * one is updated.
 */
function applyCommitment(vault: Vault, c: Commitment, ep: Episode, report: EpisodeReport, take: (e: Entity, isNew?: boolean) => void, goalType?: string): void {
  const title = c.title.trim();
  if (goalType && !vault.schema.has(goalType, "goal")) report.notes.push(`goal_type "${goalType}" isn't a type with the goal capability; using the default goal type`);
  const type = goalType && vault.schema.has(goalType, "goal") ? goalType : vault.schema.defaultTypeFor("goal");
  if (!title) return;
  if (!type) {
    report.notes.push("a commitment had nowhere to go: no type has the goal capability");
    return;
  }
  const counterparty = c.counterparty ? vault.resolve(c.counterparty) : undefined;
  const sameParty = (g: Entity) => {
    const cp = goalProps(g).counterparty;
    return (cp ? vault.resolve(cp)?.slug ?? unwrapLink(cp) : undefined) === counterparty?.slug;
  };
  let goal = activeQuests(vault).find((g) => normalizeName(displayName(g)) === normalizeName(title) && sameParty(g));
  const isNew = !goal;
  if (!goal) {
    goal = vault.createEntity({ type, title, tags: authorityTags(vault, ep.agent), by: ep.agent });
    report.created.push(goal.slug);
  }
  const due = isoDay(c.due);
  if (c.due && !due) report.notes.push(`${goal.slug}: due date isn't an ISO date; left unset`);
  const changes = tryGoalUpdate(vault, goal, { owner: c.owner, counterparty: counterparty?.slug, ...(due ? { due } : {}), add: c.objectives ?? [] }, ep.agent);
  if (isNew || changes.length) report.goals.push(`${goal.slug}: ${[...(isNew ? ["new"] : []), ...changes].join(", ")}`);
  take(goal, isNew);
}

/** Every confidential value in the vault (facts marked so, confidential fields, identity keys), current and past. */
function confidentialValues(vault: Vault): string[] {
  const out = new Set<string>();
  for (const e of vault.entities.values()) {
    for (const [k, f] of Object.entries(e.fm.facts)) {
      if (!isHiddenFact(vault.schema, e.fm.type, k, f)) continue;
      for (const v of [f.value, ...(f.was ?? []).map((w) => w.value)]) {
        const s = String(v).trim();
        if (!isSecretRef(v) && s.length >= 3) out.add(s);
      }
    }
  }
  return [...out];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Short values only as whole tokens, as the audit counts them. */
const valuePattern = (v: string) => new RegExp(v.length >= 6 ? escape(v) : `(?<![\\p{L}\\p{N}])${escape(v)}(?![\\p{L}\\p{N}])`, "gu");
const occurrences = (text: string, v: string) => text.match(valuePattern(v))?.length ?? 0;
const redactAll = (text: string, values: string[]) => values.reduce((t, v) => t.replace(valuePattern(v), "[redacted]"), text);
const scrub = (v: FactValue, secrets: string[], hidden: string[]): FactValue => (typeof v === "string" ? redactAll(redact(v, secrets), hidden) : v);

function timed(llm: LLM, log: (msg: string) => void): LLM {
  return {
    name: llm.name,
    async object(req) {
      const t0 = Date.now();
      try {
        return await llm.object(req);
      } finally {
        log(`    · ${req.name} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    },
  };
}

function looksLikeIdentifier(v: string): boolean {
  return /^[A-Z0-9-]{6,}$/i.test(v.replace(/\s/g, "")) && /\d/.test(v);
}

/** Most shape findings the review lists; the rest are counted. */
const SHAPE_NOTES_MAX = 30;

function renderReview(vault: Vault, report: SleepReport): string {
  const now = vault.nowIso();
  const ctx = viewContext(vault);
  const found = findings(ctx);
  const v = (f: { value: string | null; secret: boolean; confidential?: boolean }) => (f.secret ? "🔒" : f.confidential ? "◐ confidential" : f.value);
  const kindOf = (slug: string) => vault.disputes.get(slug)?.fm.kind ?? "conflict";
  const rumors = found.rumors.map((f) => `- ${link(f.ref.slug)} · **${f.field}** = ${v(f)} (${f.by})`);
  const stale = found.stale.map((f) => `- ${link(f.ref.slug)} · **${f.field}** = ${v(f)} (last seen ${f.at!.slice(0, 10)})`);
  // Proposals and possible duplicates aren't disagreements: they get their own sections.
  const disputes = found.disputes
    .filter((d) => kindOf(d.slug) === "conflict")
    .map((d) => `- ${link(d.slug)} — ${link(d.entity.slug)} · ${d.field}: ${d.claims.map((c) => `${v(c)} (${c.by})`).join(" vs ")}`);
  const proposals = found.disputes
    .filter((d) => kindOf(d.slug) === "proposal" && vault.disputes.get(d.slug)?.fm.state !== "already_present")
    .map((d) => `- ${link(d.slug)} — ${link(d.entity.slug)} · ${d.field}: ${d.claims.map((c) => `${v(c)} (${c.by})`).join(" or ")}`);
  const merges = vault
    .openDisputes()
    .filter((d) => d.fm.kind === "merge")
    .map((d) => `- ${link(d.slug)} — ${(d.fm.targets ?? [d.fm.entity]).join(" · ")}${d.fm.field ? ` (same ${d.fm.field})` : ""}`);
  const ran = new Set(report.consolidated.map((c) => c.id));
  const guidelines = [...vault.entities.values()].flatMap((e) =>
    (e.fm.guidelines ?? []).filter((g) => g.status === "rumor" && g.src.some((s) => ran.has(s))).map((g) => `- ${link(e.slug)} · ${g.rule}${g.scope ? ` (${g.scope})` : ""} (${g.by ?? vault.config.human})`),
  );
  const shapes = [
    ...report.consolidated.flatMap((c) => (c.notes ?? []).map((note) => `- ${c.id} (${c.agent}): ${note}`)),
    ...validateShapes(vault).map((f) => `- \`${f.path}\` — ${f.message}`),
  ];
  const shown = shapes.slice(0, SHAPE_NOTES_MAX);
  if (shapes.length > shown.length) shown.push(`- … and ${shapes.length - shown.length} more (\`hippo validate\` lists them all)`);
  const usage = fieldUsage(vault).map((u) => `- ${u.type}: ${u.fields.map((f) => `${f.field} ×${f.count}`).join(", ")}`);
  const failed = report.failed.map((f) => `- \`${f.path}\` — ${f.error.slice(0, 160)}`);
  const orphans = found.orphans.map((r) => `- ${link(r.slug)} (${r.type}: ${r.title})`);
  const section = (title: string, items: string[]) => `## ${title}\n\n${items.length ? items.join("\n") : "- (none)"}\n`;
  return renderDoc(
    { type: "review", generated: now },
    `# 🌙 Morning review

Generated by the last sleep (${now.slice(0, 16).replace("T", " ")} UTC, model \`${report.model}\`): ${report.consolidated.length} episodes consolidated, ${report.failed.length} failed, ${report.remaining} still in the inbox.

${section("⚖ Disputes awaiting your ruling", disputes)}
${section("💡 Proposals (only you set these fields)", proposals)}
${section("🔗 Possible duplicates", merges)}
${section("❓ Rumors (unverified)", rumors)}
${section("🧭 New guidelines (unverified rumors from this run)", guidelines)}
${section(`🕸 Stale canon (not re-confirmed in ${vault.config.curator.stale_after_days} days)`, stale)}
${section("🧩 Orphan notes (no relations)", orphans)}
${section("📐 Shape notes (advisory)", shown)}
${usage.length ? `Fields in use that their type doesn't declare (candidates for the schema):\n\n${usage.join("\n")}\n\n` : ""}${section("✗ Episodes that failed to consolidate", failed)}`,
  );
}
