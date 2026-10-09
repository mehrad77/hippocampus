import { useEffect, useRef, useState } from "react";
import { postJson } from "../../lib/api.ts";
import { useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { useTerms } from "../../lib/prefs.ts";
import type { AgentConnect, MintedToken, TokenInfo } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { CopyButton, Dialog, Empty, Panel, RelTime, SkeletonPanel } from "../../ui/Parts.tsx";
import { ConfirmDialog, ErrorCallout, Facts, Field, Snippets, useAction } from "./common.tsx";
import { agentIdProblem, describeError, shortId, TOKEN_SCOPES } from "./model.ts";

const OTHER = "__other__";

/** Agent tokens on the Worker: list, mint (shown once), revoke. Only hashes are stored, so a token can't be shown twice. */
export function TokensPanel({ agents }: { agents: readonly AgentConnect[] }) {
  const { v } = useTerms();
  const tokens = useResource<{ tokens: TokenInfo[] }>("/setup/tokens");
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<MintedToken>();
  const [revoking, setRevoking] = useState<TokenInfo>();
  const revoke = useAction();
  const title = (agent: string) => agents.find((a) => a.agent === agent)?.title;
  const unsupported = tokens.error && describeError(tokens.error).unsupported;

  return (
    <Panel
      title="Agent tokens"
      icon="key"
      id="sz-tokens"
      aside={
        !unsupported && (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setMinting(true)}>
            <Icon name="plus" size={16} /> {v("Create a token", "Mint a token")}
          </button>
        )
      }
    >
      <p className="small">
        Each agent that reaches the Worker over MCP carries its own bearer token, with the scopes you choose. The Worker keeps only a hash of it, so a token is shown once, when it's {v("created", "minted")}. Revoking cuts that agent off at once.
      </p>
      {tokens.error && !tokens.data ? (
        <ErrorCallout error={tokens.error} onRetry={unsupported ? undefined : () => void tokens.reload()} />
      ) : !tokens.data ? (
        <SkeletonPanel lines={3} />
      ) : tokens.data.tokens.length ? (
        <div className="table-wrap">
          <table className="table sz-tokens">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Scopes</th>
                <th scope="col">Created</th>
                <th scope="col">Id</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.data.tokens.map((t) => (
                <tr key={t.id}>
                  <td data-label="Agent">
                    <strong>{title(t.agent) ?? t.agent}</strong>
                    {title(t.agent) && <span className="mono small muted"> {t.agent}</span>}
                  </td>
                  <td data-label="Scopes">
                    <span className="row sz-tight-row">
                      {t.scopes.map((s) => (
                        <span key={s} className="chip">
                          {s}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td data-label="Created">{t.created ? <RelTime at={t.created} /> : <span className="muted">unknown</span>}</td>
                  <td data-label="Id">
                    <span className="mono small" title="The first characters of the token's SHA-256 hash">
                      {shortId(t.id)}
                    </span>
                  </td>
                  <td className="sz-tokens__act">
                    <button type="button" className="btn btn--sm btn--danger" onClick={() => setRevoking(t)} aria-label={`Revoke ${t.agent}'s token ${shortId(t.id)}`}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="key" title="No tokens yet">
          {v("Create one for each agent that should reach the Worker.", "Mint one for each agent that should reach the Worker.")}
        </Empty>
      )}

      <MintDialog
        open={minting}
        agents={agents}
        onClose={() => setMinting(false)}
        onMinted={(t) => {
          setMinting(false);
          setMinted(t);
          void tokens.reload();
        }}
      />
      <TokenReveal token={minted} onClose={() => setMinted(undefined)} />
      <ConfirmDialog
        open={!!revoking}
        onClose={() => {
          setRevoking(undefined);
          revoke.clear();
        }}
        title="Revoke this token?"
        confirmLabel="Revoke it"
        danger
        busy={revoke.busy}
        onConfirm={async () => {
          if (!revoking) return;
          const res = await revoke.run(() => postJson<{ ok: boolean }>("/setup/tokens/revoke", { id: revoking.id }));
          if (!res) return;
          toast(`Revoked ${revoking.agent}'s token.`, "ok");
          setRevoking(undefined);
          void tokens.reload();
        }}
      >
        {revoking && (
          <p>
            <strong>{title(revoking.agent) ?? revoking.agent}</strong> (token <span className="mono">{shortId(revoking.id)}</span>, {revoking.scopes.join(", ")}) loses access to the Worker immediately. This can't be undone: {v("create", "mint")} a new token if the agent should come back.
          </p>
        )}
        {revoke.error !== undefined && <ErrorCallout error={revoke.error} />}
      </ConfirmDialog>
    </Panel>
  );
}

function MintDialog({ open, agents, onClose, onMinted }: { open: boolean; agents: readonly AgentConnect[]; onClose: () => void; onMinted: (t: MintedToken) => void }) {
  const { v } = useTerms();
  const [choice, setChoice] = useState(agents[0]?.agent ?? OTHER);
  const [other, setOther] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read", "remember"]);
  const [tried, setTried] = useState(false);
  const action = useAction();
  const agent = choice === OTHER ? other.trim() : choice;
  const problem = choice === OTHER ? agentIdProblem(other) : undefined;
  const inParty = agents.some((a) => a.agent === agent);

  const close = () => {
    setTried(false);
    action.clear();
    onClose();
  };
  const submit = async () => {
    setTried(true);
    if (problem || !agent) return;
    const ordered = TOKEN_SCOPES.map((s) => s.id).filter((s) => s === "read" || scopes.includes(s));
    const res = await action.run(() => postJson<MintedToken>("/setup/tokens", { agent, scopes: ordered }));
    if (!res) return;
    setTried(false);
    setOther("");
    onMinted(res);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={
        <span className="row">
          <Icon name="key" /> {v("Create a token", "Mint a token")}
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
        <Field label="Agent" hint={v("Notes sent with this token are filed under this id.", "The token files memories under this id.")}>
          {(f) => (
            <select id={f.id} className="select" value={choice} onChange={(e) => setChoice(e.target.value)} aria-describedby={f.describedBy}>
              {agents.map((a) => (
                <option key={a.agent} value={a.agent}>
                  {a.title} ({a.agent})
                </option>
              ))}
              <option value={OTHER}>Another id…</option>
            </select>
          )}
        </Field>
        {choice === OTHER && (
          <Field label="Agent id" hint="Lowercase letters, digits and dashes." problem={tried || other ? problem : undefined}>
            {(f) => <input id={f.id} className="input mono" value={other} onChange={(e) => setOther(e.target.value.toLowerCase())} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder="job-scout" autoComplete="off" spellCheck={false} autoFocus />}
          </Field>
        )}
        {agent && !problem && !inParty && (
          <p className="small sz-warn-text">
            {v(`“${agent}” isn't set up as an agent yet, so what it reports stays unverified until you add it.`, `“${agent}” has no party note yet, so its memories count as rumor until you add one.`)}
          </p>
        )}
        <fieldset className="sz-fieldset">
          <legend className="label">Scopes</legend>
          {TOKEN_SCOPES.map((s) => {
            const required = s.id === "read";
            return (
              <label key={s.id} className="check sz-scope">
                <input
                  type="checkbox"
                  checked={required || scopes.includes(s.id)}
                  disabled={required}
                  onChange={(e) => setScopes((xs) => (e.target.checked ? [...xs, s.id] : xs.filter((x) => x !== s.id)))}
                />
                <span>
                  <strong>{v(...s.label)}</strong>
                  {required && <span className="small muted"> (required)</span>}
                  <span className="small muted"> · {v(...s.help)}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        {action.error !== undefined && <ErrorCallout error={action.error} />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/**
 * The freshly minted token, shown exactly once. Unlike the shared Dialog, a stray backdrop click or
 * Escape doesn't close it: losing the token means minting another, so only the explicit button does.
 */
function TokenReveal({ token, onClose }: { token?: MintedToken; onClose: () => void }) {
  const { v } = useTerms();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (token && !d.open) d.showModal();
    if (!token && d.open) d.close();
  }, [token]);
  return (
    <dialog ref={ref} className="dialog dialog--wide" aria-labelledby="sz-token-title" onCancel={(e) => e.preventDefault()} onClose={() => token && onClose()}>
      <div className="dialog__head">
        <h2 id="sz-token-title">
          <span className="row">
            <Icon name="key" /> {token ? `A token for ${token.agent}` : "Token"}
          </span>
        </h2>
      </div>
      <div className="dialog__body">
        {token && (
          <div className="stack">
            <div className="callout callout--warn" role="note">
              <Icon name="lock" />
              <div>
                <strong>You won't see this token again.</strong> Copy it into the agent's settings now. The Worker keeps only its hash; if it's lost, revoke it and {v("create", "mint")} another.
              </div>
            </div>
            <Facts
              rows={[
                ["Agent", <span className="mono">{token.agent}</span>],
                ["Scopes", token.scopes.join(", ")],
              ]}
            />
            <div className="sz-token">
              <pre className="sz-token__value" tabIndex={0} aria-label="The new token">
                <code>{token.token}</code>
              </pre>
              <CopyButton text={token.token} label="Copy the token" />
            </div>
            {token.snippets.length > 0 && (
              <>
                <h3 className="sz-subhead">Connect with it</h3>
                <Snippets snippets={token.snippets} />
              </>
            )}
          </div>
        )}
      </div>
      <div className="dialog__foot">
        <button type="button" className="btn btn--primary" onClick={onClose}>
          <Icon name="check" /> I've copied it, close
        </button>
      </div>
    </dialog>
  );
}
