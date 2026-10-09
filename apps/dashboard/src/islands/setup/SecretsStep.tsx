import { useState } from "react";
import { postJson } from "../../lib/api.ts";
import { useTerms } from "../../lib/prefs.ts";
import { Icon } from "../../ui/Icon.tsx";
import { CopyButton } from "../../ui/Parts.tsx";
import { ConfirmDialog, Effects, ErrorCallout, Facts, refreshSetup, useAction } from "./common.tsx";
import { truncateKey, type StepProps } from "./model.ts";

export function SecretsStep({ status }: StepProps) {
  const { v } = useTerms();
  const s = status.secrets;
  const action = useAction();
  const [made, setMade] = useState<{ recipient: string; identityFile: string }>();
  const [confirmNew, setConfirmNew] = useState(false);

  const forge = async (reuseExisting: boolean) => {
    const res = await action.run(() => postJson<{ recipient: string; identityFile: string }>("/setup/secrets", reuseExisting ? { reuseExisting: true } : {}));
    setConfirmNew(false);
    if (!res) return;
    setMade(res);
    void refreshSetup();
  };

  // The vault was keyed on another machine: forging here would seal new secrets to a key the other machine can't open.
  const keyedElsewhere = !s.identity && !!s.recipient;

  return (
    <div className="stack">
      <Effects
        items={[
          ["writes", <>a private age identity to <code>{s.identityFile}</code>, on this machine only, if there isn't one yet.</>],
          ["writes", <>only its public key into the vault, as <code>secrets.recipient</code> in <code>_hippo/config.yaml</code>.</>],
          [
            "never",
            v(
              <>
                shows or sends the private key. The nightly update only ever encrypts with the public key; reading a secret happens in your terminal (<code>hippo secrets show</code>).
              </>,
              "shows or sends the private key. The curator only ever encrypts with the public key; reading a secret happens in your terminal (hippo secrets show).",
            ),
          ],
        ]}
      />

      <Facts
        rows={[
          ["Identity file", <span className="mono sz-break">{s.identityFile}</span>],
          ["On this machine", s.identity ? "Yes" : "Not yet"],
          ["Vault's public key", s.recipient ? <span className="mono">{truncateKey(s.recipient)}</span> : "Not set"],
          ["They match", s.identity && s.recipient ? (s.matches ? "Yes" : <strong className="sz-warn-text">No</strong>) : "—"],
        ]}
      />

      {s.identity && s.matches && !made && (
        <div className="callout callout--ok">
          <Icon name="lock" />
          <div>
            {v("Set up and matching.", "Sealed and matched.")} Secret facts in this vault are encrypted to the key on this machine. Keep a backup of the identity file somewhere safe, such as a password manager.
          </div>
        </div>
      )}

      {!s.identity && !s.recipient && (
        <div className="stack sz-tight">
          <p>{v("No key yet. Create one now: it takes a second and nothing leaves this machine.", "No key yet. Forge one now: it takes a second and nothing leaves this machine.")}</p>
          <div className="row">
            <button type="button" className="btn btn--primary" onClick={() => void forge(false)} disabled={action.busy}>
              <Icon name="key" /> {action.busy ? v("Creating…", "Forging…") : v("Create a key", "Forge a key")}
            </button>
          </div>
        </div>
      )}

      {s.identity && !s.matches && (
        <div className="callout callout--warn">
          <Icon name="key" />
          <div className="stack sz-tight">
            <strong>
              {s.recipient
                ? v("The vault is encrypted to a different key than the one on this machine.", "The vault is sealed to a different key than the one on this machine.")
                : "This machine has a key, but the vault doesn't use it yet."}
            </strong>
            <span>
              {v("Use the key already here: its public key goes into the vault, and new secrets are encrypted to it.", "Use the key already here: its public key goes into the vault, and new secrets are sealed to it.")}
              {s.recipient && v(" Secrets encrypted to the old key stay readable only with the old identity file, so keep that one too.", " Secrets sealed to the old key stay readable only with the old identity file, so keep that one too.")}
            </span>
            <span className="row">
              <button type="button" className="btn btn--primary" onClick={() => void forge(true)} disabled={action.busy}>
                <Icon name="key" /> {action.busy ? "Working…" : "Use this machine's key"}
              </button>
            </span>
          </div>
        </div>
      )}

      {keyedElsewhere && (
        <div className="callout callout--warn">
          <Icon name="key" />
          <div className="stack sz-tight">
            <strong>{v("The vault's key was created on another machine.", "The vault was sealed on another machine.")}</strong>
            <span>
              To read its secrets here, copy the identity file from that machine to <code>{s.identityFile}</code>, then reload this page.{" "}
              {v(
                "Creating a new key instead encrypts future secrets to the new key; the old ones stay readable only with the old identity.",
                "Forging a new key instead seals future secrets to the new key; the old ones stay readable only with the old identity.",
              )}
            </span>
            <span className="row">
              <button type="button" className="btn btn--sm" onClick={() => setConfirmNew(true)} disabled={action.busy}>
                {v("Create a new key anyway…", "Forge a new key anyway…")}
              </button>
            </span>
          </div>
        </div>
      )}

      {made && (
        <div className="callout callout--warn" role="status">
          <Icon name="lock" />
          <div className="stack sz-tight">
            <strong>{v("Key created. Back up the identity file now.", "Key forged. Back up the identity file now.")}</strong>
            <span>
              It lives at <code className="sz-break">{made.identityFile}</code>. Without it, secret facts can't be decrypted, by you or anyone. A password manager is a good home for a copy.
            </span>
            <span className="row">
              <CopyButton text={made.identityFile} label="Copy the path" />
              <span className="small muted">Vault's public key: {truncateKey(made.recipient)}</span>
            </span>
          </div>
        </div>
      )}

      {action.error !== undefined && <ErrorCallout error={action.error} />}

      <ConfirmDialog
        open={confirmNew}
        onClose={() => setConfirmNew(false)}
        title={v("Create a new key?", "Forge a new key?")}
        confirmLabel={v("Create a new key", "Forge a new key")}
        busy={action.busy}
        onConfirm={() => void forge(false)}
      >
        <p>
          This writes a new identity to <code>{s.identityFile}</code> and replaces the vault's public key with its own.
        </p>
        <p className="muted">
          {v("Secrets already in the vault were encrypted to the old key: only the old identity file can open them.", "Secrets already in the vault were sealed to the old key: only the old identity file can open them.")}
        </p>
      </ConfirmDialog>
    </div>
  );
}
