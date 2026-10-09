import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Effects } from "./common.tsx";
import type { StepProps } from "./model.ts";

export function WelcomeStep({ status, hasVault }: StepProps) {
  const { v } = useTerms();
  return (
    <div className="stack sz-welcome">
      <ol className="sz-pillars" aria-label="How Hippocampus works">
        <li className="sz-pillar">
          <Icon name="satchel" size={28} />
          <h3>The inbox</h3>
          <p>
            {v(
              "Your agents never edit your memory directly: they drop short notes about what they learned into an inbox.",
              "Your agents never edit your memory directly: they drop short episodes about what they learned into an inbox.",
            )}
          </p>
        </li>
        <li className="sz-pillar">
          <Icon name="moonStars" size={28} />
          <h3>{v("The nightly update", "The sleep")}</h3>
          <p>
            {v(
              "Each night an AI model reads them and turns the inbox into confirmed records: notes, goals and a timeline in an Obsidian vault you own.",
              "Each night a curator sleeps on them and turns the inbox into canon: notes, quests and a chronicle in an Obsidian vault you own.",
            )}
          </p>
        </li>
        <li className="sz-pillar">
          <Icon name="quill" size={28} />
          <h3>{v("Your decisions", "Your word")}</h3>
          <p>
            {v(
              "You have the final say: your edits and decisions outrank every agent, and what you write by hand is never overwritten.",
              "You have the final word: your edits and rulings outrank every agent, and what you write by hand is never overwritten.",
            )}
          </p>
        </li>
      </ol>
      <p>
        <a href={href.guide("how-it-works")}>
          How it works, in more detail <Icon name="chevron" size={14} />
        </a>
      </p>
      <Effects
        title={v("What setup does on this machine", "Session Zero, on this machine")}
        items={[
          [
            "writes",
            v(
              <>
                only when you press a button, and each button says where: a vault folder, agent notes in <code>party/</code>, your settings in <code>{status.envFile}</code>.
              </>,
              <>
                only when you press a button, and each button says where: a vault folder, <code>party/</code> notes, your settings in <code>{status.envFile}</code>.
              </>,
            ),
          ],
          ["shows", "commands for everything beyond this machine (GitHub, Cloudflare), for you to copy and run yourself."],
          [
            "never",
            v(
              "pushes to GitHub, or shows a private key or a saved API key back to this page. Your notes only ever reach the AI model you pick.",
              "pushes to GitHub, or shows a private key or a saved API key back to this page. Your notes only ever reach the curator model you pick.",
            ),
          ],
        ]}
      />
      {hasVault && (
        <div className="callout callout--ok">
          <Icon name="check" />
          <div>Your vault is already open. Walk the steps in order, or jump to any of them.</div>
        </div>
      )}
    </div>
  );
}
