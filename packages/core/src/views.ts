import { actorProps } from "./actor.ts";
import { basename, displayName, getSummary, type Entity } from "./entity.ts";
import { getObjectives, goalProps, goalState, legacyClocks, nextDue, type Clock, type GoalState, type Progress, type Repeat } from "./goal.ts";
import type { Episode } from "./episode.ts";
import { humanText, parseDoc } from "./markdown.ts";
import { CURRENT_VAULT_VERSION, vaultVersionStatus } from "./migrations.ts";
import { isSecretField } from "./ops.ts";
import { FactStatus, type DisputeKind, type EpisodeKind, type Fact, type FactValue, type ProposalState } from "./schema.ts";
import { isSecretRef } from "./secrets.ts";
import { fromLocal, localParts, parseFactKey } from "./text.ts";
import type { Authority, Dispute, Vault } from "./vault.ts";

/** Authority as the dashboard shows it: any human is "human", whether or not the domain is theirs. */
export type ShownAuthority = "human" | "authority" | "none";
const shownAuthority = (a: Authority): ShownAuthority => (a === "human_domain" ? "human" : a);
import { parseLinks, unwrapLink } from "./wikilink.ts";

// Read models for humans (the dashboard). Agent-facing views stay in service.ts, sized for context windows;
// these are complete, structured, and mask every secret in one place.

export const REVIEW_PATH = "_hippo/review.md";

export interface Ref {
  slug: string;
  title: string;
  type: string;
}

/** A value as shown to a human: secrets become `null` with `secret: true`, confidential values `null` with `confidential: true`. */
export interface Shown {
  value: string | null;
  secret: boolean;
  confidential?: boolean;
}

export interface FactDetail extends Shown {
  field: string;
  status: FactStatus;
  by: string;
  byHuman: boolean;
  authority: ShownAuthority;
  at?: string;
  stale: boolean;
  src: string[];
  seenBy: string[];
  /** Slug of the open dispute about this field. */
  dispute?: string;
  was: (Shown & { by?: string; at?: string })[];
}

export interface EntityCard extends Ref {
  aliases: string[];
  tags: string[];
  summary: string;
  updated?: string;
  updatedBy?: string;
  degree: number;
  facts: Record<FactStatus, number>;
  status?: string;
}

/** @deprecated A v1 clock, or a goal's progress drawn as one, until the dashboard shows progress. */
export interface ClockView {
  name: string;
  segments: number;
  filled: number;
  deadline?: string;
  daysLeft?: number;
}

/** A goal as the dashboard shows it. New fields are optional while older cards (and clients) lack them. */
export interface GoalCard extends EntityCard {
  /** The core state (`status` says the same, for older clients). */
  state?: GoalState;
  /** The status as written: a core state or a word of the type's vocabulary. */
  word?: string;
  owner?: Ref;
  counterparty?: Ref;
  /** ISO date (v1: `deadline`). */
  due?: string;
  /** When it's next due: `due`, or for a repeat after the last contact, that contact plus the interval. */
  nextDue?: string;
  /** Days from today to `nextDue`. */
  daysLeft?: number;
  progress?: Progress;
  repeat?: Repeat;
  lastDone?: string;
  objectives: { text: string; done: boolean }[];
  /** @deprecated Same as `due`. */
  deadline?: string;
  /** @deprecated The goal's progress as a clock, then any other v1 clocks. */
  clocks: ClockView[];
  /** The arc it belongs to. */
  campaign?: Ref;
}

/** @deprecated v1 name of `GoalCard`. */
export type QuestCard = GoalCard;

export interface ClaimView extends Shown {
  by: string;
  byHuman: boolean;
  authority: ShownAuthority;
  at?: string;
  src: string[];
}

