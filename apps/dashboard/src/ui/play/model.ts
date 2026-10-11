import { normalizeName } from "@hippocampus/core/text";
import { addInterval } from "../../lib/progress.ts";
import type { Look } from "../../lib/terms.ts";
import type { ClaimView, EpisodeView, GoalCard, KindView, Overview } from "../../lib/types.ts";

// Pure helpers for the "At the table" pages (goals, council, inbox, agents): no DOM, unit-tested.
// Messages a reader sees take the look, so they read in plain words or in the codex's.

/** A goal's core states; a goal type may name them with its own words (`statuses:`). */
export const GOAL_STATES = ["active", "blocked", "dormant", "done", "failed"] as const;
export type GoalState = (typeof GOAL_STATES)[number];
/** @deprecated Same as `GOAL_STATES`. */
export const QUEST_STATUSES = GOAL_STATES;
/** @deprecated Same as `GoalState`. */
export type QuestStatus = GoalState;
export type Authority = ClaimView["authority"];
export type EpisodeKind = EpisodeView["kind"];

/** Same rule as core's `AGENT_ID`, so ids typed here work everywhere (Worker OAuth, MCP tokens). */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const DAY = 86400_000;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / DAY);
}

export function isGoalState(s: string | undefined): s is GoalState {
  return !!s && (GOAL_STATES as readonly string[]).includes(s);
}
/** @deprecated Same as `isGoalState`. */
export const isQuestStatus = isGoalState;

const STATE_WORD: Record<GoalState, string> = { active: "Active", blocked: "Blocked", dormant: "On hold", done: "Done", failed: "Failed" };

/** A core state in the reader's words: "On hold" in plain, "dormant" (as written in the note) in the codex. */
export function goalStateWord(state: GoalState, look: Look = "plain"): string {
  return look === "codex" ? state : STATE_WORD[state];
}
/** @deprecated Same as `goalStateWord`. */
export const questStatusWord = goalStateWord;

/** The core state a status word stands for, as core's `goalState` decides it: the vocabulary, else the word; unknown words are active. */
export function stateOf(word: string | undefined, statuses?: Record<string, string>): GoalState {
  const w = (word ?? "active").trim().toLowerCase();
  const mapped = statuses ? Object.entries(statuses).find(([k]) => k.toLowerCase() === w)?.[1]?.toLowerCase() : undefined;
  return isGoalState(mapped) ? mapped : isGoalState(w) ? w : "active";
}

/** The statuses a goal of a type can take: its own words (each with its core state), else the core states. */
export function statusOptions(statuses: Record<string, string> | undefined, look: Look = "plain"): { word: string; state: GoalState; label: string }[] {
  const words = statuses && Object.keys(statuses).length ? Object.keys(statuses) : [...GOAL_STATES];
  return words.map((word) => {
    const state = stateOf(word, statuses);
    return { word, state, label: isGoalState(word) ? goalStateWord(word, look) : word };
  });
}

/** One of core's goal change notes (`progress 3/6`, `status dormant`; older cores: `clock Paperwork 3/6`, `status → dormant`) in the reader's words. */
export function changeLabel(change: string, look: Look = "plain"): string {
  if (look === "codex") return change;
  const clock = /^clock (.+ \d+\/\d+)$/.exec(change);
  if (clock) return clock[1]!;
  const status = /^status (?:→ )?(\S+)$/.exec(change);
  if (status) return `status → ${isGoalState(status[1]) ? goalStateWord(status[1]) : status[1]}`;
  if (change === "due none") return "no due date";
  if (change === "repeat none") return "no longer repeats";
  return change;
}

/** What the goal action accepts (`POST /actions/goal`), minus the goal ref. */
export interface GoalEdit {
  /** A core state or a word of the goal type's own statuses. */
  status?: string;
  complete?: string[];
  reopen?: string[];
  add?: string[];
  progress?: { done?: number; total?: number; tick?: number };
  /** `null` clears it. */
  due?: string | null;
  owner?: string;
  counterparty?: string;
  /** `null` stops it repeating. */
  repeat?: { every?: string; after_last?: string } | null;
}

const same = (a: string, b: string) => normalizeName(a) === normalizeName(b);

