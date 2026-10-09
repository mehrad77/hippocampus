import { basename, displayName, getObjectives, getSummary, type Entity } from "./entity.ts";
import type { Episode } from "./episode.ts";
import { humanText, parseDoc } from "./markdown.ts";
import { CURRENT_VAULT_VERSION, vaultVersionStatus } from "./migrations.ts";
import { isSecretField } from "./ops.ts";
import { FactStatus, type Clock, type EpisodeKind, type Fact, type FactValue } from "./schema.ts";
import { isSecretRef } from "./secrets.ts";
import { fromLocal, localParts } from "./text.ts";
import type { Authority, Dispute, Vault } from "./vault.ts";
import { parseLinks, unwrapLink } from "./wikilink.ts";

// Read models for humans (the dashboard). Agent-facing views stay in service.ts, sized for context windows;
// these are complete, structured, and mask every secret in one place.

export const REVIEW_PATH = "_hippo/review.md";

export interface Ref {
  slug: string;
  title: string;
  type: string;
}

/** A value as shown to a human: secrets become `null` with `secret: true`. */
export interface Shown {
  value: string | null;
  secret: boolean;
}

export interface FactDetail extends Shown {
  field: string;
  status: FactStatus;
  by: string;
  byHuman: boolean;
  authority: Authority;
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

export interface ClockView {
  name: string;
  segments: number;
  filled: number;
  deadline?: string;
  daysLeft?: number;
}

export interface QuestCard extends EntityCard {
  owner?: Ref;
  deadline?: string;
  daysLeft?: number;
  objectives: { text: string; done: boolean }[];
  clocks: ClockView[];
  campaign?: Ref;
}

export interface ClaimView extends Shown {
  by: string;
  byHuman: boolean;
  authority: Authority;
  at?: string;
  src: string[];
}

export interface DisputeView {
  slug: string;
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
  /** `null` for secret-bearing episodes: their plain text waits in the inbox until sleep encrypts it. */
  text: string | null;
  secret: boolean;
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
  quests: QuestCard[];
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
  quest?: QuestCard;
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

export function shown(v: FactValue | undefined | null): Shown {
  if (isSecretRef(v)) return { value: null, secret: true };
  return { value: v === undefined || v === null ? null : String(v), secret: false };
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / DAY);
}

function addDays(day: string, n: number): string {
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

function refFor(vault: Vault, target: string, fallbackType = "unknown"): Ref {
  const e = vault.resolve(target);
  return e ? refOf(e) : { slug: unwrapLink(target), title: unwrapLink(target), type: fallbackType };
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

function clockView(ctx: ViewContext, c: Clock): ClockView {
  return { name: c.name, segments: c.segments, filled: Math.min(c.filled, c.segments), deadline: c.deadline, daysLeft: c.deadline && ISO_DAY.test(c.deadline) ? daysBetween(ctx.today, c.deadline) : undefined };
}

export function questCard(ctx: ViewContext, q: Entity): QuestCard {
  const campaign = (ctx.rel.out.get(q.slug) ?? []).map((r) => ctx.vault.entities.get(r.slug)!).find((e) => e?.fm.type === "campaign");
  return {
    ...entityCard(ctx, q),
    status: q.fm.status ?? "active",
    owner: q.fm.owner ? refFor(ctx.vault, q.fm.owner, "party") : undefined,
    deadline: q.fm.deadline,
    daysLeft: q.fm.deadline && ISO_DAY.test(q.fm.deadline) ? daysBetween(ctx.today, q.fm.deadline) : undefined,
    objectives: getObjectives(q),
    clocks: (q.fm.clocks ?? []).map((c) => clockView(ctx, c)),
    campaign: campaign ? refOf(campaign) : undefined,
  };
}

export function factDetail(ctx: ViewContext, e: Entity, field: string, f: Fact): FactDetail {
  const dispute = ctx.vault.disputes.get(ctx.vault.disputeSlug(e.slug, field));
  return {
    field,
    ...shown(f.value),
    status: f.status,
    by: f.by ?? ctx.vault.config.human,
    byHuman: ctx.vault.isHuman(f.by),
    authority: ctx.vault.authorityOf(f.by, e),
    at: f.at,
    stale: f.status === "canon" && !!f.at && f.at < ctx.staleBefore,
    src: f.src,
    seenBy: f.seen_by ?? [],
    dispute: dispute?.fm.status === "open" ? dispute.slug : undefined,
    was: (f.was ?? []).map((w) => ({ ...shown(w.value), by: w.by, at: w.at })),
  };
}

export function disputeView(ctx: ViewContext, d: Dispute): DisputeView {
  const e = ctx.vault.resolve(d.fm.entity);
  const current = e?.fm.facts[d.fm.field];
  return {
    slug: d.slug,
    entity: refFor(ctx.vault, d.fm.entity),
    field: d.fm.field,
    status: d.fm.status,
    opened: d.fm.opened,
    resolved: d.fm.resolved,
    claims: d.fm.claims.map((c) => ({
      ...shown(c.value),
      by: c.by ?? ctx.vault.config.human,
      byHuman: ctx.vault.isHuman(c.by),
      authority: e ? ctx.vault.authorityOf(c.by, e) : "none",
      at: c.at,
      src: c.src,
    })),
    current: e && current ? factDetail(ctx, e, d.fm.field, current) : undefined,
    ruling: d.fm.ruling === undefined || d.fm.ruling === "" ? undefined : shown(d.fm.ruling),
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
    text: ep.secret ? null : ep.text,
    secret: !!ep.secret,
    about: ep.secret ? [] : ep.about,
    confidence: ep.confidence,
    waitedThroughSleep: !!lastSleep && ep.at < lastSleep,
  };
}

// ── Chronicle ───────────────────────────────────────────────────────────────────

const ENTRY_RE = /> \[!episode\] (\d\d:\d\d) · \[\[([^\]|]+)[^\]]*\]\] · (\w+)\n((?:>.*\n?)*)\n*\^(ep-[\w-]+)/g;

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
      const finding = { ref: refOf(e), field, ...shown(f.value), by: f.by ?? ctx.vault.config.human, at: f.at };
      if (f.status === "rumor") rumors.push(finding);
      if (f.status === "canon" && f.at && f.at < ctx.staleBefore) stale.push(finding);
    }
  }
  const orphans = [...ctx.vault.entities.values()]
    .filter((e) => e.fm.type !== "party" && !e.fm.relations.length && !ctx.rel.in.get(e.slug)?.length)
    .map(refOf);
  return { disputes: ctx.vault.openDisputes().map((d) => disputeView(ctx, d)), rumors, stale, orphans };
}