export interface DisputeView {
  slug: string;
  /** conflict: sources disagree; proposal: a value only a human sets; merge: two notes may be one. */
  kind: DisputeKind;
  /** Proposals and merges: pending, applied, already_present or declined. */
  state?: ProposalState;
  /** Why a proposal or merge was raised. */
  evidence?: string;
  /** Merges: the two notes that may be one. */
  targets?: Ref[];
  entity: Ref;
  field: string;
  status: "open" | "resolved";
  opened?: string;
  resolved?: string;
  claims: ClaimView[];
  current?: FactDetail;
  /** `ruling:` written in Obsidian (or applied), shown masked. */
  ruling?: Shown;
  /** Custom rulings are refused for secret fields: they would land in the note as plain text. */
  secretField: boolean;
}

export interface EpisodeView {
  id: string;
  agent: string;
  kind: EpisodeKind;
  at: string;
  path: string;
  /** `null` for secret-bearing episodes (their plain text waits in the inbox until sleep encrypts it) and confidential ones. */
  text: string | null;
  secret: boolean;
  confidential?: boolean;
  about: string[];
  confidence?: number;
  /** Older than the last sleep: it failed or didn't fit the batch. */
  waitedThroughSleep: boolean;
}

export interface ChronicleEntryView {
  id: string;
  agent: string;
  kind: string;
  /** Local day and time, as written in the chronicle. */
  day: string;
  time: string;
  /** The same moment as an ISO instant. */
  at: string;
  text: string;
  /** Slugs of the entities this episode touched. */
  touched: string[];
}

export interface PartyMember extends Ref {
  lane?: string;
  authority: string[];
  host?: string;
  lastSeen?: string;
  pending: number;
  chronicled30d: number;
  owns: Ref[];
}

export interface FactFinding extends Shown {
  ref: Ref;
  field: string;
  by: string;
  at?: string;
}

export interface Attention {
  disputes: DisputeView[];
  rumors: FactFinding[];
  stale: FactFinding[];
  orphans: Ref[];
  /** Episodes that sat through a sleep without being consolidated. */
  waiting: EpisodeView[];
  /** Agents writing to the inbox or chronicle who have no `party/` note and haven't introduced themselves (their word counts as rumor). */
  unknownAgents: string[];
  /** Agents asking to join the party, oldest first. Their text is their own: show it as plain text. */
  introductions: IntroductionView[];
}

export interface IntroductionView {
  agent: string;
  title: string;
  lane?: string;
  host?: string;
  model?: string;
  at: string;
  about?: string;
}

export interface Upcoming {
  what: string;
  date: string;
  daysLeft: number;
  ref: Ref;
}

export interface ActivityDay {
  date: string;
  chronicled: number;
  remembered: number;
  byAgent: Record<string, number>;
}

export interface Overview {
  campaign: string;
  human: string;
  timezone: string;
  now: string;
  today: string;
  lastSleep?: string;
  version: { vault: number; tool: number; status: "current" | "older" | "newer" };
  counts: {
    entities: number;
    byType: Record<string, number>;
    facts: Record<FactStatus, number>;
    inbox: number;
    disputes: number;
    quests: Record<string, number>;
  };
  attention: Attention;
  quests: GoalCard[];
  upcoming: Upcoming[];
  party: PartyMember[];
  inbox: EpisodeView[];
  recent: EntityCard[];
  chronicle: ChronicleEntryView[];
  activity: ActivityDay[];
  warnings: string[];
}

export interface Catalog {
  campaign: string;
  human: string;
  types: { name: string; folder: string; description: string; count: number }[];
  domains: string[];
  relations: string[];
  entities: EntityCard[];
}

export interface EntityDetail {
  card: EntityCard;
  path: string;
  summary: string;
  /** Human prose outside managed regions (markdown). */
  notes: string;
  facts: FactDetail[];
  relations: { rel: string; dir: "out" | "in"; ref: Ref }[];
  disputes: DisputeView[];
  quest?: GoalCard;
  party?: PartyMember;
  mentions: ChronicleEntryView[];
  pending: EpisodeView[];
}

export interface Graph {
  nodes: (Ref & { tags: string[]; degree: number; status?: string })[];
  edges: { from: string; rel: string; to: string }[];
}

export interface ChroniclePage {
  month: string;
  months: string[];
  days: { date: string; entries: ChronicleEntryView[] }[];
}

export interface SearchResult {
  entities: EntityCard[];
  related: { ref: Ref; via: string }[];
  pending: EpisodeView[];
}

