import { useState } from "react";
import { postJson } from "../../lib/api.ts";
import { useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { useTerms, type Voice } from "../../lib/prefs.ts";
import type { HostedCuratorActionsResult, HostedKeyInfo, HostedKeyRequest, HostedMintedKey, HostedStatus } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Dialog, Empty, Panel, RelTime, SkeletonPanel } from "../../ui/Parts.tsx";
import { ConfirmDialog, Effects, ErrorCallout, Field, refreshSetup, Snippets, ToneTag, useAction } from "./common.tsx";
import { actionsSnippets, agentPluginSnippets, curatorRecipes, KEY_KIND } from "./hosted.ts";
import { agentIdProblem, shortId, TOKEN_SCOPES } from "./model.ts";
import { SecretReveal, type Reveal } from "./SecretReveal.tsx";

/** A minted key, for the reveal dialog. */
export function mintedReveal(k: HostedMintedKey, v: Voice["v"], after?: React.ReactNode): Reveal {
  const kind = KEY_KIND[k.kind];
  return {
    title: `${v(...kind.word)}: ${k.label}`,
    noun: "key",
    secret: k.token,
    facts: [
      ["Kind", v(...kind.word)],
      ...(k.agent ? ([["Agent", <span className="mono">{k.agent}</span>]] as [string, React.ReactNode][]) : []),
      ["Scopes", k.scopes.join(", ")],
    ],
    snippets: k.snippets,
    after,
  };
}

