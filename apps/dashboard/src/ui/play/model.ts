import { normalizeName } from "@hippocampus/core/text";
import type { Look } from "../../lib/terms.ts";
import type { ClaimView, EpisodeView, Overview, QuestCard } from "../../lib/types.ts";

// Pure helpers for the "At the table" pages (quests, council, satchel, party): no DOM, unit-tested.
// Messages a reader sees take the look, so they read in plain words or in the codex's.

export const QUEST_STATUSES = ["active", "blocked", "dormant", "done", "failed"] as const;
export type QuestStatus = (typeof QUEST_STATUSES)[number];
export type Authority = ClaimView["authority"];
export type EpisodeKind = EpisodeView["kind"];

/** Same rule as core's `AGENT_ID`, so ids typed here work everywhere (Worker OAuth, MCP tokens). */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const DAY = 86400_000;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / DAY);
}

export function isQuestStatus(s: string | undefined): s is QuestStatus {
  return !!s && (QUEST_STATUSES as readonly string[]).includes(s);
}

const QUEST_WORD: Record<QuestStatus, string> = { active: "Active", blocked: "Blocked", dormant: "On hold", done: "Done", failed: "Failed" };

/** A quest status in the reader's words: "On hold" in plain, "dormant" (as written in the note) in the codex. */
export function questStatusWord(status: QuestStatus, look: Look = "plain"): string {
  return look === "codex" ? status : QUEST_WORD[status];
}

/** One of core's quest change notes (`clock Paperwork 3/6`, `status → dormant`) in the reader's words. */
export function changeLabel(change: string, look: Look = "plain"): string {
  if (look === "codex") return change;
  const clock = /^clock (.+ \d+\/\d+)$/.exec(change);
  if (clock) return clock[1]!;
  const status = /^status → (\S+)$/.exec(change);
  if (status && isQuestStatus(status[1])) return `status → ${questStatusWord(status[1])}`;
  return change;
}

/** What the quest action accepts (`POST /actions/quest`), minus the quest ref. */
export interface QuestEdit {
  status?: QuestStatus;
  complete?: string[];
  reopen?: string[];
  add?: string[];
  clock?: { name: string; segments?: number; filled?: number; deadline?: string };
  deadline?: string;
}

const same = (a: string, b: string) => normalizeName(a) === normalizeName(b);

/** The server's edit, mirrored for an optimistic update. Matching is exact (after normalizing): the UI sends objective text verbatim. */
export function editQuest(q: QuestCard, edit: QuestEdit, today: string): QuestCard {
  let objectives = q.objectives.map((o) => ({ ...o }));
  for (const text of edit.complete ?? []) {
    const hit = objectives.find((o) => same(o.text, text));
    if (hit) hit.done = true;
    else objectives = [...objectives, { text, done: true }];
  }
  for (const text of edit.reopen ?? []) {
    const hit = objectives.find((o) => same(o.text, text));
    if (hit) hit.done = false;
  }
  for (const text of edit.add ?? []) if (!objectives.some((o) => same(o.text, text))) objectives = [...objectives, { text, done: false }];

  let clocks = q.clocks;
  if (edit.clock) {
    const c = edit.clock;
    const found = clocks.some((x) => same(x.name, c.name));
    clocks = (found ? clocks : [...clocks, { name: c.name, segments: c.segments ?? 6, filled: 0 }]).map((x) => {
      if (!same(x.name, c.name)) return x;
      const segments = c.segments ?? x.segments;
      const deadline = c.deadline ?? x.deadline;
      return { ...x, segments, filled: Math.max(0, Math.min(segments, c.filled ?? x.filled)), deadline, daysLeft: deadline ? daysBetween(today, deadline) : x.daysLeft };
    });
  }
  const deadline = edit.deadline ?? q.deadline;
  return {
    ...q,
    status: edit.status ?? q.status,
    objectives,
    clocks,
    deadline,
    daysLeft: edit.deadline ? daysBetween(today, edit.deadline) : q.daysLeft,
  };
}

export function recountQuests(quests: QuestCard[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of quests) out[q.status ?? "active"] = (out[q.status ?? "active"] ?? 0) + 1;
  return out;
}

/** Replace one quest card (by slug) and keep the status counts honest. */
export function withQuest(o: Overview, slug: string, fn: (q: QuestCard) => QuestCard): Overview {
  const quests = o.quests.map((q) => (q.slug === slug ? fn(q) : q));
  return { ...o, quests, counts: { ...o.counts, quests: recountQuests(quests) } };
}

/** Board order: soonest deadline first (overdue on top, undated last), then active before blocked, then by title. */
export function byUrgency(a: QuestCard, b: QuestCard): number {
  const da = a.daysLeft ?? Number.POSITIVE_INFINITY;
  const db = b.daysLeft ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  if (a.status !== b.status) return a.status === "blocked" ? 1 : b.status === "blocked" ? -1 : 0;
  return a.title.localeCompare(b.title);
}