// ── Shared helpers ──────────────────────────────────────────────────────────────

const DAY = 86400_000;
const DATEISH = /(date|deadline|expir|appointment|due|until|start|end)/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

export function shown(v: FactValue | undefined | null, opts: { confidential?: boolean } = {}): Shown {
  if (isSecretRef(v)) return { value: null, secret: true };
  if (opts.confidential) return { value: null, secret: false, confidential: true };
  return { value: v === undefined || v === null ? null : String(v), secret: false };
}

/** Whether `field` of `e` is confidential: the fact says so, or its field is confidential or an identity key. */
export function isConfidentialField(vault: Vault, e: Entity, field: string, f?: Pick<Fact, "confidential">): boolean {
  if (f?.confidential) return true;
  const def = vault.schema.fieldDef(e.fm.type, field);
  return !!(def?.confidential || def?.identity_key);
}

/**
 * Whether `caller` may see confidential values of `e` (`field`, a `facts:` key): only a caller bound
 * to an identity (a bound key, an OAuth grant, local `--agent`) with authority there, or a human.
 */
export function seesConfidential(vault: Vault, caller: string | undefined, e: Entity, field?: string): boolean {
  return !!caller && vault.authorityOf(caller, e, field) !== "none";
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / DAY);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Every resolved edge, computed once: `vault.neighbors()` scans the whole vault per call. */
export interface RelationIndex {
  out: Map<string, { rel: string; slug: string }[]>;
  in: Map<string, { rel: string; slug: string }[]>;
}

export function relationIndex(vault: Vault): RelationIndex {
  const idx: RelationIndex = { out: new Map(), in: new Map() };
  for (const e of vault.entities.values()) {
    for (const r of e.fm.relations) {
      const t = vault.resolve(r.target);
      if (!t || t.slug === e.slug) continue;
      if (!idx.out.has(e.slug)) idx.out.set(e.slug, []);
      if (!idx.in.has(t.slug)) idx.in.set(t.slug, []);
      idx.out.get(e.slug)!.push({ rel: r.rel, slug: t.slug });
      idx.in.get(t.slug)!.push({ rel: r.rel, slug: e.slug });
    }
  }
  return idx;
}

/** Per-request state the view builders share. */
export interface ViewContext {
  vault: Vault;
  now: string;
  today: string;
  staleBefore: string;
  rel: RelationIndex;
}

export function viewContext(vault: Vault): ViewContext {
  const now = vault.nowIso();
  return {
    vault,
    now,
    today: localParts(now, vault.config.timezone).date,
    staleBefore: new Date(Date.parse(now) - vault.config.curator.stale_after_days * DAY).toISOString(),
    rel: relationIndex(vault),
  };
}

export function refOf(e: Entity): Ref {
  return { slug: e.slug, title: displayName(e), type: e.fm.type };
}

function refFor(vault: Vault, target: string, fallbackType?: string): Ref {
  const e = vault.resolve(target);
  return e ? refOf(e) : { slug: unwrapLink(target), title: unwrapLink(target), type: fallbackType ?? "unknown" };
}

function emptyStatusCounts(): Record<FactStatus, number> {
  return Object.fromEntries(FactStatus.options.map((s) => [s, 0])) as Record<FactStatus, number>;
}

export function entityCard(ctx: ViewContext, e: Entity): EntityCard {
  const facts = emptyStatusCounts();
  for (const f of Object.values(e.fm.facts)) facts[f.status]++;
  return {
    ...refOf(e),
    aliases: e.fm.aliases,
    tags: e.fm.tags,
    summary: getSummary(e),
    updated: e.fm.updated,
    updatedBy: e.fm.updated_by,
    degree: (ctx.rel.out.get(e.slug)?.length ?? 0) + (ctx.rel.in.get(e.slug)?.length ?? 0),
    facts,
    status: e.fm.status,
  };
}

const daysTo = (ctx: ViewContext, day: string | undefined) => (day && ISO_DAY.test(day) ? daysBetween(ctx.today, day) : undefined);