/**
 * The server's goal update, mirrored for an optimistic update: objectives (matched exactly, after
 * normalizing; the UI sends their text verbatim), progress clamped to 0…total, status words through
 * the type's vocabulary, and a repeating goal marked done rolling over to its next due date.
 * Server-only details (who it's due after for `after_last`, links) settle when the answer arrives.
 */
export function editGoal(g: GoalCard, edit: GoalEdit, today: string, statuses?: Record<string, string>): GoalCard {
  let objectives = g.objectives.map((o) => ({ ...o }));
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

  let progress = g.progress;
  if (edit.progress) {
    const total = Math.round(edit.progress.total ?? g.progress?.total ?? 0);
    if (total >= 1) {
      let done = edit.progress.done ?? g.progress?.done ?? 0;
      done += edit.progress.tick ?? 0;
      progress = { done: Math.max(0, Math.min(total, Math.round(done))), total };
    }
  }

  let due = edit.due === undefined ? (g.due ?? g.deadline) : (edit.due ?? undefined);
  const repeat = edit.repeat === undefined ? g.repeat : (edit.repeat ?? undefined);
  let word = edit.status ?? g.word ?? g.status;
  let state = edit.status !== undefined ? stateOf(edit.status, statuses) : (g.state ?? stateOf(g.status, statuses));
  let lastDone = g.lastDone;
  const completed = edit.status !== undefined && state === "done" && stateOf(g.word ?? g.status, statuses) !== "done";
  if (completed && repeat?.every) {
    // Back it comes: next due date, steps unticked, progress at zero, active again.
    lastDone = today;
    const anchor = !repeat.after_last && due && /^\d{4}-\d{2}-\d{2}/.test(due) ? due.slice(0, 10) : today;
    due = addInterval(anchor, repeat.every) ?? due;
    objectives = objectives.map((o) => ({ ...o, done: false }));
    if (progress) progress = { done: 0, total: progress.total };
    word = (statuses && Object.keys(statuses).find((k) => stateOf(k, statuses) === "active")) ?? "active";
    state = "active";
  }
  const dueChanged = due !== (g.due ?? g.deadline);
  const nextDue = repeat?.after_last && !dueChanged ? g.nextDue : due;
  return {
    ...g,
    status: state,
    state,
    word,
    objectives,
    progress,
    due,
    deadline: due,
    repeat,
    lastDone,
    nextDue,
    daysLeft: nextDue ? daysBetween(today, nextDue) : undefined,
  };
}

