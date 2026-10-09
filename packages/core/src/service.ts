import { displayName, formatValue, getObjectives, getSummary, type Entity } from "./entity.ts";
import { createEpisode, type NewEpisode } from "./episode.ts";
import { HANDBOOK_PATH, renderHandbook, renderOnboarding } from "./handbook.ts";
import { INTRODUCTION_LIMITS, createIntroduction, type NewIntroduction } from "./introduction.ts";
import { humanText } from "./markdown.ts";
import { addPartyMember, applyQuestUpdate, applyRuling, assertAgentId, isSecretField, type NewPartyMember, type QuestUpdate } from "./ops.ts";
import { miniSearcher, type SearcherFactory } from "./search.ts";
import type { Clock, FactStatus, FactValue } from "./schema.ts";
import { StoreConflictError, type VaultStore } from "./store.ts";
import { fold, isoDate, truncate } from "./text.ts";
import { ACTOR_TRAILER, actorTrailer, withTrailers } from "./trailers.ts";
import { Vault, VaultError } from "./vault.ts";
import {
  catalog,
  chroniclePage,
  entityCard,
  entityDetail,
  episodeView,
  graph,
  lastSleepAt,
  overview,
  parseChronicleDay,
  refOf,
  shown,
  upcomingDates,
  viewContext,
  type Catalog,
  type ChroniclePage,
  type EntityDetail,
  type Graph,
  type Overview,
  type SearchResult,
  type Shown,
} from "./views.ts";
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

function factViews(e: Entity, limit = Infinity): FactView[] {
  return Object.entries(e.fm.facts)
    .slice(0, limit)
    .map(([field, f]) => ({ field, value: formatValue(f.value), status: f.status, by: f.by ?? "human", at: f.at }));
}

/** Episode text limit: a memory is one concrete thing, and every byte goes through the curator's prompts. */
export const MAX_EPISODE_BYTES = 8 * 1024;

export interface ActAs {
  /** Act as the vault's human (`config.human`) instead of the agent named in the call. */
  asHuman?: boolean;
}

function actingAs(vault: Vault, agent: string, opts: ActAs): string {
  return opts.asHuman ? vault.config.human : assertAgentId(vault, agent);
}

/** `message` signed with who made it, for `hippo audit`: `agent` is an agent id, or undefined for the human. */
function signed(message: string, agent?: string): string {
  return withTrailers(message, { [ACTOR_TRAILER]: actorTrailer(agent ? { kind: "agent", id: agent } : { kind: "human" }) });
}

export interface ApproveIntroduction {
  /** The human's choices; the introduction's own title and lane fill in what's left out. */
  title?: string;
  lane?: string;
  authority?: string[];
}

export interface IntroduceResult {
  /** `pending` until the human approves; `member` if the agent already has a party note (`path`). */
  status: "pending" | "member";
  agent: string;
  path: string;
  message: string;
}

