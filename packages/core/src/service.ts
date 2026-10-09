import { displayName, formatValue, getObjectives, getSummary, type Entity } from "./entity.ts";
import { createEpisode, type NewEpisode } from "./episode.ts";
import { HANDBOOK_PATH, renderHandbook, renderOnboarding } from "./handbook.ts";
import { humanText } from "./markdown.ts";
import { applyQuestUpdate, type QuestUpdate } from "./ops.ts";
import { miniSearcher, type SearcherFactory } from "./search.ts";
import type { Clock, FactStatus } from "./schema.ts";
import { StoreConflictError, type VaultStore } from "./store.ts";
import { fold, isoDate, truncate } from "./text.ts";
import { Vault, VaultError } from "./vault.ts";
import { link, unwrapLink } from "./wikilink.ts";

export interface FactView {
  field: string;
  value: string;
  status: FactStatus;
  by: string;
  at?: string;
}

export interface EntityBrief {
  ref: string;
  type: string;
  title: string;
  summary: string;
  facts: FactView[];
}

export interface EntityView extends EntityBrief {
  path: string;
  aliases: string[];
  tags: string[];
  status?: string;
  owner?: string;
  deadline?: string;
  objectives?: { text: string; done: boolean }[];
  clocks?: Clock[];
  relations: { rel: string; dir: "out" | "in"; ref: string; title: string }[];
  disputes: string[];
  notes: string;
}

export interface EpisodeBrief {
  id: string;
  agent: string;
  kind: string;
  at: string;
  text: string;
}

export interface ChronicleEntry extends EpisodeBrief {}

const DATEISH = /(date|deadline|expir|appointment|due|until|start|end)/;

function factViews(e: Entity, limit = Infinity): FactView[] {
  return Object.entries(e.fm.facts)
    .slice(0, limit)
    .map(([field, f]) => ({ field, value: formatValue(f.value), status: f.status, by: f.by ?? "human", at: f.at }));
}

function brief(e: Entity, factLimit = 8): EntityBrief {
  return { ref: link(e.slug), type: e.fm.type, title: displayName(e), summary: truncate(getSummary(e), 400), facts: factViews(e, factLimit) };
}

/** The operations agents perform on memory. Transport-agnostic: used by the MCP server and CLI. */
export class HippoService {
  constructor(
    readonly store: VaultStore,
    private readonly opts: { now?: () => Date; searcher?: SearcherFactory } = {},
  ) {}

  /** Load fresh on every call so edits from Obsidian, git pulls and the curator are always visible. */
  async vault(): Promise<Vault> {
    await this.store.refresh?.();
    return Vault.load(this.store, this.opts);
  }

  private async searcher(vault: Vault) {
    return (this.opts.searcher ?? miniSearcher)(vault);
  }

  async handbook(): Promise<string> {
    return renderHandbook(await this.vault());
  }

  async onboard(agent: string): Promise<string> {
    return renderOnboarding(await this.vault(), agent);
  }

  async remember(agent: string, input: Omit<NewEpisode, "agent">): Promise<{ id: string; path: string }> {
    if (!input.text?.trim()) throw new VaultError("text is required");
    const vault = await this.vault();
    const id = vault.party(agent)?.slug ?? agent;
    const ep = createEpisode(vault.config.folders.inbox, { ...input, agent: id }, this.opts.now?.());
    vault.addEpisode(ep);
    await vault.flush({ message: `remember(${id}): ${ep.id}` });
    return { id: ep.id, path: ep.path };
  }

  async recall(query: string, opts: { types?: string[]; limit?: number } = {}) {
    const vault = await this.vault();
    const index = await this.searcher(vault);
    const limit = opts.limit ?? 6;
    const hits = await index.search(query, { kind: "entity", types: opts.types, limit });
    const entities = hits.map((h) => vault.entities.get(h.id)!).filter(Boolean);
    const seen = new Set(entities.map((e) => e.slug));
    const related: { ref: string; title: string; via: string }[] = [];
    for (const e of entities.slice(0, 3)) {
      for (const n of vault.neighbors(e.slug)) {
        if (seen.has(n.entity.slug)) continue;
        seen.add(n.entity.slug);
        related.push({ ref: link(n.entity.slug), title: displayName(n.entity), via: `${n.dir === "out" ? `${e.slug} —${n.rel}→` : `←${n.rel}— ${e.slug}`}` });
      }
    }
    const recent: EpisodeBrief[] = (await index.search(query, { kind: "episode", limit: 5 }))
      .map((h) => vault.episodes.find((ep) => ep.id === h.id)!)
      .filter(Boolean)
      .map((ep) => ({ id: ep.id, agent: ep.agent, kind: ep.kind, at: ep.at, text: truncate(ep.text, 300) }));
    return { entities: entities.map((e) => brief(e)), related: related.slice(0, 10), pending: recent };
  }

