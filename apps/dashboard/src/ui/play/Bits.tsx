import type { IconName } from "../../lib/icons.ts";
import { useTerms } from "../../lib/prefs.ts";
import { Icon } from "../Icon.tsx";
import { questStatusWord, type Authority, type QuestStatus } from "./model.ts";

const QUEST_GLYPH: Record<QuestStatus, string> = { active: "→", blocked: "!", dormant: "z", done: "✓", failed: "✕" };
const QUEST_HELP: Record<QuestStatus, [plain: string, codex: string]> = {
  active: ["Active: in progress", "Active: in motion"],
  blocked: ["Blocked: waiting on something before it can move forward", "Blocked: waiting on something before it can move"],
  dormant: ["On hold: paused for now", "Dormant: set aside for now"],
  done: ["Done: completed", "Done: the tale is told"],
  failed: ["Failed: it didn't work out", "Failed: it didn't work out"],
};

/** A quest's status as a seal: glyph + word, like fact seals, never color alone. */
export function QuestSeal({ status }: { status?: string }) {
  const { look, v } = useTerms();
  const s = (status && status in QUEST_GLYPH ? status : "active") as QuestStatus;
  return (
    <span className={`seal qseal qseal--${s}`} title={v(...QUEST_HELP[s])}>
      <span className="seal__glyph" aria-hidden>
        {QUEST_GLYPH[s]}
      </span>
      {questStatusWord(s, look)}
    </span>
  );
}

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

export function AuthorityBadge({ authority }: { authority: Authority }) {
  const { v } = useTerms();
  const a = AUTH[authority];
  return (
    <span className={`auth auth--${authority}`} title={v(...a.help)}>
      <Icon name={a.icon} size={14} />
      {v(...a.label)}
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
