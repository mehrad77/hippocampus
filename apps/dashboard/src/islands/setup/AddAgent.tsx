import { useEffect, useRef, useState } from "react";
import { CONNECT_APPS, connectSnippet, mcpServerName, setupPrompt, type ConnectAppId } from "@hippocampus/dashboard/connect";
import { ApiError, getJson, postJson } from "../../lib/api.ts";
import { invalidate, useResource } from "../../lib/cache.ts";
import { useTerms } from "../../lib/prefs.ts";
import { BASE, href } from "../../lib/routes.ts";
import type { AccountApp, HostedAgentClaim, HostedKeyInfo, HostedMintedKey, HostedStatus } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { CopyButton, RelTime } from "../../ui/Parts.tsx";
import { CopyLine, ErrorCallout, refreshSetup, SnippetBlock, Snippets, ToneTag, useAction } from "./common.tsx";
import { arrival, connectionRows, type Arrival } from "./hosted.ts";

/**
 * Adding an agent: one prompt first. A capable agent connects itself with device sign-in (the person
 * approves it on the connect page), learns the memory routine and checks who curates; nobody picks an app
 * or copies a key. Two quieter ways cover apps that can't run commands: the sign-in address for Claude.ai
 * and ChatGPT, and today's app picker with its key snippet. The same card serves onboarding, Setup &
 * health and anywhere else an agent is added.
 */
export function AddAgent({ status, onArrived }: { status: HostedStatus; onArrived?: () => void }) {
  const { v } = useTerms();
  const vault = status.vault!;
  const prompt = setupPrompt({ publicUrl: status.publicUrl, vault: vault.fullName });
  const seen = useArrival(vault.id, onArrived);
  const [picking, setPicking] = useState(false);

  return (
    <div className="stack hz-add">
      <section className="hz-add__main" aria-labelledby="hz-add-title">
        <h3 className="sz-subhead" id="hz-add-title">
          <Icon name="sparkle" size={18} /> Paste this into your agent
        </h3>
        <p className="small">
          {v(
            "Claude Code, Cursor, a Grok bot or any agent that can run commands. It connects itself (you approve it here, no key to copy), adds the memory routine to its own instructions with your OK, and checks who curates.",
            "Claude Code, Cursor, a Grok bot or any agent that can run commands. It takes its own seat (you approve it here, no key to copy), learns the table's ways with your OK, and checks who curates.",
          )}
        </p>
        <div className="hz-prompt">
          <SnippetBlock snippet={{ label: "The setup prompt", lang: "text", code: prompt, note: "It holds no key. Pasting it again into the same agent only fills what's missing." }} />
        </div>
        <ArrivalLine seen={seen} />
      </section>

      <div className="hz-add__more">
        <details className="sz-details">
          <summary>Claude.ai or ChatGPT: add this connector address</summary>
          <div className="stack sz-tight">
            <p className="small">These sign in with your account instead of a key. Add a custom connector with this address; the app asks you to sign in and which vault it is. Sign-in is still in beta: if it fails, use the prompt above with another app.</p>
            <CopyLine value={`${status.publicUrl}/mcp`} label="MCP address for sign-in" />
          </div>
        </details>
        <details className="sz-details" open={picking} onToggle={(e) => setPicking((e.target as HTMLDetailsElement).open)}>
          <summary>Another app: get its config snippet</summary>
          {picking && <KeyConnect status={status} />}
        </details>
      </div>
    </div>
  );
}