function clockView(ctx: ViewContext, c: Clock): ClockView {
  return { name: c.name, segments: c.segments, filled: Math.min(c.filled, c.segments), deadline: c.deadline, daysLeft: daysTo(ctx, c.deadline) };
}

export function goalCard(ctx: ViewContext, q: Entity): GoalCard {
  const { vault } = ctx;
  const p = goalProps(q);
  const campaign = (ctx.rel.out.get(q.slug) ?? []).map((r) => vault.entities.get(r.slug)!).find((e) => e && vault.schema.has(e.fm.type, "arc"));
  const state = goalState(p.status, vault.schema.type(q.fm.type)?.statuses);
  const next = nextDue(q, vault);
  // Until the dashboard draws progress, it shows as the goal's first clock (named after a v1 clock it came from).
  const [first, ...rest] = legacyClocks(q);
  const progressClock = p.progress ? [{ name: first?.name ?? "Progress", segments: p.progress.total, filled: Math.min(p.progress.done, p.progress.total) }] : [];
  return {
    ...entityCard(ctx, q),
    status: state,
    state,
    word: p.status ?? "active",
    owner: p.owner ? refFor(vault, p.owner, vault.schema.defaultTypeFor("actor")) : undefined,
    counterparty: p.counterparty ? refFor(vault, p.counterparty) : undefined,
    due: p.due,
    nextDue: next,
    daysLeft: daysTo(ctx, next),
    progress: p.progress,
    repeat: p.repeat,
    lastDone: p.last_done,
    objectives: getObjectives(q),
    deadline: p.due,
    clocks: [...progressClock, ...(p.progress && first ? rest : [first, ...rest].filter((c): c is Clock => !!c))].map((c) => clockView(ctx, c)),
    campaign: campaign ? refOf(campaign) : undefined,
  };
}

/** @deprecated Use `goalCard`. */
export const questCard = goalCard;

export function factDetail(ctx: ViewContext, e: Entity, field: string, f: Fact): FactDetail {
  const dispute = ctx.vault.disputes.get(ctx.vault.disputeSlug(e.slug, field));
  const confidential = isConfidentialField(ctx.vault, e, field, f);
  return {
    field,
    ...shown(f.value, { confidential }),
    status: f.status,
    by: f.by ?? ctx.vault.config.human,
    byHuman: ctx.vault.isHuman(f.by),
    authority: shownAuthority(ctx.vault.authorityOf(f.by, e, field)),
    at: f.at,
    stale: f.status === "canon" && !!f.at && f.at < ctx.staleBefore,
    src: f.src,
    seenBy: f.seen_by ?? [],
    dispute: dispute?.fm.status === "open" ? dispute.slug : undefined,
    was: (f.was ?? []).map((w) => ({ ...shown(w.value, { confidential }), by: w.by, at: w.at })),
  };
}

export function disputeView(ctx: ViewContext, d: Dispute): DisputeView {
  const e = ctx.vault.resolve(d.fm.entity);
  const current = e?.fm.facts[d.fm.field];
  const confidential = !!e && isConfidentialField(ctx.vault, e, d.fm.field, current);
  return {
    slug: d.slug,
    kind: d.fm.kind ?? "conflict",
    ...(d.fm.state ? { state: d.fm.state } : {}),
    ...(d.fm.evidence ? { evidence: d.fm.evidence } : {}),
    ...(d.fm.targets?.length ? { targets: d.fm.targets.map((t) => refFor(ctx.vault, t)) } : {}),
    entity: refFor(ctx.vault, d.fm.entity),
    field: d.fm.field,
    status: d.fm.status,
    opened: d.fm.opened,
    resolved: d.fm.resolved,
    claims: d.fm.claims.map((c) => ({
      ...shown(c.value, { confidential }),
      by: c.by ?? ctx.vault.config.human,
      byHuman: ctx.vault.isHuman(c.by),
      authority: e ? shownAuthority(ctx.vault.authorityOf(c.by, e, d.fm.field)) : "none",
      at: c.at,
      src: c.src,
    })),
    current: e && current ? factDetail(ctx, e, d.fm.field, current) : undefined,
    ruling: d.fm.ruling === undefined || d.fm.ruling === "" ? undefined : shown(d.fm.ruling, { confidential }),
    secretField: e ? isSecretField(ctx.vault, e, d.fm.field) : false,
  };
}

