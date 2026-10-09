import { useTerms } from "../../lib/prefs.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Effects } from "./common.tsx";
import { ConnectAgents } from "./Connect.tsx";
import type { StepProps } from "./model.ts";

export function AgentsStep({ status }: StepProps) {
  const { v } = useTerms();
  const seen = status.agents.filter((a) => a.lastSeen).length;
  return (
    <div className="stack">
      <Effects
        items={[
          [
            "shows",
            v(
              "a ready-made connection for each agent, with this vault's real path. You paste it into the agent's app; the dashboard changes nothing.",
              "a ready-made connection for each party member, with this vault's real path. You paste it into the agent's app; the dashboard changes nothing.",
            ),
          ],
          ["never", "changes an agent's app for you: you paste the snippet there, and the agent joins the next time it starts."],
        ]}
      />
      {status.agents.length > 0 &&
        v(
          <p className="small">
            {seen} of {status.agents.length} agents have sent notes so far. First thing for every agent: read <code>HANDBOOK.md</code> in the vault. Every nightly update regenerates it; it explains the conventions, the agents and the active goals.
          </p>,
          <p className="small">
            {seen} of {status.agents.length} party members have filed something so far. First thing for every agent: read <code>HANDBOOK.md</code> in the vault. It's regenerated on every sleep and explains the conventions, the party and the active quests.
          </p>,
        )}
      <ConnectAgents
        agents={status.agents}
        emptyHint={v(
          <>
            Add an agent in <a href="#party">the Agents step</a> first.
          </>,
          <>
            Add an agent in <a href="#party">the party step</a> first.
          </>,
        )}
      />
      <div className="callout">
        <Icon name="cloud" />
        <div className="small">
          Assistants that can't run a process on this machine (Claude.ai, ChatGPT, a phone) connect to a remote Worker instead: see the <a href="#remote">{v("Remote access step", "remote step")}</a>.
        </div>
      </div>
    </div>
  );
}