export function groupQuests(quests: QuestCard[]): { board: QuestCard[]; dormant: QuestCard[]; finished: QuestCard[] } {
  const status = (q: QuestCard) => q.status ?? "active";
  return {
    board: quests.filter((q) => status(q) === "active" || status(q) === "blocked").sort(byUrgency),
    dormant: quests.filter((q) => status(q) === "dormant").sort((a, b) => a.title.localeCompare(b.title)),
    // Newest first: the tale you just finished is the one you want to see.
    finished: quests.filter((q) => status(q) === "done" || status(q) === "failed").sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.title.localeCompare(b.title)),
  };
}

/** The soonest deadline still ahead, counting quest deadlines and clock deadlines. */
export function nextDue(quests: QuestCard[], look: Look = "plain"): { what: string; slug: string; daysLeft: number } | undefined {
  let best: { what: string; slug: string; daysLeft: number } | undefined;
  const consider = (what: string, slug: string, days: number | undefined) => {
    if (days !== undefined && days >= 0 && (!best || days < best.daysLeft)) best = { what, slug, daysLeft: days };
  };
  for (const q of quests) {
    consider(q.title, q.slug, q.daysLeft);
    for (const c of q.clocks) consider(look === "codex" ? `${q.title}: ${c.name} clock` : `${q.title}: ${c.name}`, q.slug, c.daysLeft);
  }
  return best;
}

/** Why a new clock (a progress tracker, in plain words) can't be added yet, or undefined when it can. */
export function clockProblem(q: QuestCard, name: string, segments: number, look: Look = "plain"): string | undefined {
  const codex = look === "codex";
  if (!name.trim()) return codex ? "Name the clock first." : "Name the progress tracker first.";
  if (name.trim().length > 100) return "Keep the name under 100 characters.";
  if (!Number.isInteger(segments) || segments < 2 || segments > 12) return codex ? "A clock has 2 to 12 segments." : "A progress tracker has 2 to 12 parts.";
  if (q.clocks.some((c) => same(c.name, name))) return codex ? "This quest already has a clock with that name." : "This goal already has a progress tracker with that name.";
  return undefined;
}

/** Why a new objective (a step, in plain words) can't be added yet. */
export function objectiveProblem(q: QuestCard, text: string, look: Look = "plain"): string | undefined {
  const codex = look === "codex";
  if (!text.trim()) return codex ? "Write the objective first." : "Write the step first.";
  if (text.trim().length > 300) return "Keep it under 300 characters.";
  if (q.objectives.some((o) => same(o.text, text))) return codex ? "That objective is already on the list." : "That step is already on the list.";
  return undefined;
}

/** Why an agent id is refused, mirroring core's `addPartyMember` checks that the browser can know about. */
export function agentIdProblem(id: string, taken: string[], human?: string, look: Look = "plain"): string | undefined {
  const codex = look === "codex";
  const v = id.trim().toLowerCase();
  if (!v) return codex ? "Give the agent an id." : "Enter an agent ID.";
  if (!AGENT_ID.test(v)) return "Use lowercase letters, digits and dashes, starting with a letter or digit (63 at most).";
  if (human && v === human.toLowerCase()) return codex ? `"${v}" is you, the human, not an agent.` : `"${v}" is your own name, not an agent.`;
  if (taken.some((t) => t.toLowerCase() === v)) return codex ? `"${v}" is already in the party.` : `"${v}" is already an agent.`;
  return undefined;
}

/** `[[slug|alias]]` or `[[slug#heading]]` → `slug`. */
export function unwrapRef(ref: string): string {
  const m = /^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(ref.trim());
  return (m ? (m[1] ?? "") : ref).trim().replace(/\.md$/, "");
}

export const KIND_LABEL: Record<EpisodeKind, readonly [plain: string, codex: string]> = {
  fact: ["Fact", "Fact"],
  observation: ["Observation", "Observation"],
  decision: ["Decision", "Decision"],
  task: ["Task", "Task"],
  question: ["Question", "Question"],
  beat: ["Milestone", "Story beat"],
};

/** An episode kind as a reader sees it; an unknown kind shows as written. */
export function kindLabel(kind: string, look: Look = "plain"): string {
  const pair = KIND_LABEL[kind as EpisodeKind];
  return pair ? pair[look === "codex" ? 1 : 0] : kind;
}

export function confidenceLabel(c: number | undefined): string | undefined {
  if (c === undefined || Number.isNaN(c)) return undefined;
  return `${Math.round(Math.max(0, Math.min(1, c)) * 100)}% sure`;
}

export function countBy<T>(items: T[], key: (item: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function filterEpisodes(eps: EpisodeView[], f: { agent?: string | null; kind?: string | null }): EpisodeView[] {
  return eps.filter((e) => (!f.agent || e.agent === f.agent) && (!f.kind || e.kind === f.kind)).sort((a, b) => b.at.localeCompare(a.at));
}

/** Claim numbers read like a court record: I, II, III … */
export function roman(n: number): string {
  const table: [number, string][] = [
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "";
  let left = n;
  for (const [v, s] of table)
    while (left >= v) {
      out += s;
      left -= v;
    }
  return out || String(n);
}

/** Up to two initials for a sheet's sigil: "Residency Agent" → "RA". */
export function initials(title: string): string {
  const words = title.split(/[\s_-]+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}
