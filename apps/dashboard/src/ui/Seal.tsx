import { useTerms } from "../lib/prefs.ts";
import type { FactStatus } from "../lib/types.ts";

const GLYPH: Record<FactStatus, string> = { canon: "✓", rumor: "?", disputed: "!", retconned: "✕" };
const HELP: Record<FactStatus, [plain: string, codex: string]> = {
  canon: ["Confirmed: accepted as true (canon)", "Canon: accepted truth"],
  rumor: ["Unverified: reported once by an agent that isn't responsible for this; check before relying on it (rumor)", "Rumor: reported once by an agent without authority here; verify first"],
  disputed: ["Disputed: sources disagree and wait for your decision", "Disputed: sources disagree and wait for your ruling"],
  retconned: ["Replaced: no longer current (retconned)", "Retconned: superseded"],
};

/** A fact's status as a seal: glyph + word + color, never color alone. Plain words by default. */
export function Seal({ status, compact }: { status: FactStatus; compact?: boolean }) {
  const { t, plain } = useTerms();
  const word = t(status);
  return (
    <span className={`seal seal--${status}`} title={HELP[status][plain ? 0 : 1]}>
      <span className="seal__glyph" aria-hidden>
        {GLYPH[status]}
      </span>
      {compact ? <span className="sr-only">{word}</span> : word}
    </span>
  );
}
