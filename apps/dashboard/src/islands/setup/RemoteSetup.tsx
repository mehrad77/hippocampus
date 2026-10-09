import { plural } from "../../lib/format.ts";
import type { RemoteSetupStatus, SessionInfo } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Panel } from "../../ui/Parts.tsx";
import { Facts, Snippets } from "./common.tsx";
import { ConnectAgents } from "./Connect.tsx";
import { HealthChecklist } from "./Health.tsx";
import { UnknownAgents } from "./PartyStep.tsx";
import { TokensPanel } from "./Tokens.tsx";

const SECTION: Record<string, string> = { repo: "#sz-repo", oauth: "#sz-oauth", index: "#sz-index", agents: "#sz-agents", party: "#sz-agents", tokens: "#sz-tokens" };

/** Session Zero on the Worker: health from the Worker's point of view, connect snippets, and agent tokens. */
export function RemoteSetup({ session, status }: { session: SessionInfo; status: RemoteSetupStatus }) {
  const { repo, oauth, index } = status;
  return (
    <div className="stack sz">
      <header className="page-head">
        <div>
          <div className="page-head__kicker">Session Zero{session.campaign ? ` · ${session.campaign}` : ""}</div>
          <h1>Setup & health</h1>
          <p className="page-head__lede">
            Your Worker's view of the campaign, and the keys to it. The vault folder, the curator and the nightly sleep live on your own machine: set those up with <code>hippo dashboard</code> there.
          </p>
        </div>
        <span className="chip sz-where" title="This dashboard is served by your Cloudflare Worker.">
          <Icon name="cloud" size={14} /> On the Worker
        </span>
      </header>

      {repo.private === false && <PublicRepoAlarm name={repo.name} />}

      {status.items.length > 0 && <HealthChecklist items={status.items} linkFor={(id) => SECTION[id]} />}

      <div className="grid grid--3">
        <Panel title="Vault repository" icon="github" id="sz-repo">
          <Facts
            rows={[
              ["Repository", <span className="mono sz-break">{repo.name}</span>],
              ["Branch", <span className="mono">{repo.branch}</span>],
              ["Head", repo.head ? <span className="mono">{repo.head.slice(0, 7)}</span> : <span className="muted">unknown</span>],
              ["Private", repo.private === undefined ? <span className="muted">Couldn't tell</span> : repo.private ? "Yes" : <strong className="sz-danger-text">NO: public</strong>],
              ...(status.publicUrl ? ([["Worker URL", <span className="mono sz-break">{status.publicUrl}</span>]] as [string, React.ReactNode][]) : []),
            ]}
          />
        </Panel>

        <Panel title="Sign-in (OAuth)" icon="lock" id="sz-oauth">
          <div className="stack sz-tight">
            {oauth.on ? (
              <p className="small">
                <strong>On.</strong> {plural(oauth.owners, "GitHub account")} may sign in and connect apps. Claude.ai and ChatGPT can add <span className="mono sz-break">{status.publicUrl ? `${status.publicUrl}/mcp` : "<worker>/mcp"}</span> as a custom connector.
              </p>
            ) : (
              <p className="small">
                <strong>Off.</strong> Agents with tokens still work; connectors that sign in with OAuth (Claude.ai, ChatGPT) and the dashboard's GitHub sign-in need it.
              </p>
            )}
            {oauth.missing.length > 0 && (
              <>
                <p className="small">Missing settings. Set each from <code>apps/worker</code>, then redeploy:</p>
                <Snippets snippets={[{ label: "Missing Worker secrets", lang: "bash", code: oauth.missing.map((m) => `pnpm exec wrangler secret put ${m}`).join("\n") }]} />
              </>
            )}
          </div>
        </Panel>

        <Panel title="Search index" icon="search" id="sz-index">
          <div className="stack sz-tight">
            <Facts
              rows={[
                ["Entities", index.entities === undefined ? <span className="muted">not built yet</span> : index.entities.toLocaleString("en")],
                ["Recall", index.embedder ? <>semantic, with <span className="mono">{index.embedder}</span></> : "keywords only"],
              ]}
            />
            {index.lastError && (
              <div className="callout callout--danger" role="alert">
                <Icon name="warn" />
                <div>
                  <strong>The last index update failed.</strong>
                  <div className="small">{index.lastError}</div>
                </div>
              </div>
            )}
          </div>
        </Panel>
      </div>

      <UnknownAgents ids={status.unknownAgents} canAdd={session.capabilities.party} />

      <Panel title="Connect agents" icon="link" id="sz-agents">
        <p className="small">
          Agents on other machines connect over HTTP with their own token (mint one below). Apps that add MCP servers as connectors sign in with OAuth instead, choosing the agent they act as.
        </p>
        <ConnectAgents agents={status.agents} emptyHint="Add a party note in party/ for each agent; its snippets appear here." />
      </Panel>

      <TokensPanel agents={status.agents} />
    </div>
  );
}

function PublicRepoAlarm({ name }: { name: string }) {
  return (
    <div className="callout callout--danger sz-loud" role="alert">
      <Icon name="warn" />
      <div className="stack sz-tight">
        <strong>The vault repository {name} is PUBLIC.</strong>
        <span>
          Anyone can read your campaign: notes, inbox and chronicle. Make it private now (on GitHub: the repository → Settings → General → Danger Zone → Change visibility), then assume anything already pushed may have been seen.
        </span>
      </div>
    </div>
  );
}
