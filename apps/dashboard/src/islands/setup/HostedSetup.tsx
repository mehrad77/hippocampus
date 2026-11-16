import { useEffect, useState } from "react";
import { postJson } from "../../lib/api.ts";
import { clearCache, useResource } from "../../lib/cache.ts";
import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import { repoLinks } from "../../lib/vaultLinks.ts";
import { addingVaultNow, stopAddingVault } from "../../lib/vault.ts";
import { signOut } from "../../lib/session.ts";
import type { AccountApp, HostedStatus, SessionInfo } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Panel } from "../../ui/Parts.tsx";
import { Personalization } from "../../ui/Personalization.tsx";
import { ConfirmDialog, CopyLine, ErrorCallout, Facts, Field, ToneTag, useAction, useHash, useScrollToHash } from "./common.tsx";
import { CuratorRuns } from "./Curator.tsx";
import { HealthChecklist } from "./Health.tsx";
import { forNewVault, hasCurator, resolveSetupHash, SETUP_SECTIONS, VAULT_TONE, type SetupSectionId } from "./hosted.ts";
import { ConnectionsPanel, CurationSetup } from "./Connections.tsx";
import { HostedCurator } from "./HostedCurator.tsx";
import { HostedOnboarding } from "./HostedOnboarding.tsx";
import { AppInvitesPanel, IncomingInvites, MembersPanel } from "./HostedSharing.tsx";
import { HostedVaultsPanel } from "./HostedVaults.tsx";
import { SecretsPanel } from "./SecretsPanel.tsx";

/** Where each health item is fixed. Its keys are health-item ids, not anchors. */
const SECTION: Record<string, string> = { access: "#account", install: "#sz-repo", vault: "#sz-repo", keys: "#connections", curator: "#curation" };

/**
 * Setup on the hosted app. Until the vault is ready it's the onboarding wizard; after that it's Setup &
 * health in sections, with the wizard's last steps (the first agent, curation) still a hash away. Old step
 * hashes land on their step, or on a ready vault on their section, and the address shows the real id.
 */
export function HostedSetup({ session, status }: { session: SessionInfo; status: HostedStatus }) {
  const hash = useHash();
  const ready = status.vault?.status === "ready";
  const adding = addingVaultNow(location.search, hash);
  const target = resolveSetupHash(hash, { ready, adding });
  const real = target ? ("step" in target ? target.step : target.anchor) : undefined;
  useEffect(() => {
    if (target?.alias && real) history.replaceState(history.state, "", `${location.pathname}${location.search}#${real}`);
  }, [hash]);
  const footer = (
    <>
      {status.account.status === "approved" && <AppInvitesPanel />}
      <AccountPanel session={session} status={status} />
      <Personalization />
    </>
  );
  if (adding) return <HostedOnboarding session={session} status={forNewVault(status)} adding footer={footer} />;
  if (ready && !(target && "step" in target)) return <HostedManage session={session} status={status} anchor={target && "anchor" in target ? target.anchor : ""} />;
  return (
    <>
      <IncomingInvites />
      <HostedOnboarding session={session} status={status} footer={footer} hostedCuration={status.hostedCurator?.available ? <HostedCurator status={status} compact /> : undefined} />
    </>
  );
}

