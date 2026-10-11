import { useEffect, useState } from "react";
import { CONNECT_APPS, CURATION_PLACES, connectSnippet, mcpServerName, type ConnectAppId, type CurationPlace } from "@hippocampus/dashboard/connect";
import { ApiError, getJson, postJson } from "../../lib/api.ts";
import { useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import type { AccountApp, HostedAgentClaim, HostedCuratorActionsResult, HostedKeyInfo, HostedMintedKey, HostedStatus } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { CopyButton, Dialog, Empty, Panel, RelTime, SkeletonPanel } from "../../ui/Parts.tsx";
import { ConfirmDialog, CopyLine, Effects, ErrorCallout, Facts, refreshSetup, Snippets, ToneTag, useAction } from "./common.tsx";
import { actionsSnippets, connectionRows, type ConnectionRow } from "./hosted.ts";

const SCOPE_WORDS: Record<string, string> = { read: "read: search and read", remember: "remember: add new memories", goal: "goal: update goals", curate: "curate: run sleep (sees secrets)" };

/** Everything connected to this vault, keys and sign-in apps alike: what it is, who it acts as, what it may do. */
export function ConnectionsPanel({ status }: { status: HostedStatus }) {
  const { v } = useTerms();
  const vault = status.vault!;
  const owner = vault.role === "owner";
  const keys = useResource<{ keys: HostedKeyInfo[]; agents?: HostedAgentClaim[] }>("/setup/keys", { poll: 30_000 });
  const apps = useResource<{ apps: AccountApp[] }>("/account/apps");
  const [connecting, setConnecting] = useState(false);
  const [details, setDetails] = useState<ConnectionRow>();
  const [dropping, setDropping] = useState<ConnectionRow>();
  const act = useAction();
  const rows = keys.data ? connectionRows(keys.data.keys, apps.data?.apps ?? [], vault.id, keys.data.agents) : undefined;

  const disconnect = async (r: ConnectionRow) => {
    const res = await act.run(() => postJson(r.source === "key" ? "/setup/keys/revoke" : "/account/apps/revoke", { id: r.id }));
    if (!res) return;
    toast(`${r.name} is disconnected.`, "ok");
    setDropping(undefined);
    void keys.reload();
    void apps.reload();
    void refreshSetup();
  };

  const setCurate = async (r: ConnectionRow, on: boolean) => {
    const res = await act.run(() => postJson("/account/apps/curate", { id: r.id, on }));
    if (!res) return;
    toast(on ? `${r.name} may run sleep now. It sees secret memories while it does.` : `${r.name} can't run sleep anymore.`, "ok");
    void apps.reload();
  };

  return (
    <Panel
      title={v("Connected apps", "Who's at the table")}
      icon="link"
      id="connections"
      aside={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setConnecting(true)}>
          <Icon name="plus" size={16} /> Connect an app
        </button>
      }
    >
      <div className="stack">
        <p className="small">
          {v("One connection per app, to this vault only. The agents that run in an app name themselves and show up on the Agents page.", "One seat per app, at this table only. The agents that run in an app name themselves and show up on the Party page.")} {owner ? "" : "You see the connections you made. "}Disconnecting one stops it at once.
        </p>
        {keys.error && !keys.data ? (
          <ErrorCallout error={keys.error} onRetry={() => void keys.reload()} />
        ) : !rows ? (
          <SkeletonPanel lines={3} />
        ) : rows.length ? (
          <div className="table-wrap">
            <table className="table hz-rtable">
              <thead>
                <tr>
                  <th scope="col">App</th>
                  <th scope="col">Agents</th>
                  <th scope="col">Can</th>
                  <th scope="col">Last used</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="App">
                      <strong>{r.name}</strong>
                      <span className="small muted"> · {r.source === "app" ? "sign-in" : "key"}</span>
                    </td>
                    <td data-label="Agents">
                      <AgentsOf row={r} />
                    </td>
                    <td data-label="Can">
                      {r.can}
                      {r.curating && (
                        <label className="small row sz-tight-row">
                          <input type="checkbox" checked={r.curating.on} disabled={act.busy} onChange={(e) => void setCurate(r, e.target.checked)} /> May curate (sees secrets)
                        </label>
                      )}
                    </td>
                    <td data-label="Last used">{r.lastUsed ? <RelTime at={r.lastUsed} /> : <span className="muted">{r.source === "app" ? "—" : "not yet"}</span>}</td>
                    <td className="sz-tokens__act">
                      <span className="row sz-tight-row">
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDetails(r)} aria-label={`Details of ${r.name}`}>
                          Details
                        </button>
                        <button type="button" className="btn btn--sm btn--danger" onClick={() => setDropping(r)} aria-label={`Disconnect ${r.name}`}>
                          Disconnect
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="link" title="Nothing connected yet">
            Connect Claude Code, Cursor or another app, and it can remember and recall with this vault.
          </Empty>
        )}
      </div>

      <ConnectDialog open={connecting} onClose={() => setConnecting(false)} status={status} onConnected={() => void keys.reload()} />
      <Dialog open={!!details} onClose={() => setDetails(undefined)} title={details?.name ?? "Details"}>
        {details && (
          <div className="stack">
            <Facts
              rows={[
                ["Kind", details.kind],
                ["Agents", "agent" in details.actsAs ? <span className="mono">{details.actsAs.agent}</span> : "curator" in details.actsAs ? "the curator (named at sleep_start)" : <AgentsOf row={details} long />],
                ["Scopes", <span className="mono">{details.scopes.map((s) => SCOPE_WORDS[s] ?? s).join("; ")}</span>],
                ["Vault", <span className="mono sz-break">{vault.fullName}</span>],
                ["Address", <span className="mono sz-break">{status.mcpUrl}</span>],
                ["Connected", <RelTime at={details.created} />],
                ...(details.source === "key" ? ([["Key id", <span className="mono">{details.id.slice(0, 12)}…</span>]] as [string, React.ReactNode][]) : []),
              ]}
            />
            <p className="small muted">
              {details.source === "key" ? "Only a hash of the key is kept; it can't be shown again. To move an app to another machine, connect it again and disconnect this one." : "A sign-in app holds a token from your GitHub sign-in, not a key."}
            </p>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!dropping}
        onClose={() => {
          setDropping(undefined);
          act.clear();
        }}
        title={`Disconnect ${dropping?.name ?? ""}?`}
        confirmLabel="Disconnect"
        danger
        busy={act.busy}
        onConfirm={() => dropping && void disconnect(dropping)}
      >
        <p>It stops working at once. What it already saved stays in the vault.</p>
        {act.error !== undefined && <ErrorCallout error={act.error} />}
      </ConfirmDialog>
    </Panel>
  );
}

