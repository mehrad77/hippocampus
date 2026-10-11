import { useEffect, useMemo, useState } from "react";
import { postJson } from "../../lib/api.ts";
import { useResource } from "../../lib/cache.ts";
import { useTerms } from "../../lib/prefs.ts";
import type { Overview } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Panel } from "../../ui/Parts.tsx";
import { ErrorCallout, Facts, Field, ToneTag, useAction } from "./common.tsx";
import { identityFileName, identityFileText } from "./hosted.ts";
import { truncateKey } from "./model.ts";

/**
 * The secrets key on an existing vault: make one in this browser (only the public half goes to the vault) or paste
 * a public key you already have. Without a key, agents' secret facts are held back instead of stored.
 */
export function SecretsPanel({ vaultName }: { vaultName: string }) {
  const { v } = useTerms();
  const overview = useResource<Overview>("/overview");
  const action = useAction();
  const [identity, setIdentity] = useState<string>();
  const [recipient, setRecipient] = useState<string>();
  const [pasted, setPasted] = useState("");
  const [saved, setSaved] = useState(false);
  const [done, setDone] = useState(false);
  const [makeError, setMakeError] = useState<unknown>();

  const file = identityFileName(vaultName);
  const url = useMemo(() => (identity ? URL.createObjectURL(new Blob([identityFileText(identity)], { type: "application/octet-stream" })) : undefined), [identity]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);

  // Unknown (an older server, or still loading): say nothing rather than nag.
  const has = overview.data?.secretsKey;
  if (has === undefined) return null;

  const make = async () => {
    setMakeError(undefined);
    try {
      const age = await import("age-encryption");
      const id = await age.generateX25519Identity();
      setIdentity(id);
      setRecipient(await age.identityToRecipient(id));
      setSaved(false);
    } catch (err) {
      setMakeError(err);
    }
  };

  const save = async (key: string) => {
    const res = await action.run(() => postJson<{ changed: boolean }>("/actions/secrets", { recipient: key }));
    if (!res) return;
    setDone(true);
    await overview.reload();
  };

  const ok = has || done;
  // A made key must be saved by the person before the vault locks to it; a pasted public key has no file to save.
  const ready = identity ? saved : false;

  return (
    <Panel title="Secrets key" icon="key" id="secrets">
      <div className="stack">
        <Facts rows={[["State", ok ? <ToneTag tone="done" word="Set" compact /> : <ToneTag tone="warn" word="Not set" compact />]]} />
        {ok ? (
          <p className="small">
            {v("Secret facts (passport numbers, account ids, passwords) are encrypted to this vault's key before they're stored.", "Secret facts are sealed to this vault's key before they're stored.")} To change the key, replace it from a clone with <code>hippo secrets keygen</code>.
          </p>
        ) : (
          <>
            <p className="small">
              Without a key, agents can't store secret facts: Hippocampus holds them back. A <strong>secrets key</strong> is a pair: the public half (<code>age1…</code>) goes into your vault and locks secrets; the private half stays with you and unlocks them.
            </p>
            {!recipient ? (
              <div className="stack sz-tight">
                <div className="row">
                  <button type="button" className="btn btn--primary" onClick={() => void make()}>
                    <Icon name="key" /> {v("Make a key in this browser", "Forge a key in this browser")}
                  </button>
                </div>
                <details className="sz-more small">
                  <summary>I already have a public key</summary>
                  <Field label="Public key (starts with age1)">
                    {(f) => <input id={f.id} className="input mono" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="age1…" autoComplete="off" spellCheck={false} aria-describedby={f.describedBy} />}
                  </Field>
                  <div className="row">
                    <button type="button" className="btn" disabled={action.busy || !pasted.trim()} onClick={() => void save(pasted.trim())}>
                      Use this key
                    </button>
                  </div>
                </details>
              </div>
            ) : (
              <div className="stack sz-tight">
                <Facts
                  rows={[
                    ["Public key", <span className="mono" title={recipient}>{truncateKey(recipient)}</span>],
                    ["Key file", <span className="mono sz-break">{file}</span>],
                  ]}
                />
                {url && (
                  <div className="row">
                    <a className="btn btn--primary" href={url} download={file}>
                      <Icon name="copy" /> Download the key file
                    </a>
                    <span className="hint">Keep it somewhere safe, like a password manager. Nobody can read your secrets without it, not even you.</span>
                  </div>
                )}
                <label className="check">
                  <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I saved the key file somewhere safe
                </label>
                <div className="row">
                  <button type="button" className="btn btn--primary" disabled={action.busy || !ready} onClick={() => void save(recipient)}>
                    Lock this vault's secrets to this key
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setIdentity(undefined);
                      setRecipient(undefined);
                    }}
                  >
                    Start over
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {makeError !== undefined && <ErrorCallout error={makeError} />}
        {action.error !== undefined && <ErrorCallout error={action.error} />}
      </div>
    </Panel>
  );
}