  async get(ref: string): Promise<EntityView> {
    const vault = await this.vault();
    const e = vault.resolve(ref);
    if (!e) {
      const candidates = (await (await this.searcher(vault)).search(unwrapLink(ref), { kind: "entity", limit: 5 })).map((h) => link(h.id));
      throw new VaultError(`no entity "${ref}"${candidates.length ? `; did you mean ${candidates.join(", ")}?` : ""}`);
    }
    return {
      ...brief(e, Infinity),
      summary: getSummary(e),
      path: e.path,
      aliases: e.fm.aliases,
      tags: e.fm.tags,
      status: e.fm.status,
      owner: e.fm.owner,
      deadline: e.fm.deadline,
      objectives: e.fm.type === "quest" ? getObjectives(e) : undefined,
      clocks: e.fm.clocks,
      relations: vault.neighbors(e.slug).map((n) => ({ rel: n.rel, dir: n.dir, ref: link(n.entity.slug), title: displayName(n.entity) })),
      disputes: vault
        .openDisputes()
        .filter((d) => unwrapLink(d.fm.entity) === e.slug)
        .map((d) => `${link(d.slug)} (${d.fm.field})`),
      notes: truncate(humanText(e.body).replace(/^## Notes\s*/, ""), 1500),
    };
  }

  async neighbors(ref: string, opts: { rel?: string; depth?: number } = {}) {
    const vault = await this.vault();
    const start = vault.resolve(ref);
    if (!start) throw new VaultError(`no entity "${ref}"`);
    const depth = Math.min(Math.max(opts.depth ?? 1, 1), 3);
    const edges: { from: string; rel: string; to: string }[] = [];
    const visited = new Set([start.slug]);
    let frontier = [start.slug];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const slug of frontier) {
        for (const n of vault.neighbors(slug)) {
          if (opts.rel && n.rel !== opts.rel) continue;
          const [from, to] = n.dir === "out" ? [slug, n.entity.slug] : [n.entity.slug, slug];
          if (!edges.some((x) => x.from === from && x.to === to && x.rel === n.rel)) edges.push({ from, rel: n.rel, to });
          if (!visited.has(n.entity.slug)) {
            visited.add(n.entity.slug);
            next.push(n.entity.slug);
          }
        }
      }
      frontier = next;
    }
    const nodes = [...visited].map((s) => {
      const e = vault.entities.get(s)!;
      return { ref: link(s), type: e.fm.type, title: displayName(e) };
    });
    return { nodes, edges };
  }

