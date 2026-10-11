import { actorProps } from "./actor.ts";
import { CONFIG_PATH, addDomains, domainIds, linkHuman, type HumanLogins } from "./config.ts";
import { displayName, formatValue, getHumanGuidelines, getSummary, type Entity } from "./entity.ts";
import { applyGoalUpdate, getObjectives, goalProps, goalStateOf, legacyClocks, nextDue, type Clock, type GoalState, type GoalUpdate, type Progress, type Repeat } from "./goal.ts";
import { createEpisode, type NewEpisode } from "./episode.ts";
import { HANDBOOK_PATH, renderHandbook, renderOnboarding } from "./handbook.ts";
import { validateEpisode } from "./kinds.ts";
import { INTRODUCTION_LIMITS, createIntroduction, type NewIntroduction } from "./introduction.ts";
import { resolveInheritance, type InheritedGuideline } from "./inherit.ts";
import { humanText } from "./markdown.ts";
import { addPartyMember, applyRuling, assertAgentId, declineProposal, isSecretField, questToGoalUpdate, retractFact, type NewPartyMember, type QuestUpdate } from "./ops.ts";
import { miniSearcher, type SearcherFactory } from "./search.ts";
import type { DecisionEntry, DisputeKind, FactStatus, FactValue, Guideline, ProposalState, QuestionEntry, Stats } from "./schema.ts";
import { StoreConflictError, bufferedStore, type VaultStore } from "./store.ts";
import { fold, isoDate, localParts, parseFactKey, truncate } from "./text.ts";
import { ACTOR_TRAILER, actorTrailer, withTrailers } from "./trailers.ts";
import { Vault, VaultError } from "./vault.ts";
import {
  addDays,
  cadenceOf,
  catalog,
  chroniclePage,
  entityCard,
  entityDetail,
  episodeView,
  graph,
  isConfidentialField,
  lastSleepAt,
  overdueContacts,
  overview,
  parseChronicleDay,
  readChronicle,
  refOf,
  seesConfidential,
  shown,
  upcomingDates,
  viewContext,
  type CadenceView,
  type Catalog,
  type ChronicleEntryView,
  type ChroniclePage,
  type EntityDetail,
  type Graph,
  type Overview,
  type ReadAs,
  type SearchResult,
  type Shown,
} from "./views.ts";
import { link, parseLinks, unwrapLink } from "./wikilink.ts";

export interface FactView {
  /** The `facts:` key: the field, or `field@scope`. */
  field: string;
  value: string;
  status: FactStatus;
  by: string;
  at?: string;
  /** The context it holds in (`lang:pt`), when the key has one. */
  scope?: string;
  valid_from?: string;
  valid_until?: string;
  confidence?: number;
  /** The value is confidential: shown only to a bound caller with authority over it, else masked. */
  confidential?: true;
}


export interface GuidelinesView {
  /** The human's own guidelines: the prose under the note's `## Guidelines` heading. */
  human: string;
  /** The entity's own guidelines. */
  items: Guideline[];
  /** Guidelines it inherits (`extends:`, inheritable tags), each with the note it comes from. */
  inherited: InheritedGuideline[];
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
  /** Goals: the core state behind `status`. */
  state?: GoalState;
  owner?: string;
  counterparty?: string;
  due?: string;
  /** Goals: when it's next due (a repeat after the last contact counts from that contact). */
  next_due?: string;
  progress?: Progress;
  repeat?: Repeat;
  last_done?: string;
  /** @deprecated Same as `due`. */
  deadline?: string;
  objectives?: { text: string; done: boolean }[];
  /** @deprecated v1 clocks, until the migration turns them into progress and objectives. */
  clocks?: Clock[];
  /** Goals: the status as written (a core state or a word of the type's vocabulary). */
  word?: string;
  /** Agents: what it handles, where its word is authoritative, where it runs. */
  lane?: string;
  authority?: string[];
  host?: string;
  guidelines?: GuidelinesView;
  stats?: Stats;
  decisions?: DecisionEntry[];
  questions?: QuestionEntry[];
  /** Notes it inherits from: its `extends:` chain (nearest first), then inheritable notes its tags name. */
  inherits?: string[];
  cadence?: CadenceView;
  relations: { rel: string; dir: "out" | "in"; ref: string; title: string }[];
  disputes: string[];
  notes: string;
}

