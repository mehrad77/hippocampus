import type { IconName } from "../../lib/icons.ts";
import { Icon } from "../Icon.tsx";
import type { Authority, QuestStatus } from "./model.ts";

const QUEST_GLYPH: Record<QuestStatus, string> = { active: "→", blocked: "!", dormant: "z", done: "✓", failed: "✕" };
const QUEST_HELP: Record<QuestStatus, string> = {
  active: "Active: in motion",
  blocked: "Blocked: waiting on something before it can move",
  dormant: "Dormant: set aside for now",
  done: "Done: the tale is told",
  failed: "Failed: it didn't work out",
};

/** A quest's status as a seal: glyph + word, like fact seals, never color alone. */
export function QuestSeal({ status }: { status?: string }) {
  const s = (status && status in QUEST_GLYPH ? status : "active") as QuestStatus;
  return (
    <span className={`seal qseal qseal--${s}`} title={QUEST_HELP[s]}>
      <span className="seal__glyph" aria-hidden>
        {QUEST_GLYPH[s]}
      </span>
      {s}
    </span>
  );
}

const AUTH: Record<Authority, { label: string; icon: IconName; help: string }> = {
  human: { label: "Your word", icon: "quill", help: "Written by you. Human authority outranks every agent." },
  authority: { label: "Lane authority", icon: "key", help: "This agent's lane covers this entity, so it outranks agents without authority here." },
  none: { label: "No authority", icon: "eye", help: "This agent has no lane authority here: its word counts only with corroboration." },
};

export function AuthorityBadge({ authority }: { authority: Authority }) {
  const a = AUTH[authority];
  return (
    <span className={`auth auth--${authority}`} title={a.help}>
      <Icon name={a.icon} size={14} />
      {a.label}
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

/** A centered ornament divider with a label, e.g. ❦ Dormant ❦. */
export function Ornament({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 className="ornament play-ornament" id={id}>
      <span>{children}</span>
    </h2>
  );
}