/** Watches for a connection that wasn't there when the card opened, and says how far it got. */
function useArrival(vaultId: string, onArrived?: () => void): Arrival | undefined {
  const keys = useResource<{ keys: HostedKeyInfo[]; agents?: HostedAgentClaim[] }>("/setup/keys", { poll: 5000 });
  const apps = useResource<{ apps: AccountApp[] }>("/account/apps", { poll: 5000 });
  const before = useRef<Set<string>>(undefined);
  const told = useRef(false);
  const rows = keys.data ? connectionRows(keys.data.keys, apps.data?.apps ?? [], vaultId, keys.data.agents) : undefined;
  // What was connected already when the card opened doesn't count (an older server without the apps list: keys alone).
  if (rows && !before.current && (apps.data || apps.error)) before.current = new Set(rows.map((r) => r.id));
  const seen = rows && before.current ? arrival(rows, before.current) : undefined;
  const connected = seen?.state === "connected";
  useEffect(() => {
    if (!connected || told.current) return;
    told.current = true;
    void refreshSetup();
    onArrived?.();
  }, [connected]);
  return seen;
}

function ArrivalLine({ seen }: { seen?: Arrival }) {
  return (
    <div className="row hz-arrival" role="status" aria-live="polite">
      {!seen || seen.state === "waiting" ? (
        <>
          <ToneTag tone="wait" word="Waiting" title="No new agent yet" />
          <span className="small muted">
            Waiting for your agent. It shows you a link and a code: open the link, or <a href={`${BASE}/connect/`}>enter the code here</a>.
          </span>
        </>
      ) : seen.state === "approved" ? (
        <>
          <ToneTag tone="wait" word="Approved" title="Connected, not called in yet" />
          <span className="small muted">{seen.name} is connected. Waiting for its first call.</span>
        </>
      ) : (
        <>
          <ToneTag tone="done" word="Connected" title="It called in" />
          <span className="small">
            {seen.agent ? (
              <>
                Connected as <span className="mono">{seen.agent}</span>.
              </>
            ) : (
              <>{seen.name} is connected.</>
            )}{" "}
            <a href={href.page("party")}>See it on the Agents page →</a>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The app picker, for an app that can't connect itself: pick it, get one key and that app's snippet (the key
 * shown once), then a check that it called in. The agents in it name themselves.
 */
export function KeyConnect({ status, onConnected }: { status: HostedStatus; onConnected?: () => void }) {
  const [app, setApp] = useState<ConnectAppId>("claude-code");
  const [minted, setMinted] = useState<HostedMintedKey>();
  const action = useAction();
  const appName = CONNECT_APPS.find((a) => a.id === app)!.name;

  const connect = async () => {
    const res = await action.run(() => postJson<HostedMintedKey>("/setup/keys", { kind: "agent", label: appName, app }));
    if (!res) return;
    setMinted(res);
    onConnected?.();
    void refreshSetup();
    void invalidate((k) => k === "/setup/keys");
  };

  if (minted)
    return (
      <div className="stack">
        <Connected minted={minted} app={app} status={status} />
        <div className="row">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setMinted(undefined);
              action.clear();
            }}
          >
            Connect another app
          </button>
        </div>
      </div>
    );
  return (
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
      {action.error !== undefined && <ErrorCallout error={action.error} />}
      <div className="row">
        <button type="button" className="btn btn--primary" onClick={() => void connect()} disabled={action.busy || status.vault?.status !== "ready"}>
          <Icon name="link" /> {action.busy ? "Connecting…" : `Connect ${appName}`}
        </button>
      </div>
    </div>
  );
}

/** The key, shown once, with the chosen app's snippet first, the setup prompt to tell it next, and a check that the app called in. */
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
      {app !== "script" && (
        <details className="sz-details">
          <summary>Then tell your agent</summary>
          <div className="hz-prompt">
            <SnippetBlock snippet={{ label: "The setup prompt", lang: "text", code: setupPrompt({ publicUrl: status.publicUrl, vault: status.vault!.fullName }), note: "It's connected already, so the agent skips that step: it names itself, adds the memory routine and checks who curates." }} />
          </div>
        </details>
      )}
      {rest.length > 0 && (
        <details className="sz-details">
          <summary>Other apps</summary>
          <Snippets snippets={rest} />
        </details>
      )}
    </div>
  );
}