  /** Archivist: the single canonical answer to a factual question, with status and provenance. */
  async askCanon(question: string) {
    const vault = await this.vault();
    const index = await this.searcher(vault);
    const terms = fold(question)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 2);
    const answers: (FactView & { entity: string; score: number })[] = [];
    for (const hit of await index.search(question, { kind: "entity", limit: 5 })) {
      const e = vault.entities.get(hit.id)!;
      for (const f of factViews(e)) {
        const hay = fold(`${f.field.replace(/_/g, " ")} ${f.value}`);
        const overlap = terms.filter((t) => hay.includes(t)).length;
        answers.push({ ...f, entity: link(e.slug), score: hit.score * (1 + overlap) });
      }
    }
    answers.sort((a, b) => b.score - a.score);
    const top = answers.slice(0, 8).map(({ score: _s, ...rest }) => rest);
    const entities = new Set(top.map((a) => unwrapLink(a.entity)));
    const disputes = vault
      .openDisputes()
      .filter((d) => entities.has(unwrapLink(d.fm.entity)))
      .map((d) => ({ ref: link(d.slug), entity: d.fm.entity, field: d.fm.field, claims: d.fm.claims.map((c) => `${c.value} (${c.by ?? "human"})`) }));
    return { facts: top, disputes, pending_inbox: vault.episodes.length };
  }

  /** "Previously on…": what changed since a date, what's disputed, what's due soon. */
  async briefing(opts: { since?: string; horizonDays?: number } = {}) {
    const vault = await this.vault();
    const now = this.opts.now?.() ?? new Date();
    const since = opts.since ? isoDate(opts.since) : isoDate(new Date(now.getTime() - 7 * 86400_000));
    const horizon = isoDate(new Date(now.getTime() + (opts.horizonDays ?? 30) * 86400_000));
    const today = isoDate(now);

    const chronicle: ChronicleEntry[] = [];
    for (const path of await this.store.list(vault.config.folders.chronicle)) {
      const day = path.split("/").pop()!.replace(/\.md$/, "");
      if (day < since) continue;
      chronicle.push(...parseChronicle(day, (await this.store.read(path)) ?? ""));
    }

    const updated = [...vault.entities.values()]
      .filter((e) => e.fm.updated && e.fm.updated.slice(0, 10) >= since && e.fm.type !== "party")
      .map((e) => ({ ref: link(e.slug), type: e.fm.type, title: displayName(e), updated: e.fm.updated!, by: e.fm.updated_by }));

    const upcoming: { what: string; date: string; ref: string }[] = [];
    for (const e of vault.entities.values()) {
      if (e.fm.deadline && e.fm.deadline >= today && e.fm.deadline <= horizon) upcoming.push({ what: "deadline", date: e.fm.deadline, ref: link(e.slug) });
      for (const c of e.fm.clocks ?? []) if (c.deadline && c.deadline >= today && c.deadline <= horizon) upcoming.push({ what: `clock ${c.name} ${c.filled}/${c.segments}`, date: c.deadline, ref: link(e.slug) });
      for (const [field, f] of Object.entries(e.fm.facts)) {
        const v = String(f.value);
        if (DATEISH.test(field) && /^\d{4}-\d{2}-\d{2}/.test(v) && v.slice(0, 10) >= today && v.slice(0, 10) <= horizon)
          upcoming.push({ what: `${field} (${f.status})`, date: v, ref: link(e.slug) });
      }
    }
    upcoming.sort((a, b) => a.date.localeCompare(b.date));

    return {
      since,
      chronicle: chronicle.slice(-40),
      updated,
      upcoming,
      disputes: vault.openDisputes().map((d) => ({ ref: link(d.slug), entity: d.fm.entity, field: d.fm.field })),
      pending_inbox: vault.episodes.length,
    };
  }

  async updateQuest(agent: string, ref: string, update: QuestUpdate) {
    // Read-modify-write on canon: if someone else changed the quest meanwhile, redo it on fresh state once.
    for (let attempt = 0; ; attempt++) {
      const vault = await this.vault();
      const quest = vault.resolve(ref);
      if (!quest || quest.fm.type !== "quest") throw new VaultError(`no quest "${ref}"`);
      const changes = applyQuestUpdate(vault, quest, update, agent);
      try {
        if (changes.length) {
          vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
          await vault.flush({ message: `quest(${quest.slug}): ${changes.join("; ")}` });
        }
        return { quest: link(quest.slug), changes };
      } catch (err) {
        if (!(err instanceof StoreConflictError) || attempt > 0) throw err;
      }
    }
  }
}

const ENTRY_RE = /> \[!episode\] (\d\d:\d\d) · \[\[([^\]|]+)[^\]]*\]\] · (\w+)\n((?:>.*\n?)*)\n*\^(ep-[\w-]+)/g;

export function parseChronicle(day: string, content: string): ChronicleEntry[] {
  const out: ChronicleEntry[] = [];
  for (const m of content.matchAll(ENTRY_RE)) {
    const text = (m[4] ?? "")
      .split("\n")
      .map((l) => l.replace(/^> ?/, ""))
      .filter((l) => !l.startsWith("↳"))
      .join("\n")
      .trim();
    out.push({ id: m[5]!, agent: m[2]!, kind: m[3]!, at: `${day}T${m[1]}`, text: truncate(text, 300) });
  }
  return out;
}
