import { useEffect, useState } from "react";
import { CURATION_PLACES, type CurationPlace } from "@hippocampus/dashboard/connect";
import { ApiError, postJson } from "../../lib/api.ts";
import { useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import type {
  AccountApp,
  HostedActionsModel,
  HostedActionsRunResult,
  HostedActionsSecretsRequest,
  HostedActionsSecretsResult,
  HostedAgentClaim,
  HostedCuratorActionsResult,
  HostedCuratorActionsState,
  HostedKeyInfo,
  HostedMintedKey,
  HostedStatus,
} from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Dialog, Empty, Panel, RelTime, SkeletonPanel } from "../../ui/Parts.tsx";
import { AddAgent } from "./AddAgent.tsx";
import { HostedCurator } from "./HostedCurator.tsx";
import { ConfirmDialog, Effects, ErrorCallout, Facts, Field, refreshSetup, Snippets, ToneTag, useAction } from "./common.tsx";
import { ACTIONS_CREDENTIALS, actionsChecklist, actionsRunTone, actionsSnippets, connectionRows, credentialProblem, runEvent, type ActionsCredential, type ConnectionRow } from "./hosted.ts";

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

      <Dialog open={connecting} onClose={() => setConnecting(false)} title={`Add an agent to ${vault.fullName}`} wide>
        {connecting && <AddAgent status={status} onArrived={() => void keys.reload()} />}
      </Dialog>
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
 * Where the nightly curator runs: the same three choices as the `sleep-setup` skill, with what each
 * needs. The curator sees secret memories, so only the owner sets it up.
 */
