import { useEffect, useMemo, useState } from "react";
import { postJson } from "../../lib/api.ts";
import { useResource } from "../../lib/cache.ts";
import { useTerms } from "../../lib/prefs.ts";
import type { Overview } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Panel } from "../../ui/Parts.tsx";
import { ConfirmDialog, ErrorCallout, Facts, Field, ToneTag, useAction } from "./common.tsx";
import { identityFileName, identityFileText } from "./hosted.ts";
import { truncateKey } from "./model.ts";

// What the server accepts as a public key (core's AGE_RECIPIENT). Checked here too, so a pasted private key is never sent.
const PUBLIC_KEY = /^age1[02-9ac-hj-np-z]{58}$/;

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
  // Replacing a key already set: the warning first, then the same make-or-paste flow as for a first key.
  const [asking, setAsking] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [makeError, setMakeError] = useState<unknown>();

  // A replacement must not download over the old key file, which still opens the secrets saved before it.
  const file = replacing ? identityFileName(vaultName).replace(/\.agekey$/, `-${new Date().toISOString().slice(0, 10)}.agekey`) : identityFileName(vaultName);
  const pastedProblem = !pasted.trim() ? undefined : /AGE-SECRET-KEY/i.test(pasted) ? "That is a private key. Never paste it anywhere: nothing was sent. Paste the public key (age1…) instead." : !PUBLIC_KEY.test(pasted.trim()) ? "A public key starts with age1 and is 62 characters long." : undefined;
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
    const res = await action.run(() => postJson<{ changed: boolean }>("/actions/secrets", { recipient: key, ...(replacing ? { replace: true } : {}) }));
    if (!res) return;
    setDone(true);
    setReplacing(false);
    setIdentity(undefined);
    setRecipient(undefined);
    setPasted("");
    await overview.reload();
  };

  const ok = (has || done) && !replacing;
  // A made key must be saved by the person before the vault locks to it; a pasted public key has no file to save.
  const ready = identity ? saved : false;

  return (
    <Panel title="Secrets key" icon="key" id="secrets">
      <div className="stack">
        <Facts rows={[["State", ok ? <ToneTag tone="done" word="Set" compact /> : <ToneTag tone="warn" word={replacing ? "Replacing" : "Not set"} compact />]]} />
        {ok ? (
          <>
            <p className="small">
              {v("Secret facts (passport numbers, account ids, passwords) are encrypted to this vault's key before they're stored.", "Secret facts are sealed to this vault's key before they're stored.")} Lost the key file? Nobody can recover it, but you can replace the key and have your agents send the secrets again.
            </p>
            <div className="row">
              <button type="button" className="btn btn--sm" onClick={() => setAsking(true)}>
                <Icon name="key" /> Replace the key…
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="small">
              Without a key, agents can't store secret facts: Hippocampus holds them back. A <strong>secrets key</strong> is a pair: the public half (<code>age1…</code>) goes into your vault and locks secrets; the private half stays with you and unlocks them.
            </p>
            {!recipient ? (
              <div className="stack sz-tight">
                {replacing && (
                  <div className="row">
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setReplacing(false)}>
                      Cancel, keep the current key
                    </button>
                  </div>
                )}
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
                  {pastedProblem && <p className="sz-problem" role="status">{pastedProblem}</p>}
                  <div className="row">
                    <button type="button" className="btn" disabled={action.busy || !pasted.trim() || !!pastedProblem} onClick={() => void save(pasted.trim())}>
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
        {replacing && <p className="small sz-warn-text">Replacing the key: secrets saved so far stay locked to the old key.</p>}
        {makeError !== undefined && <ErrorCallout error={makeError} />}
        {action.error !== undefined && <ErrorCallout error={action.error} />}
      </div>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title="Replace the secrets key?"
        confirmLabel="Replace the key"
        danger
        onConfirm={async () => {
          setAsking(false);
          setReplacing(true);
        }}
      >
        <p>This is for a key file you lost, or one that leaked. The new key can't open anything the old one locked.</p>
        <ul className="sz-howto">
          <li>Secrets already saved (passport, ID and account numbers) stay locked to the old key. With the old key file you can still read them; without it, they're gone.</li>
          <li>Secrets saved from now on are locked to the new key.</li>
          <li>Ask your agents to send the old secrets again. A new one replaces the unreadable one.</li>
        </ul>
      </ConfirmDialog>
    </Panel>
  );
}
