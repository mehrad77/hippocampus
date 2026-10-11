import { NO_RECIPIENT } from "@hippocampus/core";
import type { SleepReport } from "./sleep.ts";

/** The review note for a goal status change the sender had no standing to make. */
export const GOAL_STATUS_NOTE = "status change not applied";

/** Most domain suggestions the review lists. */
const SUGGESTED_DOMAINS_MAX = 5;

/** The run's domain suggestions, the most wanted first, with how many episodes wanted each. */
export function suggestedDomains(report: SleepReport): { id: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of report.consolidated) for (const d of c.domains ?? []) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, SUGGESTED_DOMAINS_MAX);
}

/**
 * Something a sleep run left for the person to do. `say` is what happened, in plain words; `fix` is what they do
 * about it, naming the dashboard page. An agent relaying a run reads these out instead of improvising, and the
 * morning review lists the same ones. Never carries a value, only counts and slugs.
 */
export interface NextStep {
  code: "secrets-no-recipient" | "goal-no-owner" | "failed-episodes" | "disputes" | "suggested-domains";
  count: number;
  say: string;
  fix: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the person still has to do after this run, most blocking first. Empty when nothing is waiting on them. */
export function nextSteps(report: SleepReport): NextStep[] {
  const out: NextStep[] = [];

  const unstored = report.consolidated.flatMap((c) => c.facts).filter((f) => f.reason?.includes(NO_RECIPIENT)).length;
  if (unstored)
    out.push({
      code: "secrets-no-recipient",
      count: unstored,
      say: `Not saved: ${plural(unstored, "secret fact")} (ID numbers, credentials), because the vault has no secrets recipient yet. A secrets recipient is a public key; Hippocampus uses it to lock secret values so only the person's private key can read them.`,
      fix: "Open the dashboard, go to Setup, and make a secrets key there (or paste an existing public key that starts with age1). On a local vault, `hippo secrets keygen` does the same. Then the agents resend the facts, or the next sleep picks up new ones.",
    });

  const unowned = report.consolidated.flatMap((c) => c.notes ?? []).filter((n) => n.includes(GOAL_STATUS_NOTE)).length;
  if (unowned)
    out.push({
      code: "goal-no-owner",
      count: unowned,
      say: `Ignored: ${plural(unowned, "goal status change")}. Only a goal's owner, or an agent with authority over it, can mark it done, blocked or failed, and these goals have neither.`,
      fix: "On the dashboard's Goals page set an owner on each goal, or on the Agents page grant the agent authority over the goal's domain.",
    });

  if (report.failed.length)
    out.push({
      code: "failed-episodes",
      count: report.failed.length,
      say: `${plural(report.failed.length, "memory", "memories")} could not be consolidated and stay in the inbox. Most often a secret value would have ended up in a note's name or the daily log, which Hippocampus refuses.`,
      fix: "Ask the agent that sent them to resend without secret values in names or titles. The reason for each is on the Inbox page and in the morning review (`_hippo/review.md`). One that fails three nights in a row is tried last, so it never holds up newer memories.",
    });

  const disputes = report.consolidated.flatMap((c) => c.facts).filter((f) => f.decision === "dispute").length;
  if (disputes)
    out.push({
      code: "disputes",
      count: disputes,
      say: `Waiting for the person's ruling: ${plural(disputes, "fact")} that disagree with what the vault already holds.`,
      fix: "Open the Disputes page on the dashboard and pick the value that is right.",
    });

  const domains = suggestedDomains(report);
  if (domains.length)
    out.push({
      code: "suggested-domains",
      count: domains.length,
      say: `The curator wanted ${plural(domains.length, "domain")} the vault lacks: ${domains.map((d) => d.id).join(", ")}.`,
      fix: "Add them on the Agents page or with `hippo domain add`.",
    });

  return out;
}

/** The steps as the review's section: one bullet each, empty when there are none. */
export function renderNextSteps(steps: readonly NextStep[]): string[] {
  return steps.map((s) => `- **${s.say}** ${s.fix}`);
}
