import { useEffect, useMemo, useState } from "react";
import { getJson, postJson } from "../../lib/api.ts";
import { decryptArmored, encryptArmored, recipientOf } from "../../lib/secrets.ts";
import type { SecretFile } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { KeyFilePicker } from "../../ui/KeyFilePicker.tsx";
import { Dialog } from "../../ui/Parts.tsx";
import { ErrorCallout, Facts } from "./common.tsx";
import { identityFileName, identityFileText } from "./hosted.ts";
import { truncateKey } from "./model.ts";

type Step = "warn" | "new" | "old" | "moving" | "done";

/**
 * Rotate a compromised key: make a new key, then pick the old key file; this browser opens every secret with the old
 * key and locks it to the new one, and the vault swaps them all in at once. The server sees ciphertext only; the keys
 * and the opened values live in this dialog's memory for as long as the move takes.
 */
export function RotateKey({ vaultName, onDone }: { vaultName: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("warn");
  const [fresh, setFresh] = useState<{ identity: string; recipient: string }>();
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [moved, setMoved] = useState(0);

  const file = identityFileName(vaultName).replace(/\.agekey$/, `-${new Date().toISOString().slice(0, 10)}.agekey`);
  const url = useMemo(() => (fresh ? URL.createObjectURL(new Blob([identityFileText(fresh.identity)], { type: "application/octet-stream" })) : undefined), [fresh]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);

  const close = () => {
    setOpen(false);
    setStep("warn");
    setFresh(undefined);
    setSaved(false);
    setProblem(undefined);
    setError(undefined);
    if (step === "done") onDone();
  };

  const make = async () => {
    const age = await import("age-encryption");
    const identity = await age.generateX25519Identity();
    setFresh({ identity, recipient: await age.identityToRecipient(identity) });
    setSaved(false);
  };

  const move = async (oldIdentity: string) => {
    if (!fresh) return;
    setProblem(undefined);
    setError(undefined);
    setStep("moving");
    try {
      const { recipient, files } = await getJson<{ recipient?: string; files: SecretFile[] }>("/secrets");
      if (recipient && (await recipientOf(oldIdentity)) !== recipient) {
        setStep("old");
        return setProblem("That isn't the vault's current key. Pick the key file the vault's secrets are locked to now.");
      }
      const opened = await Promise.allSettled(files.map(async (f) => ({ path: f.path, armored: await encryptArmored(fresh.recipient, await decryptArmored(oldIdentity, f.armored)) })));
      const failed = opened.filter((r) => r.status === "rejected").length;
      if (failed) {
        setStep("old");
        return setProblem(`${failed} of ${files.length} secrets don't open with this key (they were locked to an earlier one), so nothing was changed. Rotating would leave them behind; use "Replace the key" instead if you can't open them.`);
      }
      const moving = opened.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const res = await postJson<{ rotated: number }>("/actions/rotate-secrets", { recipient: fresh.recipient, files: moving });
      setMoved(res.rotated);
      setFresh(undefined);
      setStep("done");
    } catch (err) {
      setError(err);
      setStep("old");
    }
  };

  return (
    <>
      <button type="button" className="btn btn--sm" onClick={() => setOpen(true)}>
        <Icon name="refresh" /> Key compromised? Rotate…
      </button>
      <Dialog open={open} onClose={close} title="Rotate the secrets key" wide>
        {step === "warn" && (
          <div className="stack">
            <p>For a key file that leaked, or that someone else may have. You need the old key file: this browser opens every secret with it and locks it to a new key, and the vault keeps only the new copies.</p>
            <ul className="sz-howto">
              <li>Afterwards the old key opens nothing in the vault as it is now, and new secrets lock to the new key.</li>
              <li>
                <strong>It can't take back what already leaked.</strong> Old copies stay in the repository's git history, and the old key still opens those. Change the real secrets where you can (passwords, card numbers), and treat the old values as known.
              </li>
              <li>The keys and the opened values stay in this browser. The server only ever gets the new locked copies.</li>
            </ul>
            <div className="row">
              <button type="button" className="btn btn--primary" onClick={() => setStep("new")}>
                Continue
              </button>
            </div>
          </div>
        )}
        {step === "new" && (
          <div className="stack">
            <p className="small">First, the new key. Save its file before going on: it's the only way to read your secrets after this.</p>
            {!fresh ? (
              <div className="row">
                <button type="button" className="btn btn--primary" onClick={() => void make().catch(setError)}>
                  <Icon name="key" /> Make the new key in this browser
                </button>
              </div>
            ) : (
              <>
                <Facts
                  rows={[
                    ["New public key", <span className="mono" title={fresh.recipient}>{truncateKey(fresh.recipient)}</span>],
                    ["Key file", <span className="mono sz-break">{file}</span>],
                  ]}
                />
                {url && (
                  <div className="row">
                    <a className="btn btn--primary" href={url} download={file}>
                      <Icon name="copy" /> Download the new key file
                    </a>
                  </div>
                )}
                <label className="check">
                  <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I saved the new key file somewhere safe
                </label>
                <div className="row">
                  <button type="button" className="btn btn--primary" disabled={!saved} onClick={() => setStep("old")}>
                    Next: the old key
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {step === "old" && (
          <div className="stack">
            <p className="small">Now pick the old key file, the one being replaced. Every secret is opened with it and locked to the new key, here in this browser.</p>
            <KeyFilePicker label="Pick the old key file" onKey={(id) => void move(id)} />
            {problem && (
              <p className="sz-problem" role="status">
                {problem}
              </p>
            )}
          </div>
        )}
        {step === "moving" && <p className="small muted">Moving the secrets to the new key…</p>}
        {step === "done" && (
          <div className="stack">
            <p>
              <Icon name="check" /> Moved {moved} secret{moved === 1 ? "" : "s"} to the new key. The old key is revoked: it opens nothing in the vault now, and new secrets lock to the new key.
            </p>
            <p className="small">Delete the old key file once you're sure the new one is saved, and change any real secret the old key could have exposed.</p>
            <div className="row">
              <button type="button" className="btn btn--primary" onClick={close}>
                Done
              </button>
            </div>
          </div>
        )}
        {error !== undefined && <ErrorCallout error={error} />}
      </Dialog>
    </>
  );
}