/** The agents a connection has spoken as: fixed, the curator, or (for a shared one) whoever has named themselves through it. */
function AgentsOf({ row, long }: { row: ConnectionRow; long?: boolean }) {
  if ("curator" in row.actsAs) return <>The curator</>;
  if ("agent" in row.actsAs) return <span className="mono">{row.actsAs.agent}</span>;
  if (!row.agents.length) return <span className="muted">{long ? "none yet: each agent names itself on its first call" : "none yet"}</span>;
  return (
    <span className="mono sz-break">
      {row.agents.map((a, i) => (
        <span key={a.agent} title={`since ${a.since.slice(0, 10)}`}>
          {i ? ", " : ""}
          {a.agent}
        </span>
      ))}
    </span>
  );
}

/**
 * Connecting an app: pick which one. That's all there is to ask: it gets one key, the agents that run
 * in it name themselves and join the Agents page, and the result is its snippet with the key (shown
 * once) and a check that it called in.
 */
export function ConnectDialog({ open, onClose, status, onConnected }: { open: boolean; onClose: () => void; status: HostedStatus; onConnected?: () => void }) {
  const vault = status.vault!;
  const [app, setApp] = useState<ConnectAppId>("claude-code");
  const [minted, setMinted] = useState<HostedMintedKey>();
  const action = useAction();
  const appName = CONNECT_APPS.find((a) => a.id === app)!.name;

  const close = () => {
    setApp("claude-code");
    setMinted(undefined);
    action.clear();
    onClose();
  };
  const connect = async () => {
    const res = await action.run(() => postJson<HostedMintedKey>("/setup/keys", { kind: "agent", label: appName, app }));
    if (!res) return;
    setMinted(res);
    onConnected?.();
    void refreshSetup();
  };

  const footer = minted ? (
    <button type="button" className="btn btn--primary" onClick={close}>
      <Icon name="check" /> Done
    </button>
  ) : (
    <>
      <button type="button" className="btn btn--ghost" onClick={close}>
        Cancel
      </button>
      <button type="button" className="btn btn--primary" onClick={() => void connect()} disabled={action.busy}>
        <Icon name="link" /> {action.busy ? "Connecting…" : "Connect"}
      </button>
    </>
  );

  return (
    <Dialog open={open} onClose={minted ? () => undefined : close} title={minted ? `Connected to ${vault.fullName}` : `Connect an app to ${vault.fullName}`} footer={footer} wide>
      {minted ? (
        <Connected minted={minted} app={app} status={status} />
      ) : (
        <div className="stack">
          <p className="small muted">Which app?</p>
          <div className="hz-apps" role="radiogroup" aria-label="The app">
            {CONNECT_APPS.map((a) => (
              <label key={a.id} className={`hz-app${app === a.id ? " is-picked" : ""}`}>
                <input type="radio" name="hz-app" checked={app === a.id} onChange={() => setApp(a.id as ConnectAppId)} />
                <strong>{a.name}</strong>
                <span className="small muted">{a.where}</span>
              </label>
            ))}
          </div>
          <p className="small muted">It gets one key. The agents in it name themselves, and join your Agents page with no authority until you give them some.</p>
          <details className="sz-details">
            <summary>Claude.ai or ChatGPT (sign-in, beta)</summary>
            <div className="stack sz-tight">
              <p className="small">These apps sign in with your account instead of a key. Add a custom connector with this address; the app asks you to sign in and which vault it is. Its agents then name themselves. Sign-in is still in beta: if it fails, connect another app with a key.</p>
              <CopyLine value={`${status.publicUrl}/mcp`} label="MCP address for sign-in" />
            </div>
          </details>
          {action.error !== undefined && <ErrorCallout error={action.error} />}
        </div>
      )}
    </Dialog>
  );
}

