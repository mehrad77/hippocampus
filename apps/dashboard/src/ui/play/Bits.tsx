import type { IconName } from "../../lib/icons.ts";
import { useTerms } from "../../lib/prefs.ts";
import { Icon } from "../Icon.tsx";
import { goalStateWord, isGoalState, type Authority, type GoalState } from "./model.ts";

const GOAL_GLYPH: Record<GoalState, string> = { active: "→", blocked: "!", dormant: "z", done: "✓", failed: "✕" };
const GOAL_HELP: Record<GoalState, [plain: string, codex: string]> = {
  active: ["Active: in progress", "Active: in motion"],
  blocked: ["Blocked: waiting on something before it can move forward", "Blocked: waiting on something before it can move"],
  dormant: ["On hold: paused for now", "Dormant: set aside for now"],
  done: ["Done: completed", "Done: the tale is told"],
  failed: ["Failed: it didn't work out", "Failed: it didn't work out"],
};

/**
 * A goal's status as a seal: glyph + word, like fact seals, never color alone. The color and glyph
 * follow the core state; the word is the type's own when it has one (`won` for a deal that's done).
 */
export function GoalSeal({ status, word }: { status?: string; word?: string }) {
  const { look, v } = useTerms();
  const s: GoalState = isGoalState(status) ? status : "active";
  const own = word && word.toLowerCase() !== s ? word : undefined;
  return (
    <span className={`seal qseal qseal--${s}`} title={own ? `${own}: ${v(...GOAL_HELP[s])}` : v(...GOAL_HELP[s])}>
      <span className="seal__glyph" aria-hidden>
        {GOAL_GLYPH[s]}
      </span>
      {own ?? goalStateWord(s, look)}
    </span>
  );
}

/** @deprecated Same as `GoalSeal`. */
export const QuestSeal = GoalSeal;

const AUTH: Record<Authority, { label: [plain: string, codex: string]; icon: IconName; help: [plain: string, codex: string] }> = {
  human: {
    label: ["You", "Your word"],
    icon: "quill",
    help: ["Written by you. What you write outranks every agent.", "Written by you. Human authority outranks every agent."],
  },
  authority: {
    label: ["Responsible agent", "Lane authority"],
    icon: "key",
    help: ["This agent is responsible for this record, so it outranks agents that aren't.", "This agent's lane covers this entity, so it outranks agents without authority here."],
  },
  none: {
    label: ["Not responsible", "No authority"],
    icon: "eye",
    help: ["This agent isn't responsible for this record: its report counts only when another source confirms it.", "This agent has no lane authority here: its word counts only with corroboration."],
  },
};

/**
 * Whose word it is. With several humans, `by` and `me` (the human the dashboard acts as) tell "you"
 * from another person; both outrank every agent.
 */
export function AuthorityBadge({ authority, by, me }: { authority: Authority; by?: string; me?: string }) {
  const { v } = useTerms();
  const a = AUTH[authority];
  const other = authority === "human" && by && me && by.toLowerCase() !== me.toLowerCase() ? by : undefined;
  return (
    <span className={`auth auth--${authority}`} title={other ? v(`Written by ${other}. A person's word outranks every agent.`, `Written by ${other}. Human authority outranks every agent.`) : v(...a.help)}>
      <Icon name={a.icon} size={14} />
      {other ?? v(...a.label)}
    </span>
  );
}

/** A page's heading block: kicker, title, lede, and an optional action on the right. */
export function PageHead({ kicker, title, lede, action }: { kicker: React.ReactNode; title: string; lede?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <div className="page-head__kicker">{kicker}</div>
        <h1>{title}</h1>
        {lede && <p className="page-head__lede">{lede}</p>}
      </div>
      {action}
    </header>
  );
}

/** A section divider with a label: ❦ Dormant ❦ in the codex, a plain heading otherwise. */
export function Ornament({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 className="ornament play-ornament" id={id}>
      <span>{children}</span>
    </h2>
  );
}
