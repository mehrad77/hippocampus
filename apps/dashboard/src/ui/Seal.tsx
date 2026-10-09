import type { FactStatus } from "../lib/types.ts";

const GLYPH: Record<FactStatus, string> = { canon: "✓", rumor: "?", disputed: "!", retconned: "✕" };
const HELP: Record<FactStatus, string> = {
  canon: "Canon: accepted truth",
  rumor: "Rumor: reported once by an agent without authority here; verify first",
  disputed: "Disputed: sources disagree and wait for your ruling",
  retconned: "Retconned: superseded",
};

/** A fact's status as a wax seal: glyph + word + color, never color alone. */
export function Seal({ status, compact }: { status: FactStatus; compact?: boolean }) {
  return (
    <span className={`seal seal--${status}`} title={HELP[status]}>
      <span className="seal__glyph" aria-hidden>
        {GLYPH[status]}
      </span>
      {compact ? <span className="sr-only">{status}</span> : status}
    </span>
  );
}