/** Deadlines, clock deadlines and date-like facts between `today` and `horizon` (inclusive), soonest first. */
export function upcomingDates(vault: Vault, today: string, horizon: string): { what: string; date: string; slug: string }[] {
  const out: { what: string; date: string; slug: string }[] = [];
  for (const e of vault.entities.values()) {
    if (e.fm.deadline && e.fm.deadline >= today && e.fm.deadline <= horizon) out.push({ what: "deadline", date: e.fm.deadline, slug: e.slug });
    for (const c of e.fm.clocks ?? []) if (c.deadline && c.deadline >= today && c.deadline <= horizon) out.push({ what: `clock ${c.name} ${c.filled}/${c.segments}`, date: c.deadline, slug: e.slug });
    for (const [field, f] of Object.entries(e.fm.facts)) {
      const v = String(f.value);
      if (DATEISH.test(field) && ISO_DAY.test(v) && v.slice(0, 10) >= today && v.slice(0, 10) <= horizon) out.push({ what: `${field} (${f.status})`, date: v, slug: e.slug });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Party ────────────────────────────────────────────────────────────────────────

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
  const quests = vault.ofType("quest");
  return vault.ofType("party").map((p) => ({
    ...refOf(p),
    lane: p.fm.lane,
    authority: p.fm.authority ?? [],
    host: p.fm.host,
    lastSeen: lastSeen.get(p.slug),
    pending: vault.episodes.filter((ep) => ep.agent === p.slug).length,
    chronicled30d: chronicle30d.filter((c) => c.agent === p.slug).length,
    owns: quests.filter((q) => q.fm.owner && vault.resolve(q.fm.owner)?.slug === p.slug).map(refOf),
  }));
}

function unknownAgents(vault: Vault, chronicle: ChronicleEntryView[]): string[] {
  const agents = new Set([...vault.episodes.map((e) => e.agent), ...chronicle.map((c) => c.agent)]);
  return [...agents].filter((a) => !vault.isHuman(a) && !vault.party(a) && !vault.introductionOf(a)).sort();
}

/** One per agent outside the party: a member's leftover introduction has nothing left to approve. */
export function introductions(vault: Vault): IntroductionView[] {
  const latest = new Map(vault.introductions.map((i) => [i.agent, i]));
  return [...latest.values()]
    .filter((i) => !vault.partyMember(i.agent))
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
    if (e.fm.type === "quest") questCounts[e.fm.status ?? "active"] = (questCounts[e.fm.status ?? "active"] ?? 0) + 1;
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
    quests: vault.ofType("quest").map((q) => questCard(ctx, q)),
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
    types: Object.entries(vault.config.types).map(([name, def]) => ({ name, folder: def.folder, description: def.description, count: entities.filter((e) => e.type === name).length })),
    domains: vault.config.domains,
    relations: vault.config.relations,
    entities,
  };
}

export async function entityDetail(vault: Vault, e: Entity): Promise<EntityDetail> {
  const ctx = viewContext(vault);
  const lastSleep = await lastSleepAt(vault);
  const chronicle = await readChronicle(vault, addDays(ctx.today, -89), ctx.today);
  const isParty = e.fm.type === "party";
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
    quest: e.fm.type === "quest" ? questCard(ctx, e) : undefined,
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
  for (const q of vault.ofType("quest")) {
    const owner = q.fm.owner ? vault.resolve(q.fm.owner) : undefined;
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
