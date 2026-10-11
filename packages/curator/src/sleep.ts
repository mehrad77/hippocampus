import {
  ACTOR_TRAILER,
  AUTHORITY_RANK,
  AuditError,
  CURATOR_RULES_PATH,
  HANDBOOK_PATH,
  MODEL_TRAILER,
  REVIEW_PATH,
  SLUG,
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
  getObjectives,
  getSummary,
  goalProps,
  identify,
  identityFields,
  isHiddenFact,
  isSecretRef,
  isTrackedConfidential,
  link,
  logDecision,
  matchIdentity,
  matchObjective,
  miniSearcher,
  normalizeName,
  normalizeScope,
  openQuestion,
  overlayStore,
  parseDoc,
  parseFactKey,
  proposeMerge,
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
  NO_RECIPIENT,
} from "@hippocampus/core";
import type { LLM } from "./llm.ts";
import { GOAL_STATUS_NOTE, nextSteps, renderNextSteps, suggestedDomains } from "./next-steps.ts";
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
  /** Domains the model wanted that the config lacks, for the human to add. Absent in runs stored before them. */
  domains?: string[];
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
    // The vault as it stood before this episode, so its audit sees only what this episode changed.
    const base = overlayStore(opts.store, vault.changes());
    try {
      const { evidence: text, secrets: seen, ...r } = await consolidate(vault, llm, ep, opts.searcher ?? miniSearcher, { houseRules });
      // One episode that breaks a rule fails alone and stays in the inbox; it never blocks every sleep after it.
      const violations = await auditChanges({ before: base, changes: vault.changes(), actor: { kind: "curator" }, forbidden: [...secrets, ...seen] });
      if (violations.length) throw new AuditError(violations);
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

  await redactRun(vault, opts.store, evidence, secrets);
  for (const { entity, texts } of summaryTargets(vault, evidence)) {
    try {
      await summarize(vault, llm, entity, texts, { houseRules, secrets });
      report.summaries.push(entity.slug);
    } catch (err) {
      report.warnings.push(`summary for ${entity.slug} failed: ${(err as Error).message}`);
    }
  }

  // A suggestion that happens to spell one of the run's secrets would fail the whole run below.
  for (const r of report.consolidated) if (r.domains) r.domains = r.domains.filter((d) => !secrets.some((s) => s.trim().length >= 3 && d.includes(s.toLowerCase())));
  finishRun(vault, report);
  // The backstop: each episode passed its own audit, so this one catches only what the run as a whole adds.
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

/**
 * Rewrite one entity's summary region. Errors propagate: the caller decides whether a failed summary
 * matters. A summary that repeats a confidential value or one of `secrets` more than the old one did
 * is refused (thrown), so only that summary is dropped, not the run.
 */
export async function summarize(vault: Vault, llm: LLM, entity: Entity, texts: string[], o: { houseRules?: string; secrets?: string[] } = {}): Promise<void> {
  const { summary } = await llm.object({ name: "summary", schema: summarySchema, ...summaryPrompt(vault, entity, texts, o.houseRules) });
  const previous = getSummary(entity);
  const secrets = (o.secrets ?? []).filter((v) => v.trim().length >= 3);
  const more = (count: (t: string) => number) => count(summary) > count(previous);
  if (confidentialValues(vault).some((v) => more((t) => occurrences(t, v))) || secrets.some((v) => more((t) => t.split(v).length - 1))) {
    throw new Error("the new summary repeats a confidential or secret value; the previous one stays");
  }
  setSummary(entity, summary);
  vault.markDirty(entity);
}

/**
 * Once a batch is done, redact this run's chronicle entries and summary evidence again with what is
 * confidential now: a later episode may have made a value confidential after an earlier one quoted it.
 * Only the quoted lines of entries this run appended change; headers, links and older days don't.
 */
export async function redactRun(vault: Vault, store: VaultStore, evidence: Map<string, string[]>, secrets: string[]): Promise<void> {
  const hidden = confidentialValues(vault);
  if (!hidden.length && !secrets.length) return;
  const clean = (t: string) => redactAll(redact(t, secrets), hidden);
  for (const [slug, texts] of evidence) evidence.set(slug, texts.map(clean));
  const folder = `${vault.config.folders.chronicle}/`;
  for (const c of vault.changes()) {
    if (!("content" in c) || !c.path.startsWith(folder)) continue;
    const old = ((await store.read(c.path)) ?? "").trimEnd();
    const at = old && c.content.startsWith(old) ? old.length : 0;
    const added = c.content.slice(at);
    const quoted = (line: string) => line.startsWith("> ") && !line.startsWith("> [!episode]") && !line.startsWith("> ↳");
    const redacted = added
      .split("\n")
      .map((line) => (quoted(line) ? clean(line) : line))
      .join("\n");
    if (redacted !== added) vault.writeFile(c.path, c.content.slice(0, at) + redacted);
  }
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
  const wanted: string[] = [];
  const skipped = new Set<string>();
  const commitments: Commitment[] = [];
  const reducers = new Set([...(BEHAVIOUR_REDUCERS[kind.def.behaviour] ?? []), ...kind.def.reducers]);
  // Agent text bound for managed memory (decisions, questions, guidelines, objectives, goal titles):
  // never a secret this episode carried, nor a value that is confidential by now.
  const clean = (x: string) => redactAll(redact(x, secretsSeen), confidentialValues(vault));
  /** A scope as given, undefined for none, or null when it has nothing to normalize (the item is skipped). */
  const scopeOf = (raw: string | undefined): string | undefined | null => {
    const t = raw?.trim();
    if (!t) return undefined;
    try {
      normalizeScope(t);
      return t;
    } catch {
      report.notes.push("a scope with no letters or digits; what it qualified was left out");
      return null;
    }
  };
  if (needsModel(vault, ep)) {
    // 1. Mentions
    const { entities: mentions } = await llm.object({ name: "mentions", schema: mentionsSchema(vault.schema), ...mentionsPrompt(vault, ep, o.houseRules) });

    // 2. Resolve each mention to an existing entity, or create one. A type with identity keys learns
    // no names from a name-only match: only a key match below confirms them.
    const pendingAliases = new Map<string, string[]>();
    for (const m of mentions) {
      if (!m.name.trim() || !vault.schema.type(m.type)) continue;
      wanted.push(...m.domains);
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

    // 3. Claims about the resolved entities. A task (or commitment) kind is asked even about none: its promise is the point.
    const goals = activeQuests(vault);
    const list = [...entities.values()];
    if (list.length || reducers.has("task")) {
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
        const scope = scopeOf(f.scope?.trim() || ep.scope);
        if (scope === null) continue;
        const result = await applyFact(vault, e, f.field, value, prov, {
          secret,
          confidential: f.confidential || ep.confidential || undefined,
          scope,
          validFrom: isoDay(f.valid_from),
          validUntil: isoDay(f.valid_until),
        });
        // A secret field or an existing secret:// ref makes a fact secret even when the model didn't say so.
        if (result.secret) secretsSeen.push(value);
        // One that couldn't be stored (no secrets recipient) opened no proposal for the human to review.
        if (result.decision === "propose" && !result.reason?.includes(NO_RECIPIENT)) report.proposals.push(`${e.slug}.${result.field}`);
        report.facts.push(result);
      }
      for (const r of claims.relations) {
        const from = target(r.from);
        const to = target(r.to);
        const scope = scopeOf(ep.scope);
        if (scope === null) continue;
        const opts = { role: r.role, scope, validFrom: isoDay(r.valid_from), validUntil: isoDay(r.valid_until) };
        if (from && to && addRelation(vault, from, r.rel, to, prov, opts)) report.relations.push(`${from.slug} —${r.rel}→ ${to.slug}`);
      }
      for (const g of claims.goals) {
        const goal = vault.entities.get(g.goal);
        if (!goal) continue;
        // Only the goal's owner, or a source with authority over it, says it's done, failed or blocked.
        let status = g.status === "unchanged" ? undefined : g.status;
        const owner = goalProps(goal).owner;
        const owns = !!owner && (vault.resolve(owner)?.slug ?? unwrapLink(owner)) === ep.agent;
        if (status && !owns && AUTHORITY_RANK[vault.authorityOf(ep.agent, goal)] < AUTHORITY_RANK.authority) {
          report.notes.push(`${goal.slug}: ${GOAL_STATUS_NOTE}: ${ep.agent} neither owns it nor has authority over it; set an owner on the goal or grant ${ep.agent} authority`);
          status = undefined;
        }
        // A confidential episode may tick off objectives the goal already has, but its words never become objectives.
        const existing = getObjectives(goal);
        const completed = ep.confidential ? g.completed.flatMap((t) => matchObjective(existing, t)?.text ?? []) : g.completed.map(clean);
        if (ep.confidential && (g.added.length || completed.length < g.completed.length)) skipped.add("new objectives");
        const update: GoalUpdate = { status, complete: completed, add: ep.confidential ? [] : g.added.map(clean), ...(g.progress ? { progress: g.progress } : {}) };
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
        const scope = scopeOf(g.scope?.trim() || ep.scope);
        if (scope === null) continue;
        if (addGuideline(vault, e, { rule: clean(g.rule), scope }, prov)) report.guidelines.push(e.slug);
      }
      const answered = claims.answered ?? [];
      if (answered.length) for (const e of entities.values()) for (const id of answerQuestions(vault, e, answered, ep)) report.questions.push(`✓ ${id} on ${e.slug}`);
    }
  }

  // 5. The kind's reducers, by its behaviour (and any it names), on what the episode is about.
  const touched = () => [...entities.values()].filter(usable);
  // Decisions and questions go on the notes the episode names (hints, data links), else on all it touched.
  const subjects = () => (hinted.length ? [...new Set(hinted)] : touched().filter((e) => !vault.schema.has(e.fm.type, "goal")));
  if (reducers.has("stats")) {
    for (const slug of applyStats(vault, ep, kind.def, touched())) {
      report.stats.push(slug);
      take(vault.entities.get(slug)!);
    }
  }
  // A secret-bearing episode's own words never stand in for a decision or a question: only its data does.
  const fallback = !ep.secret && ep.text.trim() ? truncate(ep.text, 300) : undefined;
  if (reducers.has("decision")) {
    const what = text(ep.data?.what) ?? fallback;
    if (what && ep.confidential) skipped.add("the decision");
    else if (what) {
      const why = text(ep.data?.why);
      const input = { what: clean(what), why: why && clean(why), alternatives: texts(ep.data?.alternatives).map(clean), revisit: isoDay(text(ep.data?.revisit)) };
      for (const e of subjects()) report.decisions.push(`${e.slug}: ${logDecision(vault, e, input, prov).id}`);
    }
  }
  if (reducers.has("question")) {
    const q = text(ep.data?.question) ?? text(ep.data?.q) ?? fallback;
    if (q && ep.confidential) skipped.add("the question");
    else if (q) for (const e of subjects()) report.questions.push(`? ${openQuestion(vault, e, clean(q), prov).id} on ${e.slug}`);
  }
  if (reducers.has("task")) {
    const title = text(ep.data?.title);
    // Without a claims step to find it, the promise is the data's title.
    if (title && !commitments.some((c) => normalizeName(c.title) === normalizeName(title))) {
      const counterparty = text(ep.data?.counterparty) ?? text(ep.data?.with);
      commitments.push({ title, owner: text(ep.data?.owner), counterparty: counterparty && unwrapLink(counterparty), due: text(ep.data?.due), objectives: texts(ep.data?.objectives) });
    }
  }
  if (commitments.length && ep.confidential) skipped.add("commitments");
  else for (const c of commitments) applyCommitment(vault, { ...c, title: clean(c.title), objectives: c.objectives?.map(clean) }, ep, report, take, kind.def.goalType);
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

  // Areas the model wanted that the config lacks, for the human to add. Never from an episode with a secret or a confidential word.
  if (!ep.secret && !ep.confidential && !secretsSeen.length) {
    const domains = domainSuggestions(vault, wanted, hidden);
    if (domains.length) report.domains = domains;
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
      // A note of another kind with the same key may still be the same thing: the human decides, nothing is folded.
      const foreign = found.via === "key" ? undefined : found.foreign?.[0];
      if (foreign) {
        const d = proposeMerge(vault, e, foreign.entity, foreign.field);
        if (!report.merges.includes(d.slug)) report.merges.push(d.slug);
      }
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
 * open goal with the same title (normalized) already tracks it, with the same counterparty or with
 * none on either side: then that one gets what it doesn't have yet (owner, counterparty, due date are
 * never overwritten) and the new objectives.
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
    const theirs = cp ? (vault.resolve(cp)?.slug ?? unwrapLink(cp)) : undefined;
    return !theirs || !counterparty || theirs === counterparty.slug;
  };
  let goal = activeQuests(vault).find((g) => normalizeName(displayName(g)) === normalizeName(title) && sameParty(g));
  const isNew = !goal;
  if (!goal) {
    goal = vault.createEntity({ type, title, tags: authorityTags(vault, ep.agent), by: ep.agent });
    report.created.push(goal.slug);
  }
  const due = isoDay(c.due);
  if (c.due && !due) report.notes.push(`${goal.slug}: due date isn't an ISO date; left unset`);
  // What someone already set on a goal stays: a later mention of the same promise only fills gaps.
  const set = isNew ? {} : goalProps(goal);
  const update: GoalUpdate = {
    ...(c.owner && !set.owner ? { owner: c.owner } : {}),
    ...(counterparty && !set.counterparty ? { counterparty: counterparty.slug } : {}),
    ...(due && !set.due ? { due } : {}),
    add: c.objectives ?? [],
  };
  const changes = tryGoalUpdate(vault, goal, update, ep.agent);
  if (isNew || changes.length) report.goals.push(`${goal.slug}: ${[...(isNew ? ["new"] : []), ...changes].join(", ")}`);
  take(goal, isNew);
}