export function recountGoals(goals: GoalCard[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of goals) {
    const s = g.state ?? g.status ?? "active";
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

/** The overview's goals (`quests` on older servers). */
export function goalsOf(o: Pick<Overview, "goals" | "quests">): GoalCard[] {
  return o.goals ?? o.quests;
}

/** Replace one goal card (by slug) and keep the state counts honest. */
export function withGoal(o: Overview, slug: string, fn: (g: GoalCard) => GoalCard): Overview {
  const goals = goalsOf(o).map((g) => (g.slug === slug ? fn(g) : g));
  const counts = recountGoals(goals);
  return { ...o, goals, quests: goals, counts: { ...o.counts, goals: counts, quests: counts } };
}

const stateOfCard = (g: GoalCard): GoalState => (isGoalState(g.state) ? g.state : isGoalState(g.status) ? g.status : "active");

/** Board order: soonest due first (overdue on top, undated last), then active before blocked, then by title. */
export function byUrgency(a: GoalCard, b: GoalCard): number {
  const da = a.daysLeft ?? Number.POSITIVE_INFINITY;
  const db = b.daysLeft ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  const sa = stateOfCard(a);
  const sb = stateOfCard(b);
  if (sa !== sb) return sa === "blocked" ? 1 : sb === "blocked" ? -1 : 0;
  return a.title.localeCompare(b.title);
}

/** Goals by core state (whatever word their type uses): in progress, on hold, finished. */
export function groupGoals(goals: GoalCard[]): { board: GoalCard[]; dormant: GoalCard[]; finished: GoalCard[] } {
  return {
    board: goals.filter((g) => stateOfCard(g) === "active" || stateOfCard(g) === "blocked").sort(byUrgency),
    dormant: goals.filter((g) => stateOfCard(g) === "dormant").sort((a, b) => a.title.localeCompare(b.title)),
    // Newest first: the goal you just finished is the one you want to see.
    finished: goals
      .filter((g) => stateOfCard(g) === "done" || stateOfCard(g) === "failed")
      .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.title.localeCompare(b.title)),
  };
}

/** The soonest due date still ahead: each goal's next due date (a repeating goal's next occurrence). */
export function nextDue(goals: GoalCard[]): { what: string; slug: string; daysLeft: number } | undefined {
  let best: { what: string; slug: string; daysLeft: number } | undefined;
  for (const g of goals) {
    const days = g.daysLeft;
    if (days !== undefined && days >= 0 && (!best || days < best.daysLeft)) best = { what: g.title, slug: g.slug, daysLeft: days };
  }
  return best;
}

/** Why progress can't be tracked with `total` steps, or undefined when it can. */
export function progressProblem(total: number, look: Look = "plain"): string | undefined {
  if (!Number.isInteger(total) || total < 1 || total > 1000) return look === "codex" ? "Progress runs from 1 to 1000 steps." : "Use a whole number of steps from 1 to 1000.";
  return undefined;
}

/** Why a new objective (a step, in plain words) can't be added yet. */
export function objectiveProblem(g: Pick<GoalCard, "objectives">, text: string, look: Look = "plain"): string | undefined {
  const codex = look === "codex";
  if (!text.trim()) return codex ? "Write the objective first." : "Write the step first.";
  if (text.trim().length > 300) return "Keep it under 300 characters.";
  if (g.objectives.some((o) => same(o.text, text))) return codex ? "That objective is already on the list." : "That step is already on the list.";
  return undefined;
}

/** Why an agent id is refused, mirroring core's `addPartyMember` checks that the browser can know about. */
export function agentIdProblem(id: string, taken: string[], humans?: string | readonly string[], look: Look = "plain"): string | undefined {
  const codex = look === "codex";
  const v = id.trim().toLowerCase();
  if (!v) return codex ? "Give the agent an id." : "Enter an agent ID.";
  if (!AGENT_ID.test(v)) return "Use lowercase letters, digits and dashes, starting with a letter or digit (63 at most).";
  const people = typeof humans === "string" ? [humans] : (humans ?? []);
  if (people.some((h) => h.toLowerCase() === v)) return codex ? `"${v}" is one of the players, not a party member.` : `"${v}" is one of this vault's people, not an agent.`;
  if (taken.some((t) => t.toLowerCase() === v)) return codex ? `"${v}" is already in the party.` : `"${v}" is already an agent.`;
  return undefined;
}

/** `[[slug|alias]]` or `[[slug#heading]]` → `slug`. */
export function unwrapRef(ref: string): string {
  const m = /^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(ref.trim());
  return (m ? (m[1] ?? "") : ref).trim().replace(/\.md$/, "");
}

/** Labels of the core kinds; a vault's own kinds read as their name (see `kindLabel`). */
const CORE_KIND_LABEL: Readonly<Record<string, readonly [plain: string, codex: string]>> = {
  fact: ["Fact", "Fact"],
  observation: ["Observation", "Observation"],
  decision: ["Decision", "Decision"],
  task: ["Task", "Task"],
  question: ["Question", "Question"],
  interaction: ["Contact", "Encounter"],
  beat: ["Milestone", "Story beat"],
};

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1).replace(/[_-]+/g, " ") : s);

/**
 * An episode kind as a reader sees it. The vault's kinds come from its registry (`kinds`): core ones
 * get their usual label, the vault's own read as their name. A kind the registry doesn't know is
 * filed as an observation, and says so.
 */
export function kindLabel(kind: string, kinds?: readonly Pick<KindView, "name">[], look: Look = "plain"): string {
  // The chronicle writes `kind/channel` for an interaction on a channel (`interaction/call`).
  const [base = kind, channel] = kind.split("/");
  const pair = Object.hasOwn(CORE_KIND_LABEL, base) ? CORE_KIND_LABEL[base] : undefined;
  let label = pair ? pair[look === "codex" ? 1 : 0] : capitalize(base);
  if (kinds?.length && !kinds.some((k) => k.name === base)) label = `${label} (as observation)`;
  return channel ? `${label} · ${channel}` : label;
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