function HostedManage({ session, status, anchor }: { session: SessionInfo; status: HostedStatus; anchor: string }) {
  const { t, v } = useTerms();
  const vault = status.vault!;
  const tone = VAULT_TONE[vault.status];
  const links = repoLinks({ kind: vault.provider ?? "github", repo: vault.fullName, branch: vault.branch, url: vault.url });
  const owner = vault.role === "owner";
  // A sign-in app the owner let curate counts as the curator, so the setup folds away under the runs.
  const apps = useResource<{ apps: AccountApp[] }>(owner ? "/account/apps" : null);
  useScrollToHash(anchor, false);
  // Back on the plain setup page: whatever vault was being added, that's over.
  useEffect(stopAddingVault, []);
  // Members don't curate or hold the secrets key; viewers connect nothing.
  const shown = new Set<SetupSectionId>(["setup-vault", "setup-people", "setup-account", ...(vault.role !== "viewer" ? (["setup-agents"] as const) : []), ...(owner ? (["setup-curation"] as const) : [])]);
  return (
    <div className="stack sz">
      <header className="page-head">
        <div>
          <div className="page-head__kicker">
            {t("sessionZero")}
            {session.campaign ? ` · ${session.campaign}` : ""}
          </div>
          <h1>Setup & health</h1>
          <p className="page-head__lede">
            {v("Your vault, the agents connected to it, curation, the people you share it with, and your account.", "The campaign's vault, the party at the table, the sleep, the players you share it with, and your account.")}
          </p>
        </div>
        <span className="chip sz-where" title={`Signed in with GitHub as @${status.account.login}`}>
          <Icon name="cloud" size={14} /> Hosted · @{status.account.login}
        </span>
      </header>

      <IncomingInvites />
      {status.items.length > 0 && <HealthChecklist items={status.items} linkFor={(id) => SECTION[id]} defaultOpen={false} />}

      <nav className="sz-secnav" aria-label="Sections of Setup & health">
        <ul>
          {SETUP_SECTIONS.filter((s) => shown.has(s.id)).map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{v(s.title[0], s.title[1])}</a>
            </li>
          ))}
        </ul>
      </nav>

      <section className="sz-section stack" id="setup-vault" aria-label={v("Vault", "The vault")}>
        <div className="grid grid--2">
        <Panel title={v("Vault repository", "The vault")} icon="github" id="sz-repo">
          <div className="stack sz-tight">
            <Facts
              rows={[
                [
                  "Repository",
                  <a className="mono sz-break" href={href.repo(vault)} rel="noopener noreferrer">
                    {vault.fullName}
                  </a>,
                ],
                ["Branch", <span className="mono">{vault.branch}</span>],
                ["State", <ToneTag tone={tone.tone} word={tone.word} compact />],
                ["Private", vault.provider === "gitlab" ? "Yes: only you and your GitLab connection can read it" : "Yes: only you and the app can read it"],
              ]}
            />
            <CopyLine value={status.mcpUrl} label="This vault's MCP address" />
            <p className="small muted">The vault's own address: a key for it names this vault and no other. It's your repository: clone it, open it in Obsidian, or back it up like any other. Deleting your account here leaves it untouched.</p>
          </div>
        </Panel>
        {owner && session.capabilities.secrets && <SecretsPanel vaultName={vault.fullName.split("/").pop() ?? vault.fullName} canRotate={!!session.capabilities.reveal} />}
        </div>
        <HostedVaultsPanel status={status} />
      </section>

      {shown.has("setup-agents") && (
        <section className="sz-section stack" id="setup-agents" aria-label={v("Agents", "The party")}>
          <ConnectionsPanel status={status} />
        </section>
      )}

      {shown.has("setup-curation") && (
        <section className="sz-section stack" id="setup-curation" aria-label={v("Curation", "The sleep")}>
          <CurationSetup status={status} curated={hasCurator({ status, draftReady: false, apps: apps.data?.apps })} runs={session.capabilities.curator ? <CuratorRuns commits={links ? { url: links.commits, host: links.host } : undefined} /> : undefined} />
        </section>
      )}

      <section className="sz-section grid grid--2" id="setup-people" aria-label={v("People", "The table")}>
        <MembersPanel session={session} status={status} />
        <AppInvitesPanel />
      </section>

      <section className="sz-section grid grid--2" id="setup-account" aria-label="Account">
        <AccountPanel session={session} status={status} />
        <Personalization />
      </section>
    </div>
  );
}

/** Who's signed in, signing out, and deleting the account (typed confirmation). */
function AccountPanel({ session, status }: { session: SessionInfo; status: HostedStatus }) {
  const { v } = useTerms();
  const login = status.account.login;
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const del = useAction();
  const matches = typed.trim().replace(/^@/, "").toLowerCase() === login.toLowerCase();
  const word = status.account.status === "approved" ? { tone: "done" as const, word: "Approved" } : status.account.status === "denied" ? { tone: "error" as const, word: "Not granted" } : { tone: "warn" as const, word: "On the waitlist" };

  return (
    <Panel title="Account" icon="github" id="account">
      <div className="stack">
        <Facts
          rows={[
            ["Signed in as", <strong>@{login}</strong>],
            ["Access", <ToneTag tone={word.tone} word={word.word} compact />],
            ...((session.account?.admin ?? status.account.admin) ? ([["Admin", <a href={href.page("admin")}>Yes: the admin page</a>]] as [string, React.ReactNode][]) : []),
          ]}
        />
        <div className="row">
          <button type="button" className="btn" onClick={() => void signOut()}>
            <Icon name="logout" /> Sign out
          </button>
          <button type="button" className="btn btn--danger" onClick={() => setDeleting(true)}>
            Delete my account…
          </button>
        </div>
        <p className="small muted">
          What this Hippocampus keeps about you, and how deleting works: <a href={href.page("privacy")}>the privacy notice</a>.
        </p>
      </div>
      <ConfirmDialog
        open={deleting}
        onClose={() => {
          setDeleting(false);
          setTyped("");
          del.clear();
        }}
        title="Delete your account?"
        confirmLabel="Delete my account"
        danger
        busy={del.busy}
        disabled={!matches}
        onConfirm={async () => {
          const res = await del.run(() => postJson<{ ok: boolean }>("/account/delete", { confirm: typed.trim() }));
          if (!res) return;
          clearCache({ everywhere: true });
          location.assign(href.page("welcome"));
        }}
      >
        <p>This can't be undone. Right away:</p>
        <ul className="sz-howto">
          <li>Every key stops working, and connected apps are signed out.</li>
          <li>The Hippocampus app is uninstalled from your GitHub repositories, and its connection to your GitLab account (if any) is revoked.</li>
          <li>Everything this Hippocampus keeps for you goes: your account, keys, and every vault's search index and cache.</li>
        </ul>
        <p>
          <strong>Your repositories stay where they are, untouched.</strong> {v("Your memory is yours: delete the repositories yourself if you want them gone too.", "The campaigns are yours: delete the repositories yourself if you want them gone too.")}
        </p>
        <Field label={<>Type your GitHub login ({login}) to confirm</>}>
          {(f) => <input id={f.id} className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={f.describedBy} />}
        </Field>
        {del.error !== undefined && <ErrorCallout error={del.error} />}
      </ConfirmDialog>
    </Panel>
  );
}
