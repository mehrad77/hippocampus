import { useEffect, useState } from "react";
import { getJson } from "../lib/api.ts";
import { decryptArmored, recipientOf } from "../lib/secrets.ts";
import type { SecretFile } from "../lib/types.ts";
import { Icon } from "./Icon.tsx";
import { KeyFilePicker } from "./KeyFilePicker.tsx";
import { CopyButton, Dialog } from "./Parts.tsx";

/** How long a revealed value stays on screen. */
const SHOW_MS = 30_000;

/**
 * Reveal one secret fact: the owner picks their key file, the browser fetches the fact's ciphertext and opens it
 * locally. The key and the value live in this dialog only and are dropped when it closes or the timer runs out.
 */
export function RevealSecret({ entity, field, label }: { entity: string; field: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setValue(undefined);
    setProblem(undefined);
  };
  useEffect(() => {
    if (value === undefined) return;
    const t = window.setTimeout(close, SHOW_MS);
    return () => window.clearTimeout(t);
  }, [value]);

  const reveal = async (identity: string) => {
    setBusy(true);
    setProblem(undefined);
    try {
      // Straight from the API, never through the page cache: ciphertext isn't kept in sessionStorage.
      const { recipient, files } = await getJson<{ recipient?: string; files: SecretFile[] }>("/secrets");
      const file = files.find((f) => f.entity === entity && f.field === field && !f.proposal);
      if (!file) return setProblem("This fact's locked file isn't in the vault, so there's nothing to open.");
      try {
        setValue(await decryptArmored(identity, file.armored));
      } catch {
        const current = recipient && (await recipientOf(identity)) === recipient;
        setProblem(current ? "This key is the vault's, but it can't open this secret: it was locked to an earlier key." : "This key file doesn't open it. It isn't the vault's current key: pick the key file that goes with it.");
      }
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(true)} title="Open it in this browser with your key file">
        <Icon name="key" size={14} /> Reveal
      </button>
      <Dialog open={open} onClose={close} title={`Reveal: ${label}`}>
        {value === undefined ? (
          <div className="stack">
            <p className="small">Pick your secrets key file. This browser opens the value itself; the key never leaves this device, and the value is hidden again after 30 seconds.</p>
            {busy ? <p className="small muted">Opening…</p> : <KeyFilePicker onKey={(id) => void reveal(id)} />}
            {problem && (
              <p className="sz-problem" role="status">
                {problem}
              </p>
            )}
          </div>
        ) : (
          <div className="stack">
            <p className="mono" style={{ fontSize: "1.1rem", wordBreak: "break-all" }}>
              {value}
            </p>
            <div className="row">
              <CopyButton text={value} />
              <button type="button" className="btn btn--sm btn--ghost" onClick={close}>
                Hide
              </button>
            </div>
            <p className="hint">Hidden again in 30 seconds.</p>
          </div>
        )}
      </Dialog>
    </>
  );
}
