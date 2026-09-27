import {
  HANDBOOK_PATH,
  SearchIndex,
  Vault,
  activeQuests,
  addRelation,
  applyFact,
  applyQuestUpdate,
  applyRulings,
  displayName,
  isSecretRef,
  link,
  normalizeName,
  redact,
  renderDoc,
  renderHandbook,
  setSummary,
  type Entity,
  type Episode,
  type FactResult,
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
}

const REVIEW_PATH = "_hippo/review.md";

/** One consolidation pass: inbox episodes → canon, like sleep turning episodic into semantic memory. */
export async function sleep(opts: SleepOptions): Promise<SleepReport> {
  const log = opts.log ?? (() => {});
  const llm = timed(opts.llm, log);
  const vault = await Vault.load(opts.store, { now: opts.now });
  const report: SleepReport = { model: opts.llm.name, rulings: [], consolidated: [], failed: [], summaries: [], remaining: 0, changed: [], warnings: [] };

  report.rulings = applyRulings(vault);
  for (const r of report.rulings) log(`⚖ ruling applied: ${r}`);

  const batch = vault.episodes.slice(0, opts.limit ?? vault.config.curator.batch_size);
  const evidence = new Map<string, string[]>();
  for (const ep of batch) {
    log(`… ${ep.id} (${ep.agent}): ${ep.text.slice(0, 70).replace(/\s+/g, " ")}`);
    try {
      const r = await consolidate(vault, llm, ep);
      report.consolidated.push(r);
      for (const slug of r.touched) evidence.set(slug, [...(evidence.get(slug) ?? []), ep.secret ? "(secret-bearing episode)" : ep.text]);
      log(`  ✓ touched ${r.touched.join(", ") || "nothing"}${r.created.length ? `; new: ${r.created.join(", ")}` : ""}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.failed.push({ id: ep.id, path: ep.path, error: message });
      log(`  ✗ ${message.slice(0, 200)} (left in inbox)`);
    }
  }

  if (vault.config.curator.summaries) {
    for (const [slug, texts] of evidence) {
      const e = vault.entities.get(slug);
      if (!e || e.fm.type === "party") continue;
      try {
        const { summary } = await llm.object({ name: "summary", schema: summarySchema, ...summaryPrompt(vault, e, texts) });
        setSummary(e, summary);
        vault.markDirty(e);
        report.summaries.push(slug);
      } catch (err) {
        report.warnings.push(`summary for ${slug} failed: ${(err as Error).message}`);
      }
    }
  }

  vault.writeFile(REVIEW_PATH, renderReview(vault, report));
  vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
  report.remaining = vault.episodes.length;
  report.warnings.push(...vault.warnings);
  if (!opts.dryRun) report.changed = await vault.flush();
  return report;
}

async function consolidate(vault: Vault, llm: LLM, ep: Episode): Promise<EpisodeReport> {
  const report: EpisodeReport = { id: ep.id, agent: ep.agent, created: [], touched: [], facts: [], relations: [], quests: [] };
  const prov = { by: ep.agent, at: ep.at, src: [ep.id] };
  const entities = new Map<string, Entity>();

  // Hints the agent gave us are resolved without the model.
  for (const hint of ep.about) {
    const e = vault.resolve(hint);
    if (e && e.fm.type !== "party") entities.set(e.slug, e);
  }

  // 1. Mentions
  const { entities: mentions } = await llm.object({ name: "mentions", schema: mentionsSchema(vault.config), ...mentionsPrompt(vault, ep) });

  // 2. Resolve each mention to an existing entity, or create one.
  for (const m of mentions) {
    if (!m.name.trim() || !vault.config.types[m.type]) continue;
    let e = [m.name, ...m.aliases].map((n) => vault.resolve(n)).find((x) => x && x.fm.type !== "party");
    if (!e) {
      const index = new SearchIndex(vault);
      const candidates = index
        .search(m.name, { kind: "entity", limit: 5 })
        .map((h) => vault.entities.get(h.id)!)
        .filter((c) => c && c.fm.type !== "party");
      if (candidates.length) {
        const { match } = await llm.object({ name: "match", schema: matchSchema(candidates.map((c) => c.slug)), ...matchPrompt(m.name, m.type, ep, candidates) });
        e = match === "new" ? undefined : vault.entities.get(match);
      }
    }
    if (e) {
      vault.addAliases(e, [m.name, ...m.aliases].filter((a) => normalizeName(a) !== normalizeName(e!.slug)));
    } else {
      const allowed = new Set(vault.config.domains.map((d) => d.toLowerCase()));
      let tags = m.domains.map((d) => d.toLowerCase()).filter((d) => allowed.has(d));
      if (!tags.length) tags = (vault.party(ep.agent)?.fm.authority ?? []).map((d) => d.toLowerCase());
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
      ...claimsPrompt(vault, ep, list, quests),
    });

    // 4. Reconcile & apply (deterministic).
    for (const f of claims.facts) {
      const e = entities.get(f.entity);
      const value = f.value.trim();
      if (!e || !value || /^(unknown|n\/a|none|null)$/i.test(value)) continue;
      const secret = f.secret || (ep.secret === true && looksLikeIdentifier(value));
      if (secret) secretsSeen.push(value);
      report.facts.push(await applyFact(vault, e, f.field, value, prov, { secret }));
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

  report.touched = [...new Set([...entities.keys()])];
  // 5. Episodic → chronicle (secrets redacted), then out of the inbox.
  await vault.appendChronicle(ep, report.touched, redact(ep.text, secretsSeen));
  vault.archiveEpisode(ep);
  return report;
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
  const staleBefore = new Date(Date.parse(now) - vault.config.curator.stale_after_days * 86400_000).toISOString();
  const stale: string[] = [];
  const rumors: string[] = [];
  for (const e of vault.entities.values()) {
    for (const [k, f] of Object.entries(e.fm.facts)) {
      const v = isSecretRef(f.value) ? "🔒" : String(f.value);
      if (f.status === "rumor") rumors.push(`- ${link(e.slug)} · **${k}** = ${v} (${f.by})`);
      if (f.status === "canon" && f.at && f.at < staleBefore) stale.push(`- ${link(e.slug)} · **${k}** = ${v} (last seen ${f.at.slice(0, 10)})`);
    }
  }
  const disputes = vault.openDisputes().map((d) => `- ${link(d.slug)} — ${d.fm.entity} · ${d.fm.field}: ${d.fm.claims.map((c) => `${c.value} (${c.by ?? "human"})`).join(" vs ")}`);
  const failed = report.failed.map((f) => `- \`${f.path}\` — ${f.error.slice(0, 160)}`);
  const orphans = [...vault.entities.values()]
    .filter((e) => e.fm.type !== "party" && !e.fm.relations.length && !vault.neighbors(e.slug).length)
    .map((e) => `- ${link(e.slug)} (${e.fm.type}: ${displayName(e)})`);
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