/** The key, shown once, with the chosen app's snippet first, and a check that the app called in. */
function Connected({ minted, app, status }: { minted: HostedMintedKey; app: ConnectAppId; status: HostedStatus }) {
  // The chosen app's snippet is made here, from the same module the server uses, so it's always that app's.
  const first = connectSnippet(app, { url: status.mcpUrl, key: minted.token, server: mcpServerName(status.vault!.fullName) });
  const rest = minted.snippets.filter((s) => s.label !== first.label);
  const [seen, setSeen] = useState<string>();
  useEffect(() => {
    let stop = false;
    const look = async () => {
      try {
        const { keys } = await getJson<{ keys: HostedKeyInfo[] }>("/setup/keys");
        const used = keys.find((k) => k.id === minted.id)?.lastUsed;
        if (used && !stop) return setSeen(used);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return;
      }
      if (!stop) timer = setTimeout(() => void look(), 5000);
    };
    let timer = setTimeout(() => void look(), 3000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [minted.id]);
  const appName = CONNECT_APPS.find((a) => a.id === app)!.name;
  return (
    <div className="stack">
      <div className="callout callout--warn" role="note">
        <Icon name="lock" />
        <div>
          <strong>Copy it now: you won't see this key again.</strong> It's inside the snippet below. If it's lost, disconnect this and connect again.
        </div>
      </div>
      <h3 className="sz-subhead">In {appName}</h3>
      <Snippets snippets={[first]} />
      <div className="sz-token">
        <pre className="sz-token__value" tabIndex={0} aria-label="The key">
          <code>{minted.token}</code>
        </pre>
        <CopyButton text={minted.token} label="Copy the key" />
      </div>
      <div className="row" role="status" aria-live="polite">
        {seen ? (
          <ToneTag tone="done" word="Connected" title="It called in" />
        ) : (
          <>
            <ToneTag tone="wait" word="Waiting" title="Not called in yet" />{" "}
            <span className="small muted">
              Waiting for its first call. {app === "xai-api" || app === "script" ? "Have it make a request, like recalling something." : `Start ${appName} (or a new session in it) and ask it to recall something.`}
            </span>
          </>
        )}
        {seen && (
          <span className="small muted">
            First call <RelTime at={seen} />.
          </span>
        )}
      </div>
      {rest.length > 0 && (
        <details className="sz-details">
          <summary>Other apps</summary>
          <Snippets snippets={rest} />
        </details>
      )}
    </div>
  );
}

/**
 * Where the nightly curator runs: the same three choices as the `sleep-setup` skill, with what each
 * needs. The curator sees secret memories, so only the owner sets it up.
 */
export function CurationSetup({ status, bare, runs }: { status: HostedStatus; bare?: boolean; runs?: React.ReactNode }) {
  const { v } = useTerms();
  const github = (status.vault?.provider ?? "github") === "github";
  // An agent they already have first: it costs nothing new. Actions needs Claude paid for.
  const [place, setPlace] = useState<CurationPlace>(status.curatorActions ? "actions" : "schedule");
  const [minted, setMinted] = useState<HostedMintedKey>();
  const action = useAction();
  const mint = async () => {
    const res = await action.run(() => postJson<HostedMintedKey>("/setup/keys", { kind: "curator", label: CURATION_PLACES.find((p) => p.id === place)!.title }));
    if (!res) return;
    setMinted(res);
    void refreshSetup();
  };
  const places = CURATION_PLACES.filter((p) => github || p.id !== "actions");
  const snippets = minted?.snippets ?? [];
  const forPlace =
    place === "actions" ? snippets.filter((s) => /Actions/.test(s.label)) : place === "schedule" ? snippets.filter((s) => !/Actions|cron/.test(s.label)) : snippets.filter((s) => /cron|prompt/.test(s.label));
  // Once a curator is set up, its runs come first and the setup folds away.
  const configured = !!status.curatorActions || (status.keys ?? []).some((k) => k.kind === "curator");
  const setup = (
    <div className="stack">
      <p className="small">
        Every night, a curator turns what your agents saved into notes: it settles facts, updates goals and the timeline, and empties the inbox. Pick where it runs. In Claude Code, <code>/hippocampus:sleep-setup</code> walks you through the same choices.
      </p>
      <div className="callout callout--warn" role="note">
        <Icon name="lock" />
        <div>
          <strong>The curator sees secret memories.</strong> Give sleep <strong>a bot of its own</strong>: a separate agent (its own Claude Code project or scheduled task, its own Grok bot) that only curates, with its own curator key. Not the agent you chat with every day, and only with an AI provider you trust with your secrets. One curator per vault is enough.
        </div>
      </div>
      <fieldset className="sz-fieldset">
        <legend className="label">Where it runs</legend>
        {places.map((p) => (
          <label key={p.id} className="check sz-scope">
            <input type="radio" name="hz-curation" checked={place === p.id} onChange={() => setPlace(p.id)} />
            <span>
              <strong>{p.title}</strong>
              <span className="small muted"> · {p.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {action.error !== undefined && <ErrorCallout error={action.error} />}
      {minted ? (
        <div className="stack sz-tight">
          <p className="small">
            <strong>Your curator key</strong> is in the snippets below; you won't see it again.
          </p>
          <Snippets snippets={forPlace.length ? forPlace : snippets} />
        </div>
      ) : (
        <div className="row">
          <button type="button" className="btn btn--primary" onClick={() => void mint()} disabled={action.busy || status.vault?.status !== "ready"}>
            <Icon name="key" /> {action.busy ? "Creating…" : place === "actions" ? "1. Create the curator key" : "Create the curator key"}
          </button>
        </div>
      )}
      {place === "actions" && github && <ActionsCurator status={status} />}
      {place === "schedule" && (
        <p className="small muted">
          Connect the bot with its snippet, then have it run the sleep prompt nightly (or whenever you ask). In Claude Code, install the plugin (<code>claude plugin install hippocampus@hippocampus</code>) and ask for <code>/hippocampus:sleep-setup</code>: it creates the nightly task. See{" "}
          <a href={href.guide("nightly-sleep")}>the nightly sleep</a>.
        </p>
      )}
    </div>
  );
  if (bare) return setup;
  return (
    <Panel title={v("Nightly curation", "The nightly sleep")} icon="moonStars" id="curation">
      <div className="stack">
        {runs}
        {configured && runs ? (
          <details className="sz-details">
            <summary>Set up the curator, or change where it runs</summary>
            {setup}
          </details>
        ) : (
          setup
        )}
      </div>
    </Panel>
  );
}

/** The vault repo's nightly GitHub Actions workflow: what it needs, and turning it on or off. */
export function ActionsCurator({ status }: { status: HostedStatus }) {
  const action = useAction();
  const known = status.curatorActions !== undefined;
  const on = !!status.curatorActions;
  const repo = status.vault?.fullName ?? "<you>/vault";
  const toggle = async () => {
    const res = await action.run(() => postJson<HostedCuratorActionsResult>("/setup/curator-actions", { enable: !on }));
    if (!res) return;
    toast(res.enabled ? `The Actions curator is on: ${res.path}.` : "The Actions curator is off.", "ok");
    await refreshSetup();
  };
  return (
    <section className="sz-card" aria-labelledby="hz-actions-title">
      <div className="sz-card__head">
        <Icon name="github" />
        <strong id="hz-actions-title">Or let GitHub Actions curate</strong>
        {known ? <ToneTag tone={on ? "done" : "na"} word={on ? "On" : "Off"} title={on ? "The workflow runs every night" : "Not set up"} compact /> : <ToneTag tone="optional" word="Unknown" title="Couldn't check the repository just now" compact />}
      </div>
      <p className="small">
        A workflow in your vault repository runs the curator there every night, so no machine of yours has to be on. It uses your repository's Actions minutes and your own Anthropic API key, which stays in the repository's secrets. Set these first:
      </p>
      <Snippets snippets={actionsSnippets(repo, status.mcpUrl)} />
      <Effects
        items={[
          ["writes", on ? <>removes the workflow (<code>.github/workflows/sleep.yml</code>) from <code>{repo}</code>, in one commit.</> : <>the workflow (<code>.github/workflows/sleep.yml</code>) into <code>{repo}</code>, in one commit.</>],
          ["never", "sees your Anthropic API key: GitHub hands it to the workflow."],
        ]}
      />
      {action.error !== undefined && <ErrorCallout error={action.error} />}
      <div className="row">
        <button type="button" className={`btn ${on ? "" : "btn--primary"}`} onClick={() => void toggle()} disabled={action.busy || status.vault?.status !== "ready"}>
          <Icon name={on ? "close" : "moonStars"} /> {action.busy ? "Working…" : on ? "Turn it off" : "Turn it on"}
        </button>
      </div>
    </section>
  );
}