export function CurationSetup({ status, bare, runs, curated }: { status: HostedStatus; bare?: boolean; runs?: React.ReactNode; curated?: boolean }) {
  const { v } = useTerms();
  const github = (status.vault?.provider ?? "github") === "github";
  // Hippocampus's own curation, where the instance offers it; in the bare (onboarding) list it has a choice of its own.
  const hosted = !bare && !!status.hostedCurator?.available;
  const hostedOn = hosted && !!(status.hostedCurator?.vault?.enabled || status.hostedCurator?.keyHint);
  // An agent they already have first: it costs nothing new. Actions needs Claude paid for.
  // Until the person picks, the choice follows the status: what runs now, else Hippocampus's own where offered.
  const [picked, setPlace] = useState<CurationPlace>();
  // Once hosted curation is set up, its card stands on its own above the other places.
  const places = CURATION_PLACES.filter((p) => (github || p.id !== "actions") && (p.id !== "hosted" || (hosted && !hostedOn)));
  const wanted = picked ?? (status.curatorActions ? "actions" : hosted && !hostedOn ? "hosted" : "schedule");
  // A place that left the list (hosted curation just saved) falls back to the first agent choice.
  const place: CurationPlace = places.some((p) => p.id === wanted) ? wanted : "schedule";
  const [minted, setMinted] = useState<HostedMintedKey>();
  const action = useAction();
  const mint = async () => {
    // A key for Actions made by hand carries the same tag as the card's, so saving on the card later revokes it.
    const res = await action.run(() => postJson<HostedMintedKey>("/setup/keys", { kind: "curator", label: CURATION_PLACES.find((p) => p.id === place)!.title, ...(place === "actions" ? { app: "github-actions" } : {}) }));
    if (!res) return;
    setMinted(res);
    void refreshSetup();
  };
  const snippets = minted?.snippets ?? [];
  const forPlace =
    place === "actions" ? snippets.filter((s) => /Actions/.test(s.label)) : place === "schedule" ? snippets.filter((s) => !/Actions|cron/.test(s.label)) : snippets.filter((s) => /cron|prompt/.test(s.label));
  // Once a curator is set up, its runs come first and the setup folds away.
  const configured = curated ?? (!!status.curatorActions || hostedOn || (status.keys ?? []).some((k) => k.kind === "curator"));
  // The Actions curator, once on, stands above the fold like hosted curation: Run now and its runs stay in sight.
  const actionsAbove = !bare && github && !!status.curatorActions;
  // A curator key by hand: for an agent, or for Actions set up with `gh` (the Actions card makes its own).
  const keyBlock = minted ? (
    <div className="stack sz-tight">
      <p className="small">
        <strong>Your curator key</strong> is in the snippets below; you won't see it again.
      </p>
      <Snippets snippets={forPlace.length ? forPlace : snippets} />
    </div>
  ) : (
    <div className="row">
      <button type="button" className={`btn ${place === "actions" ? "btn--sm" : "btn--primary"}`} onClick={() => void mint()} disabled={action.busy || status.vault?.status !== "ready"}>
        <Icon name="key" /> {action.busy ? "Creating…" : "Create the curator key"}
      </button>
    </div>
  );
  const setup = (
    <div className="stack">
      <p className="small">
        Every night, a curator turns what your agents saved into notes: it settles facts, updates goals and the timeline, and empties the inbox. Pick where it runs. In Claude Code, <code>/hippocampus:sleep-setup</code> walks you through the same choices.
      </p>
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
      {place !== "hosted" && (
        <div className="callout callout--warn" role="note">
          <Icon name="lock" />
          <div>
            <strong>The curator sees secret memories.</strong> Give sleep <strong>a bot of its own</strong>: a separate agent (its own Claude Code project or scheduled task, its own Grok bot) that only curates, with its own curator key. Not the agent you chat with every day, and only with an AI provider you trust with your secrets. One curator per vault is enough.
          </div>
        </div>
      )}
      {action.error !== undefined && <ErrorCallout error={action.error} />}
      {place === "hosted" ? (
        <HostedCurator status={status} />
      ) : place === "actions" && github ? (
        actionsAbove ? (
          <p className="small muted">The GitHub Actions curator is on: its settings and runs are above.</p>
        ) : (
          <ActionsCurator status={status} manual={keyBlock} />
        )
      ) : (
        keyBlock
      )}
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
        {hostedOn && <HostedCurator status={status} />}
        {actionsAbove && <ActionsCurator status={status} manual={keyBlock} />}
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

const isPermissionError = (e: unknown) => e instanceof ApiError && e.code === "NEEDS_PERMISSION";

/**
 * The vault repo's nightly GitHub Actions workflow, set up from here: turning it on or off, the owner's
 * Claude token or API key (write-only, straight to the repo's encrypted secrets), the model, the
 * checklist, Run now and the recent runs. `manual` is the by-hand way: a curator key and `gh` commands.
 */
export function ActionsCurator({ status, manual }: { status: HostedStatus; manual?: React.ReactNode }) {
  const { v } = useTerms();
  const ready = status.vault?.status === "ready";
  const [active, setActive] = useState(false);
  const st = useResource<HostedCuratorActionsState>(ready ? "/setup/curator-actions/state" : null, { poll: active ? 60_000 : undefined });
  const s = st.data;
  const runs = s?.runs;
  // GitHub is asked again each minute only while a run is queued or going: each read costs several API calls.
  const running = !!runs?.some((r) => r.status !== "completed");
  useEffect(() => setActive(running), [running]);

  const toggleAct = useAction();
  const saveAct = useAction();
  const runAct = useAction();
  const known = (s?.enabled ?? status.curatorActions) !== undefined;
  const on = !!(s?.enabled ?? status.curatorActions);
  const repo = status.vault?.fullName ?? "<you>/vault";
  const perm = s?.needsPermission;

  const savedKind = ACTIONS_CREDENTIALS.find((c) => s?.secrets?.includes(c.secret));
  const [kind, setKind] = useState<ActionsCredential>("claudeToken");
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [tried, setTried] = useState(false);
  const savedModel = (s?.workflow?.model ?? "sonnet") as HostedActionsModel;
  const [model, setModel] = useState<HostedActionsModel>();
  const pickedModel = model ?? savedModel;
  const showField = !savedKind || replacing;
  const problem = showField && (value.trim() || tried) ? credentialProblem(kind, value) : undefined;
  const checks = actionsChecklist(s, status.curatorActions);

  const reload = () => Promise.all([st.reload(), refreshSetup()]);
  /** A refusal for permissions: the state's callout says what to do, so it's read again. */
  const refusedFor = (e: unknown): never => {
    if (isPermissionError(e)) void st.reload();
    throw e;
  };
  const toggle = async () => {
    // Turning it on writes the workflow with the model picked here.
    const res = await toggleAct.run(() => postJson<HostedCuratorActionsResult>("/setup/curator-actions", on ? { enable: false } : { enable: true, model: pickedModel }));
    if (!res) return;
    if (res.enabled) setModel(undefined);
    toast(res.enabled ? `The Actions curator is on, with ${res.model === "opus" ? "Opus" : "Sonnet"}: ${res.path}.` : "The Actions curator is off.", "ok");
    await reload();
  };
  const save = async () => {
    setTried(true);
    const sending = showField && value.trim() ? value.trim() : undefined;
    if (showField && !savedKind && !sending) return;
    if (sending && credentialProblem(kind, sending)) return;
    const body: HostedActionsSecretsRequest = { ...(sending ? { [kind]: sending } : {}), model: pickedModel };
    const res = await saveAct.run(() => postJson<HostedActionsSecretsResult>("/setup/curator-actions/secrets", body).catch(refusedFor));
    // The value leaves the page with the request: the field empties whatever the answer.
    setValue("");
    if (!res) return;
    setReplacing(false);
    setTried(false);
    // While the workflow is off the model waits here, for Turn it on.
    if (res.model) setModel(undefined);
    toast(sending ? "Saved to your repository's secrets. It won't be shown again." : "Saved.", "ok");
    await reload();
  };
  const runNow = async () => {
    const res = await runAct.run(() => postJson<HostedActionsRunResult>("/setup/curator-actions/run", {}).catch(refusedFor));
    if (!res) return;
    toast("GitHub queued the run. It shows below in a few seconds.", "ok");
    setActive(true);
    // GitHub lists a dispatched run a moment after it's queued.
    setTimeout(() => void st.reload(), 3000);
  };
  // A refusal for permissions shows as the callout above, not as an error under the button.
  const errorOf = (e: unknown) => (e === undefined || isPermissionError(e) ? undefined : e);
  const busy = toggleAct.busy || saveAct.busy || runAct.busy;

  return (
    <section className="sz-card hz-actions" aria-labelledby="hz-actions-title">
      <div className="sz-card__head">
        <Icon name="github" />
        <strong id="hz-actions-title">Or let GitHub Actions curate</strong>
        {known ? <ToneTag tone={on ? "done" : "na"} word={on ? "On" : "Off"} title={on ? "The workflow runs every night" : "Not set up"} compact /> : <ToneTag tone="optional" word="Unknown" title="Couldn't check the repository just now" compact />}
      </div>
      <p className="small">
        {v(
          "A workflow in your vault's GitHub repository runs the curator every night, so no machine of yours has to be on. It uses the repository's Actions minutes, and Claude paid for by your subscription or your API key.",
          "A workflow in the campaign's GitHub repository puts the party to sleep every night, so no machine of yours has to be on. It uses the repository's Actions minutes, and Claude paid for by your subscription or your API key.",
        )}
      </p>

      {perm && (
        <div className="callout callout--warn" role="status">
          <Icon name="lock" />
          <div className="stack sz-tight">
            {perm.who === "operator" ? (
              <span>
                <strong>This Hippocampus can't manage Actions secrets and runs yet.</strong> Its operator has to add those permissions to its GitHub App first. Until then, use <strong>Set it up by hand</strong> below.
              </span>
            ) : (
              <span>
                <strong>Hippocampus needs permission to manage Actions secrets and runs on <code>{perm.repo}</code>.</strong> Approve it on GitHub, then come back here.
              </span>
            )}
            <span className="row sz-tight-row">
              {perm.who !== "operator" && (
                <a className="btn btn--sm btn--primary" href={perm.settingsUrl} target="_blank" rel="noreferrer">
                  <Icon name="github" size={16} /> Approve it on GitHub
                </a>
              )}
              <button type="button" className="btn btn--sm" onClick={() => void st.reload()} disabled={st.loading}>
                Check again
              </button>
            </span>
          </div>
        </div>
      )}

      <ul className="hz-actions__checks" aria-label="What the workflow needs">
        {checks.map((c) => (
          <li key={c.id}>
            <ToneTag tone={c.done ? "done" : c.done === false ? "todo" : "optional"} word={c.done ? "Set" : c.done === false ? "To do" : "Unknown"} compact />
            <span className="small">
              <strong>{c.word}</strong> <span className="muted">· {c.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {showField && (
      <fieldset className="sz-fieldset" disabled={!!perm}>
        <legend className="label">Pay for Claude with</legend>
        {ACTIONS_CREDENTIALS.map((c) => (
          <label key={c.id} className="check sz-scope">
            <input type="radio" name="hz-actions-kind" checked={kind === c.id} onChange={() => setKind(c.id)} />
            <span>
              <strong>{c.word}</strong>
              <span className="small muted"> · {c.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      )}

      <div className="sz-form">
        {showField ? (
          <Field label="Your Claude token or Anthropic API key" hint="It goes straight to your repository's encrypted secrets; Hippocampus doesn't keep it. Saving one kind replaces the other." problem={problem}>
            {(f) => (
              <span className="sz-keyrow">
                <input
                  id={f.id}
                  className="input mono"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={value}
                  disabled={!!perm}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={ACTIONS_CREDENTIALS.find((c) => c.id === kind)!.placeholder}
                  aria-describedby={f.describedBy}
                  aria-invalid={!!problem}
                />
                {replacing && (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => {
                      setValue("");
                      setReplacing(false);
                    }}
                  >
                    Keep the saved one
                  </button>
                )}
              </span>
            )}
          </Field>
        ) : (
          <Field label="Your Claude token or Anthropic API key" hint="GitHub keeps it encrypted; nobody can read it back, Hippocampus included.">
            {(f) => (
              <span className="row sz-tight-row" id={f.id}>
                <span className="small">
                  <Icon name="lock" size={16} /> Saved to your repository's secrets ({savedKind!.word.toLowerCase()})
                </span>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!!perm}
                  onClick={() => {
                    setKind(savedKind!.id);
                    setReplacing(true);
                  }}
                >
                  Replace it
                </button>
              </span>
            )}
          </Field>
        )}
        <Field label="Model" hint={on ? "Sonnet curates well for less; Opus is the most careful." : "Sonnet curates well for less; Opus is the most careful. Turn it on uses this one."}>
          {(f) => (
            <select id={f.id} className="input" value={pickedModel} aria-describedby={f.describedBy} onChange={(e) => setModel(e.target.value as HostedActionsModel)}>
              <option value="sonnet">Sonnet (default)</option>
              <option value="opus">Opus</option>
            </select>
          )}
        </Field>
      </div>
      <p className="small muted">Hippocampus sets the curator key for you when you save, and a new curator key replaces the one it made before. The vault's address and the model are written into the workflow itself.</p>
      {errorOf(saveAct.error) !== undefined && <ErrorCallout error={saveAct.error} />}
      <div className="row">
        <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy || !ready || !!perm}>
          <Icon name="lock" /> {saveAct.busy ? "Saving…" : "Save to GitHub"}
        </button>
      </div>

      <Effects
        items={[
          ["writes", <>your token or key and a curator key into <code>{repo}</code>'s Actions secrets.</>],
          on
            ? ["removes", <>the workflow (<code>.github/workflows/sleep.yml</code>) from <code>{repo}</code> when you turn it off, in one commit. A new model is one commit too.</>]
            : ["writes", <>the workflow (<code>.github/workflows/sleep.yml</code>), with your vault's address and the model, into <code>{repo}</code> when you turn it on, in one commit.</>],
          ["never", "keeps your token or key: it passes through once, sealed for GitHub."],
        ]}
      />
      {errorOf(toggleAct.error) !== undefined && <ErrorCallout error={toggleAct.error} />}
      {errorOf(runAct.error) !== undefined && <ErrorCallout error={runAct.error} />}
      <div className="row">
        <button type="button" className={`btn ${on ? "" : "btn--primary"}`} onClick={() => void toggle()} disabled={busy || !ready}>
          <Icon name={on ? "close" : "moonStars"} /> {toggleAct.busy ? "Working…" : on ? "Turn it off" : "Turn it on"}
        </button>
        <button type="button" className="btn" onClick={() => void runNow()} disabled={busy || !ready || !on || !!perm} title={on ? undefined : "Turn the workflow on first"}>
          <Icon name="hourglass" /> {runAct.busy ? "Starting…" : "Run now"}
        </button>
      </div>

      {on && runs !== undefined && (
        <div className="stack sz-tight">
          <span className="label">Recent runs</span>
          {runs.length ? (
            <ul className="hz-actions__runs">
              {runs.map((r) => {
                const t = actionsRunTone(r);
                return (
                  <li key={r.id}>
                    <ToneTag tone={t.tone} word={t.word} title={t.help} compact />
                    <span className="small muted">
                      <RelTime at={r.created} /> · {runEvent(r.event)}
                    </span>
                    <a className="small" href={r.url} target="_blank" rel="noreferrer">
                      View on GitHub
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="small muted">No runs yet: the first is tonight at 03:23 UTC, or press Run now.</p>
          )}
        </div>
      )}
      {st.error !== undefined && !s && <p className="small muted">Couldn't read the repository's Actions settings just now.</p>}

      <details className="sz-details">
        <summary>Set it up by hand</summary>
        <div className="stack sz-tight">
          <p className="small">If you'd rather set the secrets yourself, with the GitHub CLI or on GitHub. Keys and tokens go in as secrets, never variables: variables are plain text anyone with access to the repository can read.</p>
          {manual}
          <Snippets snippets={actionsSnippets(repo)} />
        </div>
      </details>
    </section>
  );
}