function checkIntroduction(input: NewIntroduction): void {
  if (!input.title?.trim()) throw new VaultError("title is required");
  for (const [field, max] of Object.entries(INTRODUCTION_LIMITS) as [keyof NewIntroduction, number][]) {
    const value = input[field];
    if (value && value.length > max) throw new VaultError(`${field} can be at most ${max} characters`);
  }
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

  /**
   * Read-modify-write on fresh state. If someone else committed meanwhile (StoreConflictError),
   * redo it once on the newer state.
   */
  private async mutate<T>(fn: (vault: Vault) => Promise<{ message: string; result: T }> | { message: string; result: T }): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const vault = await this.vault();
      const { message, result } = await fn(vault);
      try {
        if (vault.hasChanges()) await vault.flush({ message });
        return result;
      } catch (err) {
        if (!(err instanceof StoreConflictError) || attempt > 0) throw err;
      }
    }
  }

  async handbook(): Promise<string> {
    return renderHandbook(await this.vault());
  }

  async onboard(agent: string): Promise<string> {
    return renderOnboarding(await this.vault(), agent);
  }

  /**
   * File one episode in the inbox. `agent` must be an agent's exact id; the human's own memories
   * (the dashboard, `hippo remember` without `-a`) pass `asHuman`, which files them under `config.human`.
   */
  async remember(agent: string, input: Omit<NewEpisode, "agent">, opts: ActAs = {}): Promise<{ id: string; path: string }> {
    if (!input.text?.trim()) throw new VaultError("text is required");
    const bytes = new TextEncoder().encode(input.text).length;
    if (bytes > MAX_EPISODE_BYTES) throw new VaultError(`text is ${bytes} bytes; one memory can be at most ${MAX_EPISODE_BYTES} (8 KB), so split it into several`);
    const vault = await this.vault();
    const id = actingAs(vault, agent, opts);
    const ep = createEpisode(vault.config.folders.inbox, { ...input, agent: id }, this.opts.now?.());
    vault.addEpisode(ep);
    await vault.flush({ message: signed(`remember(${id}): ${ep.id}`, opts.asHuman ? undefined : id) });
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
    if (!e) throw new VaultError(`no entity "${ref}"${await this.suggest(vault, ref)}`);
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

    const upcoming = upcomingDates(vault, today, horizon).map(({ what, date, slug }) => ({ what, date, ref: link(slug) }));

    return {
      since,
      chronicle: chronicle.slice(-40),
      updated,
      upcoming,
      disputes: vault.openDisputes().map((d) => ({ ref: link(d.slug), entity: d.fm.entity, field: d.fm.field })),
      pending_inbox: vault.episodes.length,
    };
  }

  async updateQuest(agent: string, ref: string, update: QuestUpdate, opts: ActAs = {}) {
    return this.mutate((vault) => {
      const by = actingAs(vault, agent, opts);
      const quest = vault.resolve(ref);
      if (!quest || quest.fm.type !== "quest") throw new VaultError(`no quest "${ref}"`);
      const changes = applyQuestUpdate(vault, quest, update, by);
      if (changes.length) vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
      return { message: signed(`quest(${quest.slug}): ${changes.join("; ")}`, opts.asHuman ? undefined : by), result: { quest: link(quest.slug), changes } };
    });
  }

  // ── Human views and actions (the dashboard) ──────────────────────────────────

  async overview(): Promise<Overview> {
    return overview(await this.vault());
  }

  async catalog(): Promise<Catalog> {
    return catalog(await this.vault());
  }

  async graph(): Promise<Graph> {
    return graph(await this.vault());
  }

  async chronicle(month?: string): Promise<ChroniclePage> {
    return chroniclePage(await this.vault(), month);
  }

  async entityDetail(ref: string): Promise<EntityDetail> {
    const vault = await this.vault();
    const e = vault.resolve(ref);
    if (!e) throw new VaultError(`no entity "${ref}"${await this.suggest(vault, ref)}`);
    return entityDetail(vault, e);
  }

  async search(query: string, opts: { limit?: number } = {}): Promise<SearchResult> {
    const vault = await this.vault();
    const index = await this.searcher(vault);
    const ctx = viewContext(vault);
    const entities = (await index.search(query, { kind: "entity", limit: opts.limit ?? 8 })).map((h) => vault.entities.get(h.id)!).filter(Boolean);
    const seen = new Set(entities.map((e) => e.slug));
    const related: SearchResult["related"] = [];
    for (const e of entities.slice(0, 3)) {
      for (const n of vault.neighbors(e.slug)) {
        if (seen.has(n.entity.slug)) continue;
        seen.add(n.entity.slug);
        related.push({ ref: refOf(n.entity), via: n.dir === "out" ? `${displayName(e)} —${n.rel}→` : `←${n.rel}— ${displayName(e)}` });
      }
    }
    const lastSleep = await lastSleepAt(vault);
    const pending = (await index.search(query, { kind: "episode", limit: 5 }))
      .map((h) => vault.episodes.find((ep) => ep.id === h.id)!)
      .filter(Boolean)
      .map((ep) => episodeView(ep, lastSleep));
    return { entities: entities.map((e) => entityCard(ctx, e)), related: related.slice(0, 10), pending };
  }

  /**
   * The human settles a dispute: pick one of the claims, apply a ruling already written in Obsidian
   * (`pending`), or give a new value. It becomes canon right away, exactly as the next sleep would.
   */
  async rule(dispute: string, choice: { claim?: number; value?: string; pending?: boolean }, opts: { via?: string } = {}) {
    return this.mutate((vault) => {
      const slug = unwrapLink(dispute);
      const d = vault.disputes.get(slug);
      if (!d || d.fm.status !== "open") throw new VaultError(`no open dispute "${dispute}"`);
      const entity = vault.resolve(d.fm.entity);
      if (!entity) throw new VaultError(`dispute ${slug} is about ${d.fm.entity}, which no longer exists`);
      let value: FactValue;
      if (choice.claim !== undefined) {
        const claim = d.fm.claims[choice.claim];
        if (!claim) throw new VaultError(`dispute ${slug} has no claim #${choice.claim}`);
        value = claim.value;
      } else if (choice.pending) {
        if (d.fm.ruling === undefined || d.fm.ruling === "") throw new VaultError(`dispute ${slug} has no ruling written yet`);
        value = d.fm.ruling;
      } else if (choice.value?.trim()) {
        // A typed value would be written into the note in plain text; secrets only come in through claims.
        if (isSecretField(vault, entity, d.fm.field)) throw new VaultError(`${entity.slug}.${d.fm.field} is secret: pick one of the claims instead`);
        value = choice.value.trim();
      } else {
        throw new VaultError("pick a claim or give a value");
      }
      applyRuling(vault, d, value);
      vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
      const result: { dispute: string; entity: string; field: string } & Shown = { dispute: slug, entity: entity.slug, field: d.fm.field, ...shown(value) };
      return { message: signed(`rule(${vault.config.human}${opts.via ? ` via ${opts.via}` : ""}): ${entity.slug}.${d.fm.field} = ${result.secret ? "🔒" : result.value}`), result };
    });
  }

  /** The human adds an agent to the party (which settles any introduction it had pending). */
  async addPartyMember(input: NewPartyMember, opts: { via?: string } = {}) {
    return this.mutate((vault) => {
      const e = addPartyMember(vault, input);
      vault.removeIntroductions(e.slug);
      vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
      return { message: signed(`party(${vault.config.human}${opts.via ? ` via ${opts.via}` : ""}): add ${e.slug}`), result: { slug: e.slug, path: e.path } };
    });
  }

  /**
   * An agent asks to join the party. It stays an outsider (its word counts as rumor) until the human
   * approves; a new introduction replaces its earlier one. A party member just hears that it's in.
   */
  async introduce(agent: string, input: NewIntroduction): Promise<IntroduceResult> {
    checkIntroduction(input);
    return this.mutate<IntroduceResult>((vault) => {
      const id = assertAgentId(vault, agent);
      const member = vault.partyMember(id);
      if (member) {
        return { message: "", result: { status: "member", agent: id, path: member.path, message: `already in the party as ${displayName(member)} (${member.path})` } };
      }
      const intro = createIntroduction(vault.config.folders.inbox, id, input, this.opts.now?.());
      vault.addIntroduction(intro);
      const human = vault.config.human;
      return {
        message: signed(`introduce(${id}): ${intro.title}`, id),
        result: { status: "pending", agent: id, path: intro.path, message: `waiting for ${human}'s approval. Until then your memories count as rumors.` },
      };
    });
  }

  /** The human seats an introduced agent: its party note gets the human's choices over what it asked for. */
  async approveIntroduction(agent: string, choice: ApproveIntroduction = {}, opts: { via?: string } = {}) {
    return this.mutate((vault) => {
      const id = assertAgentId(vault, agent);
      const intro = vault.introductionOf(id);
      if (!intro) throw new VaultError(`no pending introduction from "${id}"`);
      const e = addPartyMember(vault, {
        id,
        title: choice.title?.trim() || intro.title,
        lane: choice.lane ?? intro.lane,
        authority: choice.authority,
        host: intro.host,
      });
      vault.removeIntroductions(id);
      vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
      return { message: signed(`party(${vault.config.human}${opts.via ? ` via ${opts.via}` : ""}): approve ${id}`), result: { slug: e.slug, path: e.path } };
    });
  }

  /** The human turns an introduction down. The agent can still write; its word stays a rumor. */
  async dismissIntroduction(agent: string, opts: { via?: string } = {}) {
    return this.mutate((vault) => {
      const id = assertAgentId(vault, agent);
      const removed = vault.removeIntroductions(id);
      if (!removed.length) throw new VaultError(`no pending introduction from "${id}"`);
      return { message: signed(`party(${vault.config.human}${opts.via ? ` via ${opts.via}` : ""}): dismiss ${id}`), result: { agent: id, removed } };
    });
  }

  private async suggest(vault: Vault, ref: string): Promise<string> {
    const candidates = (await (await this.searcher(vault)).search(unwrapLink(ref), { kind: "entity", limit: 5 })).map((h) => link(h.id));
    return candidates.length ? `; did you mean ${candidates.join(", ")}?` : "";
  }
}

/** Chronicle entries in the compact form agents get (text cut to 300 characters). */
export function parseChronicle(day: string, content: string): ChronicleEntry[] {
  return parseChronicleDay(day, content).map((e) => ({ id: e.id, agent: e.agent, kind: e.kind, at: `${e.day}T${e.time}`, text: truncate(e.text, 300) }));
}
