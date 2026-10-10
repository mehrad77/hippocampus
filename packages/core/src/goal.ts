import { z } from "zod";
import type { Entity } from "./entity.ts";
import { VaultError } from "./errors.ts";
import { getRegion, parseChecklist, renderChecklist, setRegion, type ChecklistItem } from "./markdown.ts";
import { localParts, normalizeName } from "./text.ts";
import type { Vault } from "./vault.ts";
import { link, unwrapLink } from "./wikilink.ts";

// Goal behaviour (the `goal` capability) lives in code: status, owner, progress, due dates and
// repeats. A type note only adds fields and a status vocabulary. Props are parsed on demand from the
// note's loose frontmatter, so a v1 quest (`deadline`, `clocks`) reads the same way.

const opt = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === null || v === "" ? undefined : v), schema.optional());

/** Where a goal stands. A type's `statuses` vocabulary maps its own words onto these. */
export const GoalState = z.enum(["active", "blocked", "done", "failed", "dormant"]);
export type GoalState = z.infer<typeof GoalState>;

/** @deprecated v1 name of `GoalState`. */
export const QuestStatus = GoalState;
/** @deprecated v1 name of `GoalState`. */
export type QuestStatus = GoalState;

export const Progress = z.object({
  done: z.coerce.number().int().nonnegative().default(0),
  total: z.coerce.number().int().positive(),
});
export type Progress = z.infer<typeof Progress>;

/**
 * How a goal comes back once done. `every` is the interval (`1w`, `1m`, `1y`). With `after_last`
 * (`interaction`, or `interaction(with=[[x]])`) the next due date counts from the latest episode of
 * that kind with the counterparty (its `stats.last`), not from the previous due date.
 */
export const Repeat = z.preprocess(
  // `repeat: 1m` is shorthand for `repeat: { every: 1m }`.
  (v) => (typeof v === "string" ? { every: v } : v),
  z.object({
    every: opt(z.coerce.string()),
    after_last: opt(z.coerce.string()),
  }),
);
export type Repeat = z.infer<typeof Repeat>;

export const GoalProps = z.looseObject({
  /** A core state, or a word of the type's `statuses` vocabulary. Missing = active. */
  status: opt(z.coerce.string()),
  owner: opt(z.coerce.string()),
  /** Who the goal is with or for (`[[landlord]]`): its repeats can count from contact with them. */
  counterparty: opt(z.coerce.string()),
  /** ISO date. */
  due: opt(z.coerce.string()),
  progress: opt(Progress).catch(undefined),
  repeat: opt(Repeat).catch(undefined),
  /** Local date a repeating goal was last completed. */
  last_done: opt(z.coerce.string()),
});
export type GoalProps = z.infer<typeof GoalProps>;

/** Frontmatter keys goal behaviour owns. */
export const GOAL_KEYS = ["status", "owner", "counterparty", "due", "progress", "repeat", "last_done"] as const;
/** v1 keys of the same things (`deadline` → `due`, the first clock → `progress`); the migration converts them. */
export const LEGACY_GOAL_KEYS = ["deadline", "clocks"] as const;

/** @deprecated A v1 progress clock. Goals have one `progress` instead; read only for compatibility. */
export const Clock = z.object({
  name: z.string(),
  segments: z.number().int().positive().default(6),
  filled: z.number().int().nonnegative().default(0),
  deadline: opt(z.coerce.string()),
});
/** @deprecated See `Clock`. */
export type Clock = z.infer<typeof Clock>;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;
const raw = (e: Pick<Entity, "fm">) => e.fm as Record<string, unknown>;

