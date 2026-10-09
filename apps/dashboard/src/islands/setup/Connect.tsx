import { useState } from "react";
import type { AgentConnect } from "../../lib/types.ts";
import { Empty, RelTime } from "../../ui/Parts.tsx";
import { Snippets } from "./common.tsx";

/** Pick a party member, copy the snippet for the app it runs in. Snippets come from the server with real paths. */
export function ConnectAgents({ agents, emptyHint }: { agents: readonly AgentConnect[]; emptyHint?: React.ReactNode }) {
  const [picked, setPicked] = useState<string | undefined>(agents[0]?.agent);
  const current = agents.find((a) => a.agent === picked) ?? agents[0];
  if (!current)
    return (
      <Empty icon="party" title="No party members yet">
        {emptyHint ?? "Add an agent to the party first; its connection snippets appear here."}
      </Empty>
    );
  return (
    <div className="stack">
      <div className="sz-agents" role="group" aria-label="Party member">
        {agents.map((a) => {
          const on = a.agent === current.agent;
          return (
            <button key={a.agent} type="button" aria-pressed={on} className="sz-agent" onClick={() => setPicked(a.agent)}>
              <span className="sz-agent__title">{a.title}</span>
              <span className="sz-agent__id mono">{a.agent}</span>
              <span className={`sz-agent__seen ${a.lastSeen ? "is-seen" : ""}`}>
                <span aria-hidden>{a.lastSeen ? "●" : "○"}</span> {a.lastSeen ? <>seen <RelTime at={a.lastSeen} /></> : "not yet"}
              </span>
            </button>
          );
        })}
      </div>
      <div className="sz-agentpanel" aria-live="polite">
        <p className="small muted">
          Connecting as <strong>{current.title}</strong> (<span className="mono">{current.agent}</span>). Copy the one for the app it runs in.
        </p>
        {current.snippets.length ? <Snippets snippets={current.snippets} /> : <p className="muted">No snippets for this agent here.</p>}
      </div>
    </div>
  );
}