/** The vault's keys: list, mint (shown once) and revoke. Only hashes are kept, so a key can't be shown twice. */
export function HostedKeysPanel({ status }: { status: HostedStatus }) {
  const { v } = useTerms();
  const keys = useResource<{ keys: HostedKeyInfo[] }>("/setup/keys");
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<HostedMintedKey>();
  const [revoking, setRevoking] = useState<HostedKeyInfo>();
  const revoke = useAction();

  return (
    <Panel
      title="Keys"
      icon="key"
      id="sz-keys"
      aside={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setMinting(true)}>
          <Icon name="plus" size={16} /> {v("Create a key", "Mint a key")}
        </button>
      }
    >
      <p className="small">
        Agents reach your vault at <span className="mono sz-break">{status.mcpUrl}</span> with a key. Only a hash of each key is kept, so it's shown once, when it's {v("created", "minted")}. Revoking one cuts off whoever holds it at once.
      </p>
      {keys.error && !keys.data ? (
        <ErrorCallout error={keys.error} onRetry={() => void keys.reload()} />
      ) : !keys.data ? (
        <SkeletonPanel lines={3} />
      ) : keys.data.keys.length ? (
        <div className="table-wrap">
          <table className="table hz-rtable">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Scopes</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.data.keys.map((k) => (
                <tr key={k.id}>
                  <td data-label="Key">
                    <strong>{k.label}</strong>
                    <span className="small muted" title={v(...KEY_KIND[k.kind].help)}>
                      {" "}
                      {v(...KEY_KIND[k.kind].word)}
                      {k.agent ? <> · <span className="mono">{k.agent}</span></> : null}
                    </span>
                  </td>
                  <td data-label="Scopes">
                    <span className="row sz-tight-row">
                      {k.scopes.map((s) => (
                        <span key={s} className="chip">
                          {s}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td data-label="Created">
                    <RelTime at={k.created} />
                  </td>
                  <td data-label="Last used">{k.lastUsed ? <RelTime at={k.lastUsed} /> : <span className="muted">never</span>}</td>
                  <td className="sz-tokens__act">
                    <button type="button" className="btn btn--sm btn--danger" onClick={() => setRevoking(k)} aria-label={`Revoke the key ${k.label} (${shortId(k.id)})`}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="key" title="No keys yet">
          {v("Create an agent key for your agents, and a curator key for the agent that curates.", "Mint a party key for your agents, and a curator's key for the one who curates.")}
        </Empty>
      )}

      <MintKeyDialog
        open={minting}
        onClose={() => setMinting(false)}
        onMinted={(k) => {
          setMinting(false);
          setMinted(k);
          void keys.reload();
          void refreshSetup();
        }}
      />
      <SecretReveal
        reveal={minted && mintedReveal(minted, v, minted.kind === "curator" ? <p className="small">How to run the curator with it: <a href="#curator">the curator step</a>.</p> : <Snippets snippets={agentPluginSnippets(status.mcpUrl)} />)}
        onClose={() => setMinted(undefined)}
      />
      <ConfirmDialog
        open={!!revoking}
        onClose={() => {
          setRevoking(undefined);
          revoke.clear();
        }}
        title="Revoke this key?"
        confirmLabel="Revoke it"
        danger
        busy={revoke.busy}
        onConfirm={async () => {
          if (!revoking) return;
          const res = await revoke.run(() => postJson<{ ok: boolean }>("/setup/keys/revoke", { id: revoking.id }));
          if (!res) return;
          toast(`Revoked ${revoking.label}.`, "ok");
          setRevoking(undefined);
          void keys.reload();
          void refreshSetup();
        }}
      >
        {revoking && (
          <p>
            Whoever holds <strong>{revoking.label}</strong> ({v(...KEY_KIND[revoking.kind].word).toLowerCase()}, <span className="mono">{shortId(revoking.id)}</span>) loses access to your vault immediately. This can't be undone: {v("create", "mint")} a new key if they should come back.
          </p>
        )}
        {revoke.error !== undefined && <ErrorCallout error={revoke.error} />}
      </ConfirmDialog>
    </Panel>
  );
}

function MintKeyDialog({ open, onClose, onMinted }: { open: boolean; onClose: () => void; onMinted: (k: HostedMintedKey) => void }) {
  const { v } = useTerms();
  const [kind, setKind] = useState<HostedKeyInfo["kind"]>("agent");
  const [label, setLabel] = useState("");
  const [agent, setAgent] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read", "remember"]);
  const [tried, setTried] = useState(false);
  const action = useAction();
  const problem = kind === "bound" ? agentIdProblem(agent) : undefined;

  const close = () => {
    setTried(false);
    action.clear();
    onClose();
  };
  const submit = async () => {
    setTried(true);
    if (problem) return;
    const req: HostedKeyRequest = { kind, ...(label.trim() ? { label: label.trim() } : {}) };
    if (kind === "bound") Object.assign(req, { agent: agent.trim(), scopes: TOKEN_SCOPES.map((s) => s.id).filter((s) => s === "read" || scopes.includes(s)) });
    const res = await action.run(() => postJson<HostedMintedKey>("/setup/keys", req));
    if (!res) return;
    setTried(false);
    setLabel("");
    setAgent("");
    onMinted(res);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={
        <span className="row">
          <Icon name="key" /> {v("Create a key", "Mint a key")}
        </span>
      }
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={action.busy}>
            <Icon name="key" /> {action.busy ? v("Creating…", "Minting…") : v("Create it", "Mint it")}
          </button>
        </>
      }
    >
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="sz-fieldset">
          <legend className="label">Kind</legend>
          {(["agent", "curator", "bound"] as const).map((k) => (
            <label key={k} className="check sz-scope">
              <input type="radio" name="hz-kind" checked={kind === k} onChange={() => setKind(k)} />
              <span>
                <strong>{v(...KEY_KIND[k].word)}</strong>
                <span className="small muted"> · {v(...KEY_KIND[k].help)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field label="Label (optional)" hint="So you can tell keys apart, e.g. “Laptop” or “Cursor at work”.">
          {(f) => <input id={f.id} className="input" value={label} onChange={(e) => setLabel(e.target.value)} aria-describedby={f.describedBy} maxLength={80} autoComplete="off" />}
        </Field>
        {kind === "bound" && (
          <>
            <Field label="Agent id" hint="Lowercase letters, digits and dashes." problem={tried || agent ? problem : undefined}>
              {(f) => <input id={f.id} className="input mono" value={agent} onChange={(e) => setAgent(e.target.value.toLowerCase())} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder="job-scout" autoComplete="off" spellCheck={false} />}
            </Field>
            <fieldset className="sz-fieldset">
              <legend className="label">Scopes</legend>
              {TOKEN_SCOPES.map((s) => {
                const required = s.id === "read";
                return (
                  <label key={s.id} className="check sz-scope">
                    <input type="checkbox" checked={required || scopes.includes(s.id)} disabled={required} onChange={(e) => setScopes((xs) => (e.target.checked ? [...xs, s.id] : xs.filter((x) => x !== s.id)))} />
                    <span>
                      <strong>{v(...s.label)}</strong>
                      {required && <span className="small muted"> (required)</span>}
                      <span className="small muted"> · {v(...s.help)}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          </>
        )}
        {kind === "curator" && (
          <p className="small sz-warn-text">
            <Icon name="lock" size={14} /> The curator sees secret memories in full while it curates. Give this key only to an agent you trust with them.
          </p>
        )}
        {action.error !== undefined && <ErrorCallout error={action.error} />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** How to run the curator: by hand, on a schedule, or in the vault repo's GitHub Actions. */
export function CuratorRecipes({ status }: { status: HostedStatus }) {
  const r = curatorRecipes(status.mcpUrl);
  return (
    <div className="stack">
      <h3 className="sz-subhead">Run it from Claude Code</h3>
      <Snippets snippets={r.now} />
      <h3 className="sz-subhead">On a schedule</h3>
      <p className="small">Once a day is enough for most vaults; every hour suits agents that write a lot. A run only takes what's in the inbox.</p>
      <Snippets snippets={r.schedule} />
      <ActionsCurator status={status} />
    </div>
  );
}

function ActionsCurator({ status }: { status: HostedStatus }) {
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