export function episodeView(ep: Episode, lastSleep?: string): EpisodeView {
  return {
    id: ep.id,
    agent: ep.agent,
    kind: ep.kind,
    at: ep.at,
    path: ep.path,
    text: ep.secret || ep.confidential ? null : ep.text,
    secret: !!ep.secret,
    ...(ep.confidential ? { confidential: true } : {}),
    about: ep.secret || ep.confidential ? [] : ep.about,
    confidence: ep.confidence,
    waitedThroughSleep: !!lastSleep && ep.at < lastSleep,
  };
}

// ── Chronicle ───────────────────────────────────────────────────────────────────

const ENTRY_RE = /> \[!episode\] (\d\d:\d\d) · \[\[([^\]|]+)[^\]]*\]\] · ([\w/-]+)\n((?:>.*\n?)*)\n*\^(ep-[\w-]+)/g;

/** One chronicle day file → its entries, with full text and the entities each episode touched. */
export function parseChronicleDay(day: string, content: string, timeZone = "UTC"): ChronicleEntryView[] {
  const out: ChronicleEntryView[] = [];
  for (const m of content.matchAll(ENTRY_RE)) {
    const lines = (m[4] ?? "").split("\n").map((l) => l.replace(/^> ?/, ""));
    const touched = lines.filter((l) => l.startsWith("↳")).flatMap((l) => parseLinks(l).map((x) => x.target));
    const text = lines
      .filter((l) => !l.startsWith("↳"))
      .join("\n")
      .trim();
    out.push({ id: m[5]!, agent: m[2]!, kind: m[3]!, day, time: m[1]!, at: fromLocal(day, m[1]!, timeZone), text, touched });
  }
  return out;
}

