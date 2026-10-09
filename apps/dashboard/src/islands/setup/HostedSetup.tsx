import { useState } from "react";
import { ApiError, postJson } from "../../lib/api.ts";
import { clearCache, useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import { signOut } from "../../lib/session.ts";
import type { AccountApp, HostedStatus, SessionInfo } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Empty, Panel, RelTime, SkeletonPanel } from "../../ui/Parts.tsx";
import { Personalization } from "../../ui/Personalization.tsx";
import { ConfirmDialog, CopyLine, ErrorCallout, Facts, Field, ToneTag, useAction, useHash, useScrollToHash } from "./common.tsx";
import { CuratorPanel } from "./Curator.tsx";
import { HealthChecklist } from "./Health.tsx";
import { parseHostedStep, VAULT_TONE } from "./hosted.ts";
import { HostedKeysPanel } from "./HostedKeys.tsx";
import { HostedOnboarding } from "./HostedOnboarding.tsx";

const SECTION: Record<string, string> = { access: "#account", install: "#sz-repo", vault: "#sz-repo", keys: "#sz-keys" };

/**
 * Setup on the hosted app. Until the vault is ready it's the onboarding wizard; after that it's the
 * vault's keys, apps, curator and the account, with the wizard's later steps still a hash away.
 */
export function HostedSetup({ session, status }: { session: SessionInfo; status: HostedStatus }) {
  const hash = useHash();
  const ready = status.vault?.status === "ready";
  if (ready && !parseHostedStep(hash)) return <HostedManage session={session} status={status} hash={hash} />;
  return <HostedOnboarding session={session} status={status} footer={<AccountPanel session={session} status={status} />} />;
}

function HostedManage({ session, status, hash }: { session: SessionInfo; status: HostedStatus; hash: string }) {
  const { t, v } = useTerms();
  const vault = status.vault!;
  const tone = VAULT_TONE[vault.status];
  useScrollToHash(hash, false);
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

      {status.items.length > 0 && <HealthChecklist items={status.items} linkFor={(id) => SECTION[id]} defaultOpen={false} />}

      <div className="grid grid--2">
        <Panel title={v("Vault repository", "The vault")} icon="github" id="sz-repo">
          <Facts
            rows={[
              [
                "Repository",
                <a className="mono sz-break" href={href.github(vault.fullName)} rel="noopener noreferrer">
                  {vault.fullName}
                </a>,
              ],
              ["Branch", <span className="mono">{vault.branch}</span>],
              ["State", <ToneTag tone={tone.tone} word={tone.word} compact />],
              ["Private", "Yes: only you and the app can read it"],
            ]}
          />
          <p className="small muted">It's your repository: clone it, open it in Obsidian, or back it up like any other. Deleting your account here leaves it untouched.</p>
        </Panel>
        <Panel title="Connect" icon="link" id="sz-connect">
          <div className="stack sz-tight">
            <p className="small">Your vault's MCP address. Agents use it with a key; Claude.ai and ChatGPT add it as a custom connector and sign in with GitHub.</p>
            <CopyLine value={status.mcpUrl} label="MCP URL" />
            <p className="small">
              <a href="#agents">{v("Connect agents, step by step", "Gather the party, step by step")}</a> · <a href="#curator">{v("Set up curation", "Appoint a curator")}</a>
            </p>
          </div>
        </Panel>
      </div>

      <HostedKeysPanel status={status} />
      {session.capabilities.curator && <CuratorPanel repo={vault.fullName} branch={vault.branch} />}
      <AppsPanel />
      <AccountPanel session={session} status={status} />
      <Personalization />
    </div>
  );
}

/** Connectors (Claude.ai, ChatGPT, …) that signed in with OAuth. */
function AppsPanel() {
  const { v } = useTerms();
  const apps = useResource<{ apps: AccountApp[] }>("/account/apps");
  const [revoking, setRevoking] = useState<AccountApp>();
  const revoke = useAction();
  const missing = apps.error instanceof ApiError && (apps.error.status === 404 || apps.error.status === 501);
  return (
    <Panel title="Connected apps" icon="cloud" id="sz-apps">
      <p className="small">Apps you connected with a GitHub sign-in instead of a key. Each acts as the agent you chose when you approved it.</p>
      {missing ? (
        <p className="small muted">This Hippocampus doesn't list connected apps yet.</p>
      ) : apps.error && !apps.data ? (
        <ErrorCallout error={apps.error} onRetry={() => void apps.reload()} />
      ) : !apps.data ? (
        <SkeletonPanel lines={2} />
      ) : apps.data.apps.length ? (
        <div className="table-wrap">
          <table className="table hz-rtable">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">{v("Acts as", "Plays")}</th>
                <th scope="col">Scopes</th>
                <th scope="col">Connected</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {apps.data.apps.map((a) => (
                <tr key={a.id}>
                  <td data-label="App">
                    <strong className="sz-break">{a.client}</strong>
                  </td>
                  <td data-label={v("Acts as", "Plays")}>{a.agent ? <span className="mono">{a.agent}</span> : <span className="muted">not chosen</span>}</td>
                  <td data-label="Scopes">
                    <span className="row sz-tight-row">
                      {a.scopes.map((s) => (
                        <span key={s} className="chip">
                          {s}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td data-label="Connected">
                    <RelTime at={a.created} />
                  </td>
                  <td className="sz-tokens__act">
                    <button type="button" className="btn btn--sm btn--danger" onClick={() => setRevoking(a)} aria-label={`Disconnect ${a.client}`}>
                      Disconnect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="cloud" title="No connected apps">
          Add your MCP address as a custom connector in Claude.ai or ChatGPT; it shows up here once you approve it.
        </Empty>
      )}
      <ConfirmDialog
        open={!!revoking}
        onClose={() => {
          setRevoking(undefined);
          revoke.clear();
        }}
        title="Disconnect this app?"
        confirmLabel="Disconnect"
        danger
        busy={revoke.busy}
        onConfirm={async () => {
          if (!revoking) return;
          const res = await revoke.run(() => postJson<{ ok: boolean }>("/account/apps/revoke", { id: revoking.id }));
          if (!res) return;
          toast(`Disconnected ${revoking.client}.`, "ok");
          setRevoking(undefined);
          void apps.reload();
        }}
      >
        {revoking && (
          <p>
            <strong>{revoking.client}</strong> loses access to your vault immediately. Connect it again from the app if you change your mind.
          </p>
        )}
        {revoke.error !== undefined && <ErrorCallout error={revoke.error} />}
      </ConfirmDialog>
    </Panel>
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
            ...(status.vault ? ([["Vault", <span className="mono sz-break">{status.vault.fullName}</span>]] as [string, React.ReactNode][]) : []),
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
          <li>The Hippocampus app is uninstalled from your repository.</li>
          <li>Everything this Hippocampus keeps for you goes: your account, keys, the vault's search index and cache.</li>
        </ul>
        <p>
          <strong>Your repository stays on GitHub, untouched.</strong> {v("Your memory is yours: delete the repository on GitHub if you want it gone too.", "The campaign is yours: delete the repository on GitHub if you want it gone too.")}
        </p>
        <Field label={<>Type your GitHub login ({login}) to confirm</>}>
          {(f) => <input id={f.id} className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={f.describedBy} />}
        </Field>
        {del.error !== undefined && <ErrorCallout error={del.error} />}
      </ConfirmDialog>
    </Panel>
  );
}