/** A proposal settled by a human; `value` (masked like any shown value) only when accepted. */
export interface ProposalDecision extends Partial<Shown> {
  proposal: string;
  decision: "accepted" | "declined";
  entity: string;
  field: string;
}

/** What to know before talking to someone (`briefing` with `about`). */
export interface PersonBrief extends EntityBrief {
  guidelines: GuidelinesView;
  /** The last three interactions with them in the past 90 days, newest first. */
  interactions: ChronicleEntry[];
  /** Open goals they own or are the counterparty of. */
  goals: { ref: string; title: string; role: "owner" | "counterparty"; state: GoalState; next_due?: string; progress?: Progress }[];
  /** Open disputes, proposals and possible merges about them. */
  disputes: { ref: string; kind: DisputeKind; field: string; state?: ProposalState }[];
  stats?: Stats;
  cadence?: CadenceView;
}

export interface EpisodeBrief {
  id: string;
  agent: string;
  kind: string;
  at: string;
  text: string;
}

export interface ChronicleEntry extends EpisodeBrief {}

/** Whether this reader sees `field`'s confidential value: the human (dashboard), or a bound agent with authority over it. */
function sees(vault: Vault, read: ReadAs, e: Entity, field: string): boolean {
  return !!read.human || seesConfidential(vault, read.caller, e, field);
}

// Confidential values stay masked unless the human reads, or the caller is a bound agent with authority over them.
function factViews(vault: Vault, e: Entity, opts: ReadAs & { limit?: number } = {}): FactView[] {
  return Object.entries(e.fm.facts)
    .slice(0, opts.limit ?? Infinity)
    .map(([field, f]) => {
      const confidential = isConfidentialField(vault, e, field, f);
      const { scope } = parseFactKey(field);
      return {
        field,
        value: formatValue(f.value, { confidential: confidential && !sees(vault, opts, e, field) }),
        status: f.status,
        by: f.by ?? vault.config.human,
        at: f.at,
        ...(scope ? { scope } : {}),
        ...(f.valid_from ? { valid_from: f.valid_from } : {}),
        ...(f.valid_until ? { valid_until: f.valid_until } : {}),
        ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
        ...(confidential ? { confidential: true as const } : {}),
      };
    });
}

function guidelinesView(vault: Vault, e: Entity): GuidelinesView {
  return {
    human: getHumanGuidelines(e),
    items: e.fm.guidelines ?? [],
    inherited: resolveInheritance(vault, e).guidelines.filter((g) => g.source !== e.slug),
  };
}

/** Whether a chronicle entry is about `e`: it touched it, or its text links it. */
function mentions(vault: Vault, entry: ChronicleEntryView, e: Entity): boolean {
  return [...entry.touched, ...parseLinks(entry.text).map((l) => l.target)].some((t) => t === e.slug || vault.resolve(t)?.slug === e.slug);
}

/** Episode text limit: a memory is one concrete thing, and every byte goes through the curator's prompts. */
export const MAX_EPISODE_BYTES = 8 * 1024;

export interface ActAs {
  /**
   * Act as one of the vault's humans instead of the agent named in the call: `true` for the primary
   * human, or a human's id.
   */
  asHuman?: boolean | string;
}

/** The human `asHuman` names (validated), or undefined when acting as an agent. */
function humanOf(vault: Vault, opts: ActAs): string | undefined {
  if (!opts.asHuman) return undefined;
  if (opts.asHuman === true) return vault.config.humans[0]!.id;
  const h = vault.human(opts.asHuman);
  if (!h) throw new VaultError(`"${opts.asHuman}" is not one of this vault's humans (${vault.config.humans.map((x) => x.id).join(", ")})`);
  return h.id;
}

