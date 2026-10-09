import {
  ACTOR_TRAILER,
  AuditError,
  CURATOR_RULES_PATH,
  HANDBOOK_PATH,
  MODEL_TRAILER,
  REVIEW_PATH,
  Vault,
  miniSearcher,
  activeQuests,
  addRelation,
  applyFact,
  applyQuestUpdate,
  applyRulings,
  auditChanges,
  findings,
  link,
  normalizeName,
  parseDoc,
  redact,
  renderDoc,
  renderHandbook,
  setSummary,
  slugify,
  viewContext,
  withTrailers,
  type Entity,
  type Episode,
  type FactResult,
  type SearcherFactory,
  type VaultStore,
} from "@hippocampus/core";
import type { LLM } from "./llm.ts";
import { claimsPrompt, claimsSchema, matchPrompt, matchSchema, mentionsPrompt, mentionsSchema, summaryPrompt, summarySchema } from "./prompts.ts";

export interface EpisodeReport {
  id: string;
  agent: string;
  created: string[];
  touched: string[];
  facts: FactResult[];
  relations: string[];
  quests: string[];
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
  /** What the summary step may read about this episode: redacted text, or a placeholder for secret-bearing ones. */
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
    log(`… ${ep.id} (${ep.agent}): ${ep.secret ? "(secret)" : ep.text.slice(0, 70).replace(/\s+/g, " ")}`);
    const before = vault.snapshot();
    try {
      const { evidence: text, secrets: seen, ...r } = await consolidate(vault, llm, ep, opts.searcher ?? miniSearcher, { houseRules });
      report.consolidated.push(r);
      secrets.push(...seen);
      for (const slug of r.touched) evidence.set(slug, [...(evidence.get(slug) ?? []), text]);
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
    if (entity && entity.fm.type !== "party") out.push({ entity, texts: [...texts] });
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

/** What one episode did, in a line: touched notes, new ones, disputes, quest progress. */
export function describeEpisode(c: EpisodeReport): string {
  return [
    c.touched.length ? `touched ${c.touched.join(", ")}` : "nothing durable",
    c.created.length ? `new ${c.created.join(", ")}` : "",
    c.facts.some((f) => f.decision === "dispute") ? "⚖ dispute" : "",
    c.quests.length ? c.quests.join("; ") : "",
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

/**
 * Consolidate one episode: mentions → entities → claims → canon, then into the chronicle and out of
 * the inbox. On error the vault is left half-changed: snapshot it first and restore on failure.
 */
export async function consolidate(vault: Vault, llm: LLM, ep: Episode, searcher: SearcherFactory, o: { houseRules?: string } = {}): Promise<EpisodeOutcome> {
  const report: EpisodeReport = { id: ep.id, agent: ep.agent, created: [], touched: [], facts: [], relations: [], quests: [] };
  const prov = { by: ep.agent, at: ep.at, src: [ep.id] };
  const entities = new Map<string, Entity>();

  // Hints the agent gave us are resolved without the model.
  for (const hint of ep.about) {
    const e = vault.resolve(hint);
    if (e && e.fm.type !== "party") entities.set(e.slug, e);
  }

  // 1. Mentions
  const { entities: mentions } = await llm.object({ name: "mentions", schema: mentionsSchema(vault.config), ...mentionsPrompt(vault, ep, o.houseRules) });

  // 2. Resolve each mention to an existing entity, or create one.
  for (const m of mentions) {
    if (!m.name.trim() || !vault.config.types[m.type]) continue;
    let e = [m.name, ...m.aliases].map((n) => vault.resolve(n)).find((x) => x && x.fm.type !== "party");
    if (!e) {
      // Built per mention: earlier mentions in this episode may have created entities.
      const index = await searcher(vault);
      const candidates = (await index.search(m.name, { kind: "entity", limit: 5 }))
        .map((h) => vault.entities.get(h.id)!)
        .filter((c) => c && c.fm.type !== "party");
      if (candidates.length) {
        const { match } = await llm.object({ name: "match", schema: matchSchema(candidates.map((c) => c.slug)), ...matchPrompt(m.name, m.type, ep, candidates, o.houseRules) });
        e = match === "new" ? undefined : vault.entities.get(match);
      }
    }
    if (e) {
      vault.addAliases(e, [m.name, ...m.aliases].filter((a) => normalizeName(a) !== normalizeName(e!.slug)));
    } else {
      const allowed = new Set(vault.config.domains.map((d) => d.toLowerCase()));
      let tags = m.domains.map((d) => d.toLowerCase()).filter((d) => allowed.has(d));
      if (!tags.length) tags = (vault.partyMember(ep.agent)?.fm.authority ?? []).map((d) => d.toLowerCase());
      e = vault.createEntity({ type: m.type, title: m.name, aliases: m.aliases, tags, by: ep.agent });
      report.created.push(e.slug);
    }
    entities.set(e.slug, e);
  }

  // 3. Claims about the resolved entities.
  const quests = activeQuests(vault);
  const list = [...entities.values()];
  const secretsSeen: string[] = [];
  if (list.length) {
    const slugs = list.map((e) => e.slug);
    const claims = await llm.object({
      name: "claims",
      schema: claimsSchema(vault.config, slugs, quests.map((q) => q.slug)),
      ...claimsPrompt(vault, ep, list, quests, o.houseRules),
    });

    // 4. Reconcile & apply (deterministic).
    for (const f of claims.facts) {
      const e = entities.get(f.entity);
      const value = f.value.trim();
      if (!e || !value || /^(unknown|n\/a|none|null)$/i.test(value)) continue;
      const secret = f.secret || (ep.secret === true && looksLikeIdentifier(value));
      const result = await applyFact(vault, e, f.field, value, prov, { secret });
      // A secret field or an existing secret:// ref makes a fact secret even when the model didn't say so.
      if (result.secret) secretsSeen.push(value);
      report.facts.push(result);
    }
    for (const r of claims.relations) {
      const from = entities.get(r.from);
      const to = entities.get(r.to);
      if (from && to && addRelation(vault, from, r.rel, to, prov)) report.relations.push(`${from.slug} —${r.rel}→ ${to.slug}`);
    }
    for (const q of claims.quests) {
      const quest = vault.entities.get(q.quest);
      if (!quest) continue;
      const changes = applyQuestUpdate(vault, quest, { status: q.status === "unchanged" ? undefined : q.status, complete: q.completed, add: q.added }, ep.agent);
      if (changes.length) {
        report.quests.push(`${quest.slug}: ${changes.join(", ")}`);
        entities.set(quest.slug, quest);
      }
    }
  }

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

  report.touched = [...new Set([...entities.keys()])];
  // 5. Episodic → chronicle (secrets redacted), then out of the inbox.
  const redacted = redact(ep.text, secretsSeen);
  await vault.appendChronicle(ep, report.touched, redacted);
  vault.archiveEpisode(ep);
  return { ...report, evidence: ep.secret ? "(secret-bearing episode)" : redacted, secrets: secretsSeen };
}

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

function renderReview(vault: Vault, report: SleepReport): string {
  const now = vault.nowIso();
  const found = findings(viewContext(vault));
  const v = (f: { value: string | null; secret: boolean }) => (f.secret ? "🔒" : f.value);
  const rumors = found.rumors.map((f) => `- ${link(f.ref.slug)} · **${f.field}** = ${v(f)} (${f.by})`);
  const stale = found.stale.map((f) => `- ${link(f.ref.slug)} · **${f.field}** = ${v(f)} (last seen ${f.at!.slice(0, 10)})`);
  const disputes = found.disputes.map((d) => `- ${link(d.slug)} — ${link(d.entity.slug)} · ${d.field}: ${d.claims.map((c) => `${v(c)} (${c.by})`).join(" vs ")}`);
  const failed = report.failed.map((f) => `- \`${f.path}\` — ${f.error.slice(0, 160)}`);
  const orphans = found.orphans.map((r) => `- ${link(r.slug)} (${r.type}: ${r.title})`);
  const section = (title: string, items: string[]) => `## ${title}\n\n${items.length ? items.join("\n") : "- (none)"}\n`;
  return renderDoc(
    { type: "review", generated: now },
    `# 🌙 Morning review

Generated by the last sleep (${now.slice(0, 16).replace("T", " ")} UTC, model \`${report.model}\`): ${report.consolidated.length} episodes consolidated, ${report.failed.length} failed, ${report.remaining} still in the inbox.

${section("⚖ Disputes awaiting your ruling", disputes)}
${section("❓ Rumors (unverified)", rumors)}
${section(`🕸 Stale canon (not re-confirmed in ${vault.config.curator.stale_after_days} days)`, stale)}
${section("🧩 Orphan notes (no relations)", orphans)}
${section("✗ Episodes that failed to consolidate", failed)}`,
  );
}