/** Every confidential value in the vault (facts marked so, confidential fields, identity keys, confidential claims), current and past. */
export function confidentialValues(vault: Vault): string[] {
  const out = new Set<string>();
  for (const e of vault.entities.values()) {
    for (const [k, f] of Object.entries(e.fm.facts)) {
      if (!isHiddenFact(vault.schema, e.fm.type, k, f)) continue;
      for (const v of [f.value, ...(f.was ?? []).map((w) => w.value)]) {
        const s = String(v).trim();
        // The audit's own rule: a value too short or common to look for isn't redacted either.
        if (!isSecretRef(v) && isTrackedConfidential(s)) out.add(s);
      }
    }
  }
  // A confidential claim waiting in a dispute or proposal is as confidential as a fact.
  for (const d of vault.disputes.values()) {
    for (const c of d.fm.claims) {
      const s = String(c.value).trim();
      if (c.confidential && !isSecretRef(c.value) && isTrackedConfidential(s)) out.add(s);
    }
  }
  return [...out];
}

/** Domain ids worth suggesting: ones the config lacks, with a letter, no long number, and no hidden value in them. */
function domainSuggestions(vault: Vault, wanted: string[], hidden: string[]): string[] {
  const known = new Set(vault.config.domains.map((d) => d.toLowerCase()));
  return [...new Set(wanted.map((d) => d.trim().toLowerCase()))].filter(
    (d) => SLUG.test(d) && /[a-z]/.test(d) && !/\d{4}/.test(d) && !known.has(d) && !hidden.some((h) => occurrences(d, h.toLowerCase()) > 0),
  );
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
  const domains = suggestedDomains(report);
  const steps = renderNextSteps(nextSteps(report));
  const failed = report.failed.map((f) => `- \`${f.path}\` — ${f.error.slice(0, 160)}`);
  const orphans = found.orphans.map((r) => `- ${link(r.slug)} (${r.type}: ${r.title})`);
  const section = (title: string, items: string[]) => `## ${title}\n\n${items.length ? items.join("\n") : "- (none)"}\n`;
  return renderDoc(
    { type: "review", generated: now, suggested_domains: domains.length ? domains.map((d) => d.id) : undefined },
    `# 🌙 Morning review

Generated by the last sleep (${now.slice(0, 16).replace("T", " ")} UTC, model \`${report.model}\`): ${report.consolidated.length} episodes consolidated, ${report.failed.length} failed, ${report.remaining} still in the inbox.

${section("➡ What to do next", steps)}
${section("⚖ Disputes awaiting your ruling", disputes)}
${section("💡 Proposals (only you set these fields)", proposals)}
${section("🔗 Possible duplicates", merges)}
${section("❓ Rumors (unverified)", rumors)}
${section("🧭 New guidelines (unverified rumors from this run)", guidelines)}
${section(`🕸 Stale canon (not re-confirmed in ${vault.config.curator.stale_after_days} days)`, stale)}
${section("🧩 Orphan notes (no relations)", orphans)}
${section("📐 Shape notes (advisory)", shown)}
${usage.length ? `Fields in use that their type doesn't declare (candidates for the schema):\n\n${usage.join("\n")}\n\n` : ""}${domains.length ? `Domains the curator wanted that the vault doesn't have (add them on the Agents page or with \`hippo domain add\`):\n\n${domains.map((d) => `- \`${d.id}\` (${d.count} episode${d.count > 1 ? "s" : ""})`).join("\n")}\n\n` : ""}${section("✗ Episodes that failed to consolidate", failed)}${report.warnings.length ? `\n${section("⚠ Warnings", report.warnings.map((w) => `- ${w}`))}` : ""}`,
  );
}
