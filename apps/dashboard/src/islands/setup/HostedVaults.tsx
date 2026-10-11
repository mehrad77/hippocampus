import { useState } from "react";
import { postJson } from "../../lib/api.ts";
import { clearCache } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import { forgetVault, switchVault } from "../../lib/vault.ts";
import type { HostedStatus } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Panel } from "../../ui/Parts.tsx";
import { ConfirmDialog, ErrorCallout, Field, ToneTag, useAction } from "./common.tsx";
import { canAddVault, ROLE_WORDS, VAULT_TONE } from "./hosted.ts";

type Vault = NonNullable<HostedStatus["vaults"]>[number];

/** The person's vaults: which one this tab shows, switching, adding another, and removing one. */
export function HostedVaultsPanel({ status }: { status: HostedStatus }) {
  const { v } = useTerms();
  const vaults = status.vaults ?? [];
  const current = status.vault?.id;
  const add = canAddVault(status);
  const [removing, setRemoving] = useState<Vault>();
  const [typed, setTyped] = useState("");
  const remove = useAction();
  const close = () => {
    setRemoving(undefined);
    setTyped("");
    remove.clear();
  };

  return (
    <Panel
      title={v("Your vaults", "Your campaigns")}
      icon="cloud"
      id="vaults"
      aside={
        add.ok ? (
          <a className="btn btn--sm" href={`${href.page("setup")}?add#create`}>
            <Icon name="plus" /> Add a vault
          </a>
        ) : undefined
      }
    >
      <div className="stack">
        <p className="small">
          {v(
            "Each vault is its own memory in its own repository, with its own keys. An agent connects to one vault; to use two, connect it twice.",
            "Each campaign is its own vault in its own repository, with its own keys. An agent sits at one table; to play two, connect it twice.",
          )}
        </p>
        <ul className="hz-vaults">
          {vaults.map((vault) => {
            const tone = VAULT_TONE[vault.status];
            const here = vault.id === current;
            return (
              <li key={vault.id} className={`hz-vault${here ? " hz-vault--current" : ""}`} aria-current={here ? "true" : undefined}>
                <Icon name={vault.provider === "gitlab" ? "cloud" : "github"} size={18} />
                <span className="hz-vault__name">
                  <span className="mono sz-break">{vault.fullName}</span>
                  <span className="small muted">
                    {vault.provider === "gitlab" ? "GitLab" : "GitHub"}
                    {vault.role && vault.role !== "owner" ? ` · shared with you, ${v(...ROLE_WORDS[vault.role].word).toLowerCase()}` : ""}
                  </span>
                </span>
                <ToneTag tone={tone.tone} word={tone.word} compact />
                <span className="hz-vault__act row">
                  {here ? (
                    <span className="chip">
                      <Icon name="check" size={14} /> Showing
                    </span>
                  ) : (
                    <button type="button" className="btn btn--sm" onClick={() => switchVault(vault.id, href.page("tavern"))}>
                      Open
                    </button>
                  )}
                  {(vault.role ?? "owner") === "owner" ? (
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRemoving(vault)} aria-label={`Remove ${vault.fullName} from Hippocampus`}>
                      Remove…
                    </button>
                  ) : here ? (
                    <a className="btn btn--sm btn--ghost" href="#people">
                      Leave…
                    </a>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        {!add.ok && add.why && <p className="small muted">{add.why}</p>}
      </div>

      <ConfirmDialog
        open={!!removing}
        onClose={close}
        title={`Remove ${removing?.fullName ?? "this vault"}?`}
        confirmLabel="Remove the vault"
        danger
        busy={remove.busy}
        disabled={!removing || typed.trim().toLowerCase() !== removing.fullName.toLowerCase()}
        onConfirm={async () => {
          if (!removing) return;
          const res = await remove.run(() => postJson<{ ok: boolean }>("/setup/vaults/remove", { id: removing.id, confirm: typed.trim() }));
          if (!res) return;
          toast(`${removing.fullName} is no longer connected here. Its repository is untouched.`, "ok");
          if (removing.id === current) forgetVault();
          clearCache();
          location.assign(href.page("setup", "#vaults"));
        }}
      >
        <p>Right away:</p>
        <ul className="sz-howto">
          <li>Its keys stop working, and apps connected to it are signed out.</li>
          <li>Its search index and cache here are wiped.</li>
        </ul>
        <p>
          <strong>The repository stays on {removing?.provider === "gitlab" ? "GitLab" : "GitHub"}, untouched</strong>, with every memory in it. You can add it again later.
        </p>
        <Field label={<>Type {removing?.fullName} to confirm</>}>
          {(f) => <input id={f.id} className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={f.describedBy} />}
        </Field>
        {remove.error !== undefined && <ErrorCallout error={remove.error} />}
      </ConfirmDialog>
    </Panel>
  );
}
