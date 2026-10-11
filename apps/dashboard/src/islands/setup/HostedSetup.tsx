import { useEffect, useState } from "react";
import { postJson } from "../../lib/api.ts";
import { clearCache } from "../../lib/cache.ts";
import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import { repoLinks } from "../../lib/vaultLinks.ts";
import { addingVaultNow, stopAddingVault } from "../../lib/vault.ts";
import { signOut } from "../../lib/session.ts";
import type { HostedStatus, SessionInfo } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Panel } from "../../ui/Parts.tsx";
import { Personalization } from "../../ui/Personalization.tsx";
import { ConfirmDialog, CopyLine, ErrorCallout, Facts, Field, ToneTag, useAction, useHash, useScrollToHash } from "./common.tsx";
import { CuratorRuns } from "./Curator.tsx";
import { HealthChecklist } from "./Health.tsx";
import { forNewVault, parseHostedStep, VAULT_TONE } from "./hosted.ts";
import { ConnectionsPanel, CurationSetup } from "./Connections.tsx";
import { HostedOnboarding } from "./HostedOnboarding.tsx";
import { AppInvitesPanel, IncomingInvites, MembersPanel } from "./HostedSharing.tsx";
import { HostedVaultsPanel } from "./HostedVaults.tsx";

const SECTION: Record<string, string> = { access: "#account", install: "#sz-repo", vault: "#sz-repo", keys: "#connections", curator: "#curation" };

/**
 * Setup on the hosted app. Until the vault is ready it's the onboarding wizard; after that it's the
 * vault's keys, apps, curator and the account, with the wizard's later steps still a hash away.
 */
export function HostedSetup({ session, status }: { session: SessionInfo; status: HostedStatus }) {
  const hash = useHash();
  const ready = status.vault?.status === "ready";
  const footer = (
    <>
      {status.account.status === "approved" && <AppInvitesPanel />}
      <AccountPanel session={session} status={status} />
    </>
  );
  if (addingVaultNow(location.search, hash)) return <HostedOnboarding session={session} status={forNewVault(status)} adding footer={footer} />;
  if (ready && !parseHostedStep(hash)) return <HostedManage session={session} status={status} hash={hash} />;
  return (
    <>
      <IncomingInvites />
      <HostedOnboarding session={session} status={status} footer={footer} />
    </>
  );
}

function HostedManage({ session, status, hash }: { session: SessionInfo; status: HostedStatus; hash: string }) {
  const { t, v } = useTerms();
  const vault = status.vault!;
  const tone = VAULT_TONE[vault.status];
  const links = repoLinks({ kind: vault.provider ?? "github", repo: vault.fullName, branch: vault.branch, url: vault.url });
  useScrollToHash(hash, false);
  // Back on the plain setup page: whatever vault was being added, that's over.
  useEffect(stopAddingVault, []);
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
            {v("Your vault, the keys to it, the apps connected to it, the curator, and your account.", "The campaign's vault, the keys to it, the apps at the table, the curator, and your account.")}
          </p>
        </div>
        <span className="chip sz-where" title={`Signed in with GitHub as @${status.account.login}`}>
          <Icon name="cloud" size={14} /> Hosted · @{status.account.login}
        </span>
      </header>

      <IncomingInvites />
      {status.items.length > 0 && <HealthChecklist items={status.items} linkFor={(id) => SECTION[id]} defaultOpen={false} />}

      <div className="grid grid--2">
        <Panel title={v("Vault repository", "The vault")} icon="github" id="sz-repo">
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
          <p className="small muted">It's your repository: clone it, open it in Obsidian, or back it up like any other. Deleting your account here leaves it untouched.</p>
        </Panel>
        <Panel title="Connect" icon="link" id="sz-connect">
          <div className="stack sz-tight">
            <p className="small">This vault's own address. Apps use it with a key, which names this vault and no other; Claude.ai and ChatGPT can sign in with it instead (beta).</p>
            <CopyLine value={status.mcpUrl} label="MCP URL" />
            <p className="small">
              {vault.role !== "viewer" && <a href="#connections">Connect an app</a>}
              {vault.role === "owner" && (
                <>
                  {" · "}
                  <a href="#curation">{v("Set up nightly curation", "Appoint a curator")}</a>
                </>
              )}
            </p>
          </div>
        </Panel>
      </div>

      <HostedVaultsPanel status={status} />
      <MembersPanel session={session} status={status} />
      {vault.role !== "viewer" && <ConnectionsPanel status={status} />}
      {vault.role === "owner" && <CurationSetup status={status} runs={session.capabilities.curator ? <CuratorRuns commits={links ? { url: links.commits, host: links.host } : undefined} /> : undefined} />}
      <AppInvitesPanel />
      <AccountPanel session={session} status={status} />
      <Personalization />
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
            ...((status.vaults?.length ?? 0) > 0 ? ([["Vaults", <a href="#vaults">{status.vaults!.map((x) => x.fullName).join(", ")}</a>]] as [string, React.ReactNode][]) : []),
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
