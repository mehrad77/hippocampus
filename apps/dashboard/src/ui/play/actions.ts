import { useEffect } from "react";
import { ApiError, postJson } from "../../lib/api.ts";
import { invalidate, patch } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import type { Overview, QuestCard } from "../../lib/types.ts";
import { editQuest, withQuest, type QuestEdit } from "./model.ts";

/** The server's message, with plain advice for the one error a human can act on. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "CONFLICT" || err.status === 409) return "The vault changed since this page loaded. It's reloaded now: check and try again.";
    if (err.status === 501) return `This dashboard can't do that here: ${err.message}`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** After an action: refetch what it may have changed. */
export function settle(): Promise<void[]> {
  return invalidate((k) => k.startsWith("/overview") || k.startsWith("/entity") || k.startsWith("/catalog") || k.startsWith("/graph"));
}

// Quest edits are optimistic and sent one at a time: clicking through a clock quickly must not race
// itself into a CONFLICT, and the board settles on the server's answer once the queue is empty.
let queue: Promise<unknown> = Promise.resolve();
let inFlight = 0;

type QuestRef = Pick<QuestCard, "slug" | "title">;

/** Apply `edit` to the cached board at once; returns the card as it was, for rollback. */
function optimistic(slug: string, edit: QuestEdit, today: string): QuestCard | undefined {
  let before: QuestCard | undefined;
  patch<Overview>("/overview", (o) => {
    before = o.quests.find((x) => x.slug === slug);
    return withQuest(o, slug, (x) => editQuest(x, edit, today));
  });
  return before;
}

export function updateQuest(q: QuestRef, edit: QuestEdit, today: string): Promise<boolean> {
  return send(q, edit, optimistic(q.slug, edit, today));
}

const bursts = new Map<string, { timer: number; before?: QuestCard }>();

/**
 * Like `updateQuest`, but changes to the same `key` within `ms` collapse into one request with the
 * last value: stepping a clock with the arrow keys shouldn't send (and toast) every step.
 */
export function updateQuestSoon(q: QuestRef, edit: QuestEdit, today: string, key: string, ms = 450): void {
  const id = `${q.slug}\u0000${key}`;
  const burst = bursts.get(id);
  const before = optimistic(q.slug, edit, today);
  if (burst) window.clearTimeout(burst.timer);
  // A pending burst counts as in flight, so an earlier reply doesn't settle the board under it.
  else inFlight++;
  const next = { before: burst ? burst.before : before, timer: 0 };
  next.timer = window.setTimeout(() => {
    bursts.delete(id);
    inFlight--;
    void send(q, edit, next.before);
  }, ms);
  bursts.set(id, next);
}

function send(q: QuestRef, edit: QuestEdit, before: QuestCard | undefined): Promise<boolean> {
  inFlight++;
  const run = queue.then(async () => {
    try {
      const res = await postJson<{ quest: string; changes: string[] }>("/actions/quest", { quest: q.slug, ...edit });
      toast(res.changes.length ? `${q.title}: ${res.changes.join(" · ")}` : `${q.title}: already like that, nothing changed.`, "ok");
      return true;
    } catch (err) {
      if (before) {
        const restore = before;
        patch<Overview>("/overview", (o) => withQuest(o, q.slug, () => restore));
      }
      toast(`${q.title}: ${errorMessage(err)}`, "error");
      return false;
    } finally {
      if (--inFlight === 0) void settle();
    }
  });
  queue = run;
  return run;
}

/**
 * Deep links (`/council/#dispute-slug`) point at content that renders after the data arrives, so the
 * browser can't scroll there itself. Once `ready`, scroll to the target and mark it for a moment.
 */
export function useHashTarget(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const go = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      // A target inside a folded section (say, a finished quest) needs the section open first.
      const fold = el.closest("details");
      if (fold && !fold.open) fold.open = true;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      el.classList.add("is-target");
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
      window.setTimeout(() => el.classList.remove("is-target"), 2400);
    };
    // Let the list paint first.
    const t = window.setTimeout(go, 60);
    window.addEventListener("hashchange", go);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("hashchange", go);
    };
  }, [ready]);
}