/** A v1 note's `clocks:`, the valid ones. */
export function legacyClocks(e: Pick<Entity, "fm">): Clock[] {
  const clocks = raw(e).clocks;
  if (!Array.isArray(clocks)) return [];
  return clocks.flatMap((c) => {
    const parsed = Clock.safeParse(c);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The goal props of a note, reading v1 `deadline` as `due` and the first v1 clock as `progress` when the new keys are absent. */
export function goalProps(e: Pick<Entity, "fm">): GoalProps {
  const parsed = GoalProps.safeParse(raw(e));
  const p: GoalProps = parsed.success ? { ...parsed.data } : {};
  if (p.due === undefined) {
    const deadline = raw(e).deadline;
    if (deadline !== undefined && deadline !== null && deadline !== "") p.due = String(deadline);
  }
  if (p.progress === undefined) {
    const first = legacyClocks(e)[0];
    if (first) p.progress = { done: first.filled, total: first.segments };
  }
  // A hand-edited `done` past `total` reads as complete, never overfull.
  if (p.progress) p.progress = { done: Math.min(p.progress.done, p.progress.total), total: p.progress.total };
  return p;
}

/** The core state a status word stands for: the vocabulary's mapping, else the word itself; unknown words count as active. */
export function goalState(word: string | undefined, statuses?: Record<string, string>): GoalState {
  const w = (word ?? "active").trim().toLowerCase();
  const vocab = statuses ? Object.entries(statuses).find(([k]) => k.toLowerCase() === w)?.[1] : undefined;
  return GoalState.safeParse(vocab?.toLowerCase()).data ?? GoalState.safeParse(w).data ?? "active";
}

/** The core state of a goal note in `vault`, through its type's vocabulary. */
export function goalStateOf(vault: Vault, e: Entity): GoalState {
  return goalState(goalProps(e).status, vault.schema.type(e.fm.type)?.statuses);
}

/** `day` (YYYY-MM-DD) plus `spec` (`3d`, `2w`, `1m`, `1y`); months and years are calendar ones. Undefined for a bad spec. */
export function addDuration(day: string, spec: string): string | undefined {
  const m = /^\s*(\d+)\s*(d|days?|w|weeks?|m|months?|y|years?)\s*$/i.exec(spec);
  if (!m || !ISO_DAY.test(day)) return undefined;
  const n = Number(m[1]);
  if (n <= 0) return undefined;
  const unit = m[2]!.toLowerCase()[0]!;
  const [y, mo, d] = day.slice(0, 10).split("-").map(Number) as [number, number, number];
  if (unit === "d" || unit === "w") return new Date(Date.UTC(y, mo - 1, d + n * (unit === "w" ? 7 : 1))).toISOString().slice(0, 10);
  const months = unit === "m" ? n : 12 * n;
  const first = new Date(Date.UTC(y, mo - 1 + months, 1));
  // 31 Jan + 1 month is the end of February, not 3 March.
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** `interaction(with=[[x]])` → the kind and the entity; a bare `interaction` counts with the counterparty. */
export function parseAfterLast(spec: string): { kind: string; with?: string } {
  const m = /^\s*([\p{L}\p{N}_/-]+)\s*(?:\(\s*with\s*=\s*["']?(.+?)["']?\s*\))?\s*$/iu.exec(spec);
  return m ? { kind: m[1]!.toLowerCase(), with: m[2]?.trim() || undefined } : { kind: spec.trim().toLowerCase() };
}

const later = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : a > b ? a : b);

/** The latest local date of an episode of `after_last`'s kind with its entity (or the goal's counterparty). */
function lastContact(vault: Vault, p: GoalProps): string | undefined {
  if (!p.repeat?.after_last) return undefined;
  const { kind, with: who } = parseAfterLast(p.repeat.after_last);
  const ref = who ?? p.counterparty;
  const target = ref ? vault.resolve(ref) : undefined;
  return target?.fm.stats?.last[kind];
}

/**
 * When a goal is next due: for a repeat that counts from the last contact, that contact (or the last
 * completion, whichever is later) plus the interval; otherwise its `due` (v1: `deadline`).
 */
export function nextDue(goal: Entity, vault: Vault): string | undefined {
  const p = goalProps(goal);
  if (p.repeat?.after_last && p.repeat.every) {
    const anchor = later(lastContact(vault, p), p.last_done);
    if (anchor) return addDuration(anchor, p.repeat.every) ?? p.due;
  }
  return p.due;
}

/** One line for the note's `progress` region: `▰▱▱▱ 1/4 · due 2026-11-30 · repeats every 1m`. Empty when there's nothing to show. */
export function renderProgress(p: GoalProps): string {
  const parts: string[] = [];
  if (p.progress) {
    const { total } = p.progress;
    const done = Math.min(p.progress.done, total);
    // Long counts are drawn as ten cells, so a 100-step goal doesn't draw 100.
    const cells = total <= 20 ? total : 10;
    const full = total <= 20 ? done : Math.round((done / total) * cells);
    parts.push(`${"▰".repeat(full)}${"▱".repeat(cells - full)} ${done}/${total}`);
  }
  if (p.due) parts.push(`due ${p.due}`);
  if (p.repeat?.every) {
    const after = p.repeat.after_last ? parseAfterLast(p.repeat.after_last) : undefined;
    parts.push(after ? `repeats ${p.repeat.every} after the last ${after.kind}${after.with ? ` with ${after.with}` : ""}` : `repeats every ${p.repeat.every}`);
    if (p.last_done) parts.push(`last done ${p.last_done}`);
  }
  return parts.join(" · ");
}

// Objectives live in the body as a checklist so they can be ticked in Obsidian directly.
export function getObjectives(e: Pick<Entity, "body">): ChecklistItem[] {
  const region = getRegion(e.body, "objectives");
  return region === undefined ? [] : parseChecklist(region);
}

export function setObjectives(e: Pick<Entity, "body">, items: ChecklistItem[]): void {
  e.body = setRegion(e.body, "objectives", renderChecklist(items));
}

export function matchObjective<T extends { text: string }>(items: T[], text: string): T | undefined {
  const key = normalizeName(text);
  return (
    items.find((i) => normalizeName(i.text) === key) ??
    items.find((i) => normalizeName(i.text).includes(key) || key.includes(normalizeName(i.text)))
  );
}

export interface GoalUpdate {
  /** A core state or a word of the type's `statuses`. `done` on a repeating goal rolls it to its next occurrence. */
  status?: string;
  complete?: string[];
  /** Objectives to mark not done again (fuzzy-matched; unknown ones are ignored). */
  reopen?: string[];
  add?: string[];
  /** Set `done`/`total`, or move by `tick`; `done` stays within 0…`total`. */
  progress?: { done?: number; total?: number; tick?: number };
  /** ISO date; `null` clears it. */
  due?: string | null;
  owner?: string;
  counterparty?: string;
  /** `null` stops it repeating. */
  repeat?: Repeat | null;
}

/**
 * Apply a goal update as `by`. Returns one change per line, each `key value` or an objective mark
 * (`status done`, `progress 2/3`, `due 2026-10-13`, `✓ text`, `○ text`, `+ text`); empty when
 * nothing changed. The goal's notes are touched only when something did.
 */
export function applyGoalUpdate(vault: Vault, goal: Entity, u: GoalUpdate, by: string): string[] {
  const fm = raw(goal);
  const before = goalProps(goal);
  const vocab = vault.schema.type(goal.fm.type)?.statuses;
  const changes: string[] = [];
  let completed = false;

  // Check everything first, so a bad field leaves the goal as it was.
  const w = u.status?.trim().toLowerCase();
  const word = w ? ((vocab && Object.keys(vocab).find((k) => k.toLowerCase() === w)) ?? (GoalState.safeParse(w).success ? w : undefined)) : undefined;
  if (w && !word) {
    const known = [...new Set([...Object.keys(vocab ?? {}), ...GoalState.options])];
    throw new VaultError(`unknown status "${u.status}" for ${goal.slug}; use one of ${known.join(", ")}`);
  }
  const due = u.due?.trim() || undefined;
  if (due && !ISO_DAY.test(due)) throw new VaultError(`due must be an ISO date (YYYY-MM-DD), not "${u.due}"`);
  const every = u.repeat?.every?.trim() || undefined;
  const afterLast = u.repeat?.after_last?.trim() || undefined;
  const repeat = every || afterLast ? { every, after_last: afterLast } : undefined;
  if (repeat && (!every || !addDuration("2000-01-01", every))) throw new VaultError(`repeat needs an interval like 1w, 2w, 1m or 1y${every ? `, not "${every}"` : ""}`);
  const total = u.progress ? Math.round(u.progress.total ?? before.progress?.total ?? 0) : 0;
  if (u.progress && total < 1) throw new VaultError(`progress of ${goal.slug} needs a total (how many steps make it done)`);

  if (word && before.status !== word) {
    fm.status = word;
    changes.push(`status ${word}`);
    completed = goalState(word, vocab) === "done";
  }
  if (u.due !== undefined && setDue(fm, due)) changes.push(`due ${due ?? "none"}`);
  for (const key of ["owner", "counterparty"] as const) {
    const ref = u[key]?.trim();
    if (!ref) continue;
    const value = link(vault.resolve(ref)?.slug ?? unwrapLink(ref));
    if (fm[key] !== value) {
      fm[key] = value;
      changes.push(`${key} ${value}`);
    }
  }
  if (u.repeat !== undefined && JSON.stringify(before.repeat ?? null) !== JSON.stringify(repeat ?? null)) {
    fm.repeat = repeat ? Object.fromEntries(Object.entries(repeat).filter(([, v]) => v !== undefined)) : undefined;
    changes.push(repeat ? `repeat every ${every}${afterLast ? ` after ${afterLast}` : ""}` : "repeat none");
  }

  const objectives = getObjectives(goal);
  let touchedObjectives = false;
  for (const text of u.complete ?? []) {
    const target = matchObjective(objectives, text);
    if (target && !target.done) {
      target.done = true;
      touchedObjectives = true;
      changes.push(`✓ ${target.text}`);
    } else if (!target) {
      objectives.push({ text, done: true });
      touchedObjectives = true;
      changes.push(`✓ ${text} (new)`);
    }
  }
  for (const text of u.reopen ?? []) {
    const target = matchObjective(objectives, text);
    if (target?.done) {
      target.done = false;
      touchedObjectives = true;
      changes.push(`○ ${target.text}`);
    }
  }
  for (const text of u.add ?? []) {
    if (!matchObjective(objectives, text)) {
      objectives.push({ text, done: false });
      touchedObjectives = true;
      changes.push(`+ ${text}`);
    }
  }

  if (u.progress) {
    let done = u.progress.done ?? before.progress?.done ?? 0;
    if (u.progress.tick) done += u.progress.tick;
    // Shrinking `total` or an explicit `done` must not leave it overfull.
    done = Math.max(0, Math.min(total, Math.round(done)));
    const explicit = Progress.safeParse(fm.progress).data;
    if (!explicit || explicit.done !== done || explicit.total !== total) {
      fm.progress = { done, total };
      changes.push(`progress ${done}/${total}`);
    }
  }

  // A repeating goal, once done, comes back: next due date, objectives unticked, progress at zero, active again.
  const rolls = u.repeat === undefined ? before.repeat : repeat;
  if (completed && rolls?.every) {
    const today = localParts(vault.nowIso(), vault.config.timezone).date;
    fm.last_done = today;
    changes.push(`last_done ${today}`);
    const props = goalProps(goal);
    const anchor = rolls.after_last ? later(lastContact(vault, props), today)! : props.due && ISO_DAY.test(props.due) ? props.due.slice(0, 10) : today;
    const next = addDuration(anchor, rolls.every);
    if (next && setDue(fm, next)) changes.push(`due ${next}`);
    for (const o of objectives) {
      if (!o.done) continue;
      o.done = false;
      touchedObjectives = true;
      changes.push(`○ ${o.text}`);
    }
    if (props.progress && props.progress.done > 0) {
      fm.progress = { done: 0, total: props.progress.total };
      changes.push(`progress 0/${props.progress.total}`);
    }
    const active = (vocab && Object.keys(vocab).find((k) => goalState(k, vocab) === "active")) ?? "active";
    fm.status = active;
    changes.push(`status ${active}`);
  }
  if (touchedObjectives) setObjectives(goal, objectives);

  if (changes.length) vault.touch(goal, by);
  return changes;
}

/** Set (or clear) `due`, dropping the v1 `deadline` it replaces. Returns whether the date changed. */
function setDue(fm: Record<string, unknown>, due: string | undefined): boolean {
  const cur = fm.due ?? fm.deadline;
  const had = cur === undefined || cur === null || cur === "" ? undefined : String(cur);
  if (due === undefined) delete fm.due;
  else fm.due = due;
  delete fm.deadline;
  return had !== due;
}