function actingAs(vault: Vault, agent: string, opts: ActAs): string {
  return humanOf(vault, opts) ?? assertAgentId(vault, agent);
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

function brief(vault: Vault, e: Entity, opts: ReadAs & { limit?: number } = {}): EntityBrief {
  return { ref: link(e.slug), type: e.fm.type, title: displayName(e), summary: truncate(getSummary(e), 400), facts: factViews(vault, e, { limit: 8, ...opts }) };
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
  async remember(
    agent: string,
    input: Omit<NewEpisode, "agent">,
    opts: ActAs = {},
  ): Promise<{ id: string; path: string; kind: string; warnings?: string[] }> {
    const bytes = new TextEncoder().encode(input.text ?? "").length + (input.data ? new TextEncoder().encode(JSON.stringify(input.data)).length : 0);
    if (bytes > MAX_EPISODE_BYTES) throw new VaultError(`text is ${bytes} bytes; one memory can be at most ${MAX_EPISODE_BYTES} (8 KB), so split it into several`);
    const vault = await this.vault();
    const id = actingAs(vault, agent, opts);
    // The kind decides whether text is required, kept as a gist or forbidden, and what data it takes.
    const { kind, text, data, warnings } = validateEpisode(vault.schema, input);
    const ep = createEpisode(vault.config.folders.inbox, { ...input, kind, text, data, agent: id }, this.opts.now?.());
    vault.addEpisode(ep);
    await vault.flush({ message: signed(`remember(${id}): ${ep.id}`, opts.asHuman ? undefined : id) });
    return { id: ep.id, path: ep.path, kind: ep.kind, ...(warnings.length ? { warnings } : {}) };
  }

  /** Today in the vault's timezone. */
  private today(vault: Vault): string {
    return localParts(vault.nowIso(), vault.config.timezone).date;
  }

  async recall(query: string, opts: ReadAs & { types?: string[]; limit?: number } = {}) {
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
    return { entities: entities.map((e) => brief(vault, e, { caller: opts.caller, human: opts.human })), related: related.slice(0, 10), pending: recent };
  }

  async get(ref: string, opts: ReadAs = {}): Promise<EntityView> {
    const vault = await this.vault();
    const e = vault.resolve(ref);
    if (!e) throw new VaultError(`no entity "${ref}"${await this.suggest(vault, ref)}`);
    const goal = vault.schema.has(e.fm.type, "goal");
    const p = goal ? goalProps(e) : undefined;
    const clocks = goal ? legacyClocks(e) : [];
    const actor = vault.schema.has(e.fm.type, "actor") ? actorProps(e) : undefined;
    const inheritance = resolveInheritance(vault, e);
    const guidelines = guidelinesView(vault, e);
    const inherits = [...inheritance.chain, ...inheritance.mixins].map((x) => link(x.slug));
    const cadence = cadenceOf(vault, e, this.today(vault));
    return {
      ...brief(vault, e, { caller: opts.caller, human: opts.human, limit: Infinity }),
      summary: getSummary(e),
      path: e.path,
      aliases: e.fm.aliases,
      tags: e.fm.tags,
      status: e.fm.status,
      ...(p
        ? {
            state: goalStateOf(vault, e),
            counterparty: p.counterparty,
            due: p.due,
            next_due: nextDue(e, vault),
            progress: p.progress,
            repeat: p.repeat,
            last_done: p.last_done,
            deadline: p.due,
            word: p.status ?? "active",
          }
        : {}),
      owner: e.fm.owner,
      objectives: goal ? getObjectives(e) : undefined,
      clocks: clocks.length ? clocks : undefined,
      ...(actor ? { lane: actor.lane, authority: actor.authority, host: actor.host } : {}),
      ...(guidelines.human || guidelines.items.length || guidelines.inherited.length ? { guidelines } : {}),
      ...(e.fm.stats ? { stats: e.fm.stats } : {}),
      ...(e.fm.decisions?.length ? { decisions: e.fm.decisions } : {}),
      ...(e.fm.questions?.length ? { questions: e.fm.questions } : {}),
      ...(inherits.length ? { inherits } : {}),
      ...(cadence ? { cadence } : {}),
      relations: vault.neighbors(e.slug).map((n) => ({ rel: n.rel, dir: n.dir, ref: link(n.entity.slug), title: displayName(n.entity) })),
      disputes: vault
        .openDisputes()
        .filter((d) => unwrapLink(d.fm.entity) === e.slug)
        .map((d) => `${link(d.slug)} (${d.fm.field})`),
      notes: truncate(humanText(e.body).replace(/^## Notes\s*/, ""), 1500),
    };
  }

  /**
   * What to know before talking to someone: canon facts, guidelines (own and inherited), the last
   * three interactions in 90 days, open goals with them, open disputes and proposals, and contact stats.
   */
  async personBrief(ref: string, opts: ReadAs = {}): Promise<PersonBrief> {
    const vault = await this.vault();
    const e = vault.resolve(ref);
    if (!e) throw new VaultError(`no entity "${ref}"${await this.suggest(vault, ref)}`);
    const today = this.today(vault);
    const interaction = (kind: string) => vault.schema.kind(kind.split("/")[0]).def.behaviour === "interaction";
    const interactions = (await readChronicle(vault, addDays(today, -89), today))
      .filter((c) => interaction(c.kind) && mentions(vault, c, e))
      .slice(-3)
      .reverse()
      .map((c) => ({ id: c.id, agent: c.agent, kind: c.kind, at: c.at, text: truncate(c.text, 300) }));
    const goals: PersonBrief["goals"] = [];
    for (const g of vault.withCapability("goal")) {
      const state = goalStateOf(vault, g);
      if (state === "done" || state === "failed") continue;
      const p = goalProps(g);
      const role = p.owner && vault.resolve(p.owner)?.slug === e.slug ? "owner" : p.counterparty && vault.resolve(p.counterparty)?.slug === e.slug ? "counterparty" : undefined;
      if (!role) continue;
      const next = nextDue(g, vault);
      goals.push({ ref: link(g.slug), title: displayName(g), role, state, ...(next ? { next_due: next } : {}), ...(p.progress ? { progress: p.progress } : {}) });
    }
    const disputes = vault
      .openDisputes()
      .filter((d) => vault.resolve(d.fm.entity)?.slug === e.slug || (d.fm.targets ?? []).some((t) => vault.resolve(t)?.slug === e.slug))
      .map((d) => ({ ref: link(d.slug), kind: d.fm.kind ?? ("conflict" as const), field: d.fm.field, ...(d.fm.state ? { state: d.fm.state } : {}) }));
    const cadence = cadenceOf(vault, e, today);
    const base = brief(vault, e, { caller: opts.caller, human: opts.human, limit: Infinity });
    return {
      ...base,
      summary: getSummary(e),
      facts: base.facts.filter((f) => f.status === "canon"),
      guidelines: guidelinesView(vault, e),
      interactions,
      goals,
      disputes,
      ...(e.fm.stats ? { stats: e.fm.stats } : {}),
      ...(cadence ? { cadence } : {}),
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
  async askCanon(question: string, opts: ReadAs = {}) {
    const vault = await this.vault();
    const index = await this.searcher(vault);
    const terms = fold(question)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 2);
    const answers: (FactView & { entity: string; score: number })[] = [];
    for (const hit of await index.search(question, { kind: "entity", limit: 5 })) {
      const e = vault.entities.get(hit.id)!;
      for (const f of factViews(vault, e, { caller: opts.caller, human: opts.human })) {
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
      .map((d) => {
        const e = vault.resolve(d.fm.entity);
        // A confidential claim masks the whole dispute, as the fact's own flag does.
        const confidential = vault.disputeHidden(d, e) && !(e && sees(vault, opts, e, d.fm.field));
        return { ref: link(d.slug), entity: d.fm.entity, field: d.fm.field, claims: d.fm.claims.map((c) => `${formatValue(c.value, { confidential })} (${c.by ?? "human"})`) };
      });
    return { facts: top, disputes, pending_inbox: vault.episodes.length };
  }

  /** "Previously on…": what changed since a date, what's disputed, what's due soon. */
  async briefing(opts: { since?: string; horizonDays?: number } = {}) {
    const vault = await this.vault();
    const now = this.opts.now?.() ?? new Date();
    // Days are the vault's local days, so an evening in Lisbon isn't "tomorrow" in UTC.
    const tz = vault.config.timezone;
    const localDay = (d: Date) => localParts(d.toISOString(), tz).date;
    const since = opts.since ? isoDate(opts.since) : localDay(new Date(now.getTime() - 7 * 86400_000));
    const horizon = localDay(new Date(now.getTime() + (opts.horizonDays ?? 30) * 86400_000));
    const today = localDay(now);

    const chronicle: ChronicleEntry[] = [];
    for (const path of await this.store.list(vault.config.folders.chronicle)) {
      const day = path.split("/").pop()!.replace(/\.md$/, "");
      if (day < since) continue;
      chronicle.push(...parseChronicle(day, (await this.store.read(path)) ?? ""));
    }

    const updated = [...vault.entities.values()]
      .filter((e) => e.fm.updated && e.fm.updated.slice(0, 10) >= since && !vault.schema.has(e.fm.type, "actor"))
      .map((e) => ({ ref: link(e.slug), type: e.fm.type, title: displayName(e), updated: e.fm.updated!, by: e.fm.updated_by }));

    const upcoming = upcomingDates(vault, today, horizon).map(({ what, date, slug }) => ({ what, date, ref: link(slug) }));

    return {
      since,
      chronicle: chronicle.slice(-40),
      updated,
      upcoming,
      overdue: overdueContacts(vault, today, vault.config.briefing.overdue_per_day),
      disputes: vault.openDisputes().map((d) => ({ ref: link(d.slug), entity: d.fm.entity, field: d.fm.field })),
      pending_inbox: vault.episodes.length,
    };
  }

  /** Record goal progress directly: status, objectives, progress, due date, owner, counterparty, repeat. */
  async updateGoal(agent: string, ref: string, update: GoalUpdate, opts: ActAs = {}) {
    const { target, changes } = await this.applyGoal(agent, ref, () => update, opts);
    return { goal: target, changes };
  }

  /** @deprecated The v1 shape: a clock becomes progress, a deadline the due date. Use `updateGoal`. */
  async updateQuest(agent: string, ref: string, update: QuestUpdate, opts: ActAs = {}) {
    const { target, changes } = await this.applyGoal(agent, ref, (goal) => questToGoalUpdate(goal, update), opts);
    return { quest: target, changes };
  }

  private applyGoal(agent: string, ref: string, update: (goal: Entity) => GoalUpdate, opts: ActAs) {
    return this.mutate((vault) => {
      const by = actingAs(vault, agent, opts);
      const goal = vault.resolve(ref);
      if (!goal || !vault.schema.has(goal.fm.type, "goal")) throw new VaultError(`no goal "${ref}"`);
      const changes = applyGoalUpdate(vault, goal, update(goal), by);
      if (changes.length) vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
      return { message: signed(`goal(${goal.slug}): ${changes.join("; ")}`, opts.asHuman ? undefined : by), result: { target: link(goal.slug), changes } };
    });
  }

  // ── Human views and actions (the dashboard) ──────────────────────────────────

  /** The dashboard's overview; `human` reveals confidential values to the vault's own human. */
  async overview(opts: ReadAs = {}): Promise<Overview> {
    return overview(await this.vault(), opts);
  }

  async catalog(opts: ReadAs = {}): Promise<Catalog> {
    return catalog(await this.vault(), opts);
  }

  async graph(opts: ReadAs = {}): Promise<Graph> {
    return graph(await this.vault(), opts);
  }

  async chronicle(month?: string, opts: ReadAs = {}): Promise<ChroniclePage> {
    return chroniclePage(await this.vault(), month, opts);
  }

  /** One note for the dashboard; `human` reveals confidential values to the vault's own human. */
  async entityDetail(ref: string, opts: ReadAs = {}): Promise<EntityDetail> {
    const vault = await this.vault();
    const e = vault.resolve(ref);
    if (!e) throw new VaultError(`no entity "${ref}"${await this.suggest(vault, ref)}`);
    return entityDetail(vault, e, opts);
  }

  async search(query: string, opts: { limit?: number } & ReadAs = {}): Promise<SearchResult> {
    const vault = await this.vault();
    const index = await this.searcher(vault);
    const ctx = viewContext(vault, opts);
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
   * A human settles a dispute: pick one of the claims, apply a ruling already written in Obsidian
   * (`pending`), or give a new value. It becomes canon right away, by that human (`as`, default the
   * primary one), exactly as the next sleep would.
   */
  async rule(dispute: string, choice: { claim?: number; value?: string; pending?: boolean }, opts: { as?: string; via?: string } = {}) {
    return this.mutate((vault) => {
      const by = humanOf(vault, { asHuman: opts.as || true })!;
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
      const hidden = vault.disputeHidden(d, entity);
      applyRuling(vault, d, value, by);
      vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
      const confidential = hidden || isConfidentialField(vault, entity, d.fm.field, entity.fm.facts[d.fm.field]);
      const result: { dispute: string; entity: string; field: string } & Shown = { dispute: slug, entity: entity.slug, field: d.fm.field, ...shown(value, { confidential }) };
      // Neither a secret nor a confidential value goes into the commit message.
      return { message: signed(`rule(${by}${opts.via ? ` via ${opts.via}` : ""}): ${entity.slug}.${d.fm.field} = ${result.secret ? "🔒" : result.confidential ? "◐" : result.value}`), result };
    });
  }

  /**
   * A human settles a proposal (or a possible merge): `accept` applies the value (a typed `value`, the
   * claim at `claim`, else the latest claim) as canon by that human; `decline` closes it unchanged, and
   * the same value isn't proposed again. Merges can only be declined: merging is done by hand.
   */
  async decideProposal(ref: string, choice: { decision: "accept" | "decline"; value?: string; claim?: number }, opts: { as?: string; via?: string } = {}): Promise<ProposalDecision> {
    return this.mutate<ProposalDecision>((vault) => {
      const by = humanOf(vault, { asHuman: opts.as || true })!;
      const slug = unwrapLink(ref);
      const d = vault.disputes.get(slug);
      if (!d || d.fm.status !== "open" || (d.fm.kind !== "proposal" && d.fm.kind !== "merge")) throw new VaultError(`no open proposal "${ref}"`);
      const entity = vault.resolve(d.fm.entity);
      const via = opts.via ? ` via ${opts.via}` : "";
      if (choice.decision === "decline") {
        declineProposal(vault, d);
        vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
        return { message: signed(`decline(${by}${via}): ${slug}`), result: { proposal: slug, decision: "declined", entity: entity?.slug ?? unwrapLink(d.fm.entity), field: d.fm.field } };
      }
      if (d.fm.kind === "merge") throw new VaultError(`${slug} is a possible duplicate: merge the notes by hand, or decline it`);
      if (!entity) throw new VaultError(`proposal ${slug} is about ${d.fm.entity}, which no longer exists`);
      let value: FactValue;
      if (choice.value?.trim()) {
        if (isSecretField(vault, entity, d.fm.field)) throw new VaultError(`${entity.slug}.${d.fm.field} is secret: accept one of the claims instead`);
        value = choice.value.trim();
      } else {
        const claim = choice.claim !== undefined ? d.fm.claims[choice.claim] : d.fm.claims.at(-1);
        if (!claim) throw new VaultError(choice.claim !== undefined ? `proposal ${slug} has no claim #${choice.claim}` : `proposal ${slug} has no value to accept; give one`);
        value = claim.value;
      }
      applyRuling(vault, d, value, by);
      vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
      const result: ProposalDecision = { proposal: slug, decision: "accepted", entity: entity.slug, field: d.fm.field, ...shown(value, { confidential: isConfidentialField(vault, entity, d.fm.field, entity.fm.facts[d.fm.field]) }) };
      // Neither a secret nor a confidential value goes into the commit message.
      return { message: signed(`accept(${by}${via}): ${entity.slug}.${d.fm.field} = ${result.secret ? "🔒" : result.confidential ? "◐" : result.value}`), result };
    });
  }

  /**
   * A human withdraws a fact (`field`, or `field@scope`): it becomes `retconned`, and the next report
   * about it starts over. Only the vault's humans retract; `as` picks which (default: the primary).
   */
  async retract(ref: string, field: string, opts: { scope?: string; as?: string; via?: string } = {}) {
    return this.mutate((vault) => {
      const by = humanOf(vault, { asHuman: opts.as || true })!;
      const entity = vault.resolve(ref);
      if (!entity) throw new VaultError(`no entity "${ref}"`);
      const key = retractFact(vault, entity, field, by, { scope: opts.scope });
      vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
      return { message: signed(`retract(${by}${opts.via ? ` via ${opts.via}` : ""}): ${entity.slug}.${key}`), result: { entity: entity.slug, field: key } };
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
   * Link sign-in logins to one of the vault's humans (a teammate joining a shared vault on the hosted
   * app), or unlink them with `null` (leaving). `create` adds the human when it isn't listed yet.
   */
  async linkHuman(id: string, logins: HumanLogins, opts: { via?: string; create?: { domains?: string[] } } = {}): Promise<{ changed: boolean }> {
    return this.mutate<{ changed: boolean }>(async (vault) => {
      const raw = await vault.store.read(CONFIG_PATH);
      if (raw === undefined) throw new VaultError(`no ${CONFIG_PATH}; is this a vault?`);
      const next = linkHuman(raw, id, logins, opts.create);
      if (next === raw) return { message: "", result: { changed: false } };
      vault.writeFile(CONFIG_PATH, next);
      const what = Object.entries(logins)
        .map(([host, login]) => (login ? `${host} @${login}` : `no ${host}`))
        .join(", ");
      return { message: signed(`config(${vault.config.human}${opts.via ? ` via ${opts.via}` : ""}): ${id}: ${what}`), result: { changed: true } };
    });
  }

  /**
   * The human adds domains to the vault's `domains:` (the lanes humans and agents can hold), and the
   * Handbook that lists them follows. Returns the ones that were new, and the commit message.
   */
  async addDomains(ids: string[], opts: { via?: string } = {}): Promise<{ added: string[]; message?: string }> {
    return this.mutate<{ added: string[]; message?: string }>(async (vault) => {
      const raw = await vault.store.read(CONFIG_PATH);
      if (raw === undefined) throw new VaultError(`no ${CONFIG_PATH}; is this a vault?`);
      const known = new Set(vault.config.domains.map((d) => d.toLowerCase()));
      const added = domainIds(ids).filter((d) => !known.has(d));
      const next = addDomains(raw, added);
      if (next === raw) return { message: "", result: { added: [] } };
      // The Handbook reads the config the vault was loaded with, so render it from one that has the new list.
      const after = await Vault.load(bufferedStore(vault.store, [{ path: CONFIG_PATH, content: next }]).store, this.opts);
      vault.writeFile(CONFIG_PATH, next);
      vault.writeFile(HANDBOOK_PATH, renderHandbook(after));
      const message = signed(`config(${vault.config.human}${opts.via ? ` via ${opts.via}` : ""}): add domain${added.length > 1 ? "s" : ""} ${added.join(", ")}`);
      return { message, result: { added, message } };
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
      const member = vault.actorMember(id);
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