/** Chronicle day files (`…/YYYY/MM/YYYY-MM-DD.md`) as `[day, path]`, oldest first. */
export async function chronicleDays(vault: Vault): Promise<[string, string][]> {
  return (await vault.store.list(vault.config.folders.chronicle))
    .filter((p) => p.endsWith(".md"))
    .map((p): [string, string] => [basename(p), p])
    .filter(([day]) => ISO_DAY.test(day))
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** Entries from `from` to `to` (inclusive local days), oldest first. Only the files in range are read. */
export async function readChronicle(vault: Vault, from: string, to = "9999-12-31"): Promise<ChronicleEntryView[]> {
  const out: ChronicleEntryView[] = [];
  for (const [day, path] of await chronicleDays(vault)) {
    if (day < from || day > to) continue;
    out.push(...parseChronicleDay(day, (await vault.store.read(path)) ?? "", vault.config.timezone));
  }
  return out;
}

export async function lastSleepAt(vault: Vault): Promise<string | undefined> {
  const raw = await vault.store.read(REVIEW_PATH);
  if (!raw) return undefined;
  const generated = parseDoc(raw).data.generated;
  return typeof generated === "string" ? generated : generated instanceof Date ? generated.toISOString() : undefined;
}

// ── Findings shared with the morning review ─────────────────────────────────────

/** Rumors, stale canon, orphans and open disputes: what the human should look at. */
export function findings(ctx: ViewContext): Pick<Attention, "disputes" | "rumors" | "stale" | "orphans"> {
  const rumors: FactFinding[] = [];
  const stale: FactFinding[] = [];
  for (const e of ctx.vault.entities.values()) {
    for (const [field, f] of Object.entries(e.fm.facts)) {
      const finding = { ref: refOf(e), field, ...shown(f.value, { confidential: isConfidentialField(ctx.vault, e, field, f) }), by: f.by ?? ctx.vault.config.human, at: f.at };
      if (f.status === "rumor") rumors.push(finding);
      if (f.status === "canon" && f.at && f.at < ctx.staleBefore) stale.push(finding);
    }
  }
  const orphans = [...ctx.vault.entities.values()]
    .filter((e) => !ctx.vault.schema.has(e.fm.type, "actor") && !e.fm.relations.length && !ctx.rel.in.get(e.slug)?.length)
    .map(refOf);
  return { disputes: ctx.vault.openDisputes().map((d) => disputeView(ctx, d)), rumors, stale, orphans };
}

/** The next time a yearly date (a birthday) comes round, on or after `today`. Feb 29 falls on Feb 28 in other years. */
export function nextYearly(date: string, today: string): string {
  const [, m, d] = date.slice(0, 10).split("-");
  const on = (year: number) => {
    const last = new Date(Date.UTC(year, Number(m), 0)).getUTCDate();
    return `${year}-${m}-${String(Math.min(Number(d), last)).padStart(2, "0")}`;
  };
  const year = Number(today.slice(0, 4));
  const thisYear = on(year);
  return thisYear >= today.slice(0, 10) ? thisYear : on(year + 1);
}

/**
 * What's due between `today` and `horizon` (inclusive), soonest first: open goals (their next due
 * date), v1 clock deadlines, and date facts. A fact counts when its field is declared a `date` (a
 * `recurs: yearly` one at its next occurrence); an undeclared field only when its name looks like a date.
 */
export function upcomingDates(vault: Vault, today: string, horizon: string): { what: string; date: string; slug: string }[] {
  const out: { what: string; date: string; slug: string }[] = [];
  const within = (d: string) => ISO_DAY.test(d) && d.slice(0, 10) >= today && d.slice(0, 10) <= horizon;
  for (const e of vault.entities.values()) {
    if (vault.schema.has(e.fm.type, "goal")) {
      const state = goalState(e.fm.status, vault.schema.type(e.fm.type)?.statuses);
      const due = nextDue(e, vault);
      if (due && state !== "done" && state !== "failed" && within(due)) out.push({ what: "due", date: due.slice(0, 10), slug: e.slug });
      for (const c of legacyClocks(e)) if (c.deadline && within(c.deadline)) out.push({ what: `clock ${c.name} ${c.filled}/${c.segments}`, date: c.deadline, slug: e.slug });
    }
    for (const [field, f] of Object.entries(e.fm.facts)) {
      if (f.status === "retconned" || isConfidentialField(vault, e, field, f)) continue;
      const v = String(f.value);
      if (!ISO_DAY.test(v)) continue;
      const def = vault.schema.fieldDef(e.fm.type, field);
      if (def ? def.kind !== "date" : !DATEISH.test(parseFactKey(field).field)) continue;
      const date = def?.recurs === "yearly" ? nextYearly(v, today) : v.slice(0, 10);
      if (within(date)) out.push({ what: `${field} (${f.status})`, date, slug: e.slug });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Party ────────────────────────────────────────────────────────────────────────

const actorFields = ({ lane, authority, host }: ReturnType<typeof actorProps>) => ({ lane, authority, host });

function partyMembers(ctx: ViewContext, chronicle30d: ChronicleEntryView[]): PartyMember[] {
  const { vault } = ctx;
  const lastSeen = new Map<string, string>();
  const seen = (agent: string | undefined, at: string | undefined) => {
    if (!agent || !at) return;
    const key = agent.toLowerCase();
    if ((lastSeen.get(key) ?? "") < at) lastSeen.set(key, at);
  };
  for (const ep of vault.episodes) seen(ep.agent, ep.at);
  for (const c of chronicle30d) seen(c.agent, c.at);
  for (const e of vault.entities.values()) for (const f of Object.values(e.fm.facts)) seen(f.by, f.at);
  const quests = vault.withCapability("goal");
  const owned = (q: Entity) => {
    const owner = goalProps(q).owner;
    return owner ? vault.resolve(owner)?.slug : undefined;
  };
  return vault.withCapability("actor").map((p) => ({
    ...refOf(p),
    ...actorFields(actorProps(p)),
    lastSeen: lastSeen.get(p.slug),
    pending: vault.episodes.filter((ep) => ep.agent === p.slug).length,
    chronicled30d: chronicle30d.filter((c) => c.agent === p.slug).length,
    owns: quests.filter((q) => owned(q) === p.slug).map(refOf),
  }));
}

function unknownAgents(vault: Vault, chronicle: ChronicleEntryView[]): string[] {
  const agents = new Set([...vault.episodes.map((e) => e.agent), ...chronicle.map((c) => c.agent)]);
  return [...agents].filter((a) => !vault.isHuman(a) && !vault.actor(a) && !vault.introductionOf(a)).sort();
}

/** One per agent outside the party: a member's leftover introduction has nothing left to approve. */
export function introductions(vault: Vault): IntroductionView[] {
  const latest = new Map(vault.introductions.map((i) => [i.agent, i]));
  return [...latest.values()]
    .filter((i) => !vault.actorMember(i.agent))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(({ agent, title, lane, host, model, at, about }) => ({ agent, title, lane, host, model, at, about }));
}

// ── Views ────────────────────────────────────────────────────────────────────────

export async function overview(vault: Vault): Promise<Overview> {
  const ctx = viewContext(vault);
  const { config } = vault;
  const lastSleep = await lastSleepAt(vault);
  const from30 = addDays(ctx.today, -29);
  const chronicle30d = await readChronicle(vault, from30, ctx.today);
  const inbox = vault.episodes.map((ep) => episodeView(ep, lastSleep));

  const byType: Record<string, number> = {};
  const facts = emptyStatusCounts();
  const questCounts: Record<string, number> = {};
  for (const e of vault.entities.values()) {
    byType[e.fm.type] = (byType[e.fm.type] ?? 0) + 1;
    for (const f of Object.values(e.fm.facts)) facts[f.status]++;
    if (vault.schema.has(e.fm.type, "goal")) {
      const state = goalState(e.fm.status, vault.schema.type(e.fm.type)?.statuses);
      questCounts[state] = (questCounts[state] ?? 0) + 1;
    }
  }

  const activity: ActivityDay[] = [];
  for (let i = 0; i < 30; i++) {
    const date = addDays(from30, i);
    const entries = chronicle30d.filter((c) => c.day === date);
    const byAgent: Record<string, number> = {};
    for (const c of entries) byAgent[c.agent] = (byAgent[c.agent] ?? 0) + 1;
    const remembered = vault.episodes.filter((ep) => localParts(ep.at, config.timezone).date === date).length;
    activity.push({ date, chronicled: entries.length, remembered, byAgent });
  }

  const from7 = addDays(ctx.today, -6);
  const horizon = addDays(ctx.today, 90);
  const unknown = unknownAgents(vault, chronicle30d);
  return {
    campaign: config.campaign,
    human: config.human,
    timezone: config.timezone,
    now: ctx.now,
    today: ctx.today,
    lastSleep,
    version: { vault: config.version, tool: CURRENT_VAULT_VERSION, status: vaultVersionStatus(config) },
    counts: { entities: vault.entities.size, byType, facts, inbox: vault.episodes.length, disputes: vault.openDisputes().length, quests: questCounts },
    attention: { ...findings(ctx), waiting: inbox.filter((e) => e.waitedThroughSleep), unknownAgents: unknown, introductions: introductions(vault) },
    quests: vault.withCapability("goal").map((q) => goalCard(ctx, q)),
    upcoming: upcomingDates(vault, ctx.today, horizon).map((u) => ({ what: u.what, date: u.date, daysLeft: daysBetween(ctx.today, u.date), ref: refOf(vault.entities.get(u.slug)!) })),
    party: partyMembers(ctx, chronicle30d),
    inbox: [...inbox].reverse().slice(0, 200),
    recent: [...vault.entities.values()]
      .filter((e) => e.fm.updated)
      .sort((a, b) => b.fm.updated!.localeCompare(a.fm.updated!))
      .slice(0, 12)
      .map((e) => entityCard(ctx, e)),
    chronicle: chronicle30d.filter((c) => c.day >= from7),
    activity,
    warnings: [...vault.warnings],
  };
}

export function catalog(vault: Vault): Catalog {
  const ctx = viewContext(vault);
  const entities = [...vault.entities.values()].map((e) => entityCard(ctx, e)).sort((a, b) => a.title.localeCompare(b.title));
  return {
    campaign: vault.config.campaign,
    human: vault.config.human,
    types: vault.schema.types().map((t) => ({ name: t.name, folder: t.folder, description: t.description, count: entities.filter((e) => e.type === t.name).length })),
    domains: vault.config.domains,
    relations: vault.config.relations,
    entities,
  };
}

export async function entityDetail(vault: Vault, e: Entity): Promise<EntityDetail> {
  const ctx = viewContext(vault);
  const lastSleep = await lastSleepAt(vault);
  const chronicle = await readChronicle(vault, addDays(ctx.today, -89), ctx.today);
  const isParty = vault.schema.has(e.fm.type, "actor");
  const relations = [
    ...(ctx.rel.out.get(e.slug) ?? []).map((r) => ({ rel: r.rel, dir: "out" as const, ref: refOf(vault.entities.get(r.slug)!) })),
    ...(ctx.rel.in.get(e.slug) ?? []).map((r) => ({ rel: r.rel, dir: "in" as const, ref: refOf(vault.entities.get(r.slug)!) })),
  ];
  const aboutMe = (ep: Episode) => ep.about.some((a) => vault.resolve(a)?.slug === e.slug) || (isParty && ep.agent === e.slug);
  return {
    card: entityCard(ctx, e),
    path: e.path,
    summary: getSummary(e),
    notes: humanText(e.body).replace(/^## Notes\s*/, ""),
    facts: Object.entries(e.fm.facts).map(([field, f]) => factDetail(ctx, e, field, f)),
    relations,
    disputes: [...vault.disputes.values()].filter((d) => vault.resolve(d.fm.entity)?.slug === e.slug).map((d) => disputeView(ctx, d)),
    quest: vault.schema.has(e.fm.type, "goal") ? goalCard(ctx, e) : undefined,
    party: isParty ? partyMembers(ctx, chronicle.filter((c) => c.day >= addDays(ctx.today, -29))).find((p) => p.slug === e.slug) : undefined,
    mentions: chronicle.filter((c) => c.touched.includes(e.slug) || (isParty && c.agent === e.slug)).reverse().slice(0, 50),
    pending: vault.episodes.filter(aboutMe).map((ep) => episodeView(ep, lastSleep)),
  };
}

export function graph(vault: Vault): Graph {
  const ctx = viewContext(vault);
  const nodes = [...vault.entities.values()].map((e) => {
    const c = entityCard(ctx, e);
    return { slug: c.slug, title: c.title, type: c.type, tags: c.tags, degree: c.degree, status: c.status };
  });
  const edges = [...ctx.rel.out.entries()].flatMap(([from, rs]) => rs.map((r) => ({ from, rel: r.rel, to: r.slug })));
  // Quest ownership isn't a relation in the notes, but it's how the party connects to the story.
  for (const q of vault.withCapability("goal")) {
    const ref = goalProps(q).owner;
    const owner = ref ? vault.resolve(ref) : undefined;
    if (owner && owner.slug !== q.slug) edges.push({ from: owner.slug, rel: "leads", to: q.slug });
  }
  return { nodes, edges };
}

/** One month (`YYYY-MM`) of the chronicle, newest day first; `latest` (or no month) picks the newest month on record. */
export async function chroniclePage(vault: Vault, month?: string): Promise<ChroniclePage> {
  const days = await chronicleDays(vault);
  const months = [...new Set(days.map(([d]) => d.slice(0, 7)))].sort().reverse();
  const pick = month && /^\d{4}-\d{2}$/.test(month) ? month : (months[0] ?? localParts(vault.nowIso(), vault.config.timezone).date.slice(0, 7));
  const out: ChroniclePage["days"] = [];
  for (const [day, path] of days) {
    if (!day.startsWith(pick)) continue;
    out.push({ date: day, entries: parseChronicleDay(day, (await vault.store.read(path)) ?? "", vault.config.timezone) });
  }
  return { month: pick, months, days: out.reverse() };
}
