import { useState } from "react";
import { postJson } from "../lib/api.ts";
import { invalidate, useResource } from "../lib/cache.ts";
import { toast } from "../lib/events.ts";
import { useTerms } from "../lib/prefs.ts";
import { href } from "../lib/routes.ts";
import type { AdminAccount, AdminVault, SessionInfo } from "../lib/types.ts";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Empty, Panel, RelTime, SkeletonPanel } from "../ui/Parts.tsx";
import { ConfirmDialog, ErrorCallout, TabPanel, Tabs, ToneTag, useAction } from "./setup/common.tsx";
import { VAULT_TONE } from "./setup/hosted.ts";
import type { BadgeState } from "./setup/model.ts";

type Status = "waitlisted" | "approved" | "denied";

const TABS = [
  ["waitlisted", "Waiting"],
  ["approved", "Approved"],
  ["denied", "Denied"],
] as const;

const ACCOUNT_TONE: Record<AdminAccount["status"], { tone: BadgeState; word: string }> = {
  waitlisted: { tone: "wait", word: "Waiting" },
  approved: { tone: "done", word: "Approved" },
  denied: { tone: "error", word: "Denied" },
  deleted: { tone: "na", word: "Deleted" },
};

/** The hosted app's admin page: let people in from the waitlist, and see which vaults exist (names and states only). */
export default function AdminView() {
  return <PageGate allowSetup>{(session) => (session.account?.admin ? <Admin /> : <NotAdmin session={session} />)}</PageGate>;
}

function NotAdmin({ session }: { session: SessionInfo }) {
  const { t } = useTerms();
  return (
    <div className="door panel">
      <Icon name="lock" size={40} />
      <h1>Admins only</h1>
      <p>This page is for the people who run this Hippocampus: they approve accounts here.{session.user ? ` You're signed in as @${session.user.login}.` : ""}</p>
      <div className="row sz-center">
        <a className="btn btn--primary" href={href.page("tavern")}>
          <Icon name="tavern" /> {t("tavern")}
        </a>
        <a className="btn" href={href.page("setup")}>
          <Icon name="setup" /> {t("setup")}
        </a>
      </div>
    </div>
  );
}

function Admin() {
  const [tab, setTab] = useState<Status>("waitlisted");
  return (
    <div className="stack sz">
      <header className="page-head">
        <div>
          <div className="page-head__kicker">Admin</div>
          <h1>Accounts and vaults</h1>
          <p className="page-head__lede">Approve who gets in, and see which vaults exist. Admins see names and states here, never what's in anyone's vault.</p>
        </div>
      </header>
      <Panel title="Accounts" icon="party" id="accounts">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Accounts by status" idBase="hz-admin" />
        <TabPanel idBase="hz-admin" id={tab}>
          <Accounts status={tab} />
        </TabPanel>
      </Panel>
      <Vaults />
    </div>
  );
}

function Accounts({ status }: { status: Status }) {
  const list = useResource<{ accounts: AdminAccount[] }>(`/admin/accounts?status=${status}`);
  const [denying, setDenying] = useState<AdminAccount>();
  const act = useAction();
  const refresh = () => invalidate((k) => k.startsWith("/admin/"));

  const approve = async (a: AdminAccount) => {
    const res = await act.run(() => postJson<{ account: AdminAccount }>("/admin/accounts/approve", { id: a.id }));
    if (!res) return;
    toast(`@${a.login} is approved.`, "ok");
    await refresh();
  };

  if (list.error && !list.data) return <ErrorCallout error={list.error} onRetry={() => void list.reload()} />;
  if (!list.data) return <SkeletonPanel lines={3} />;
  if (!list.data.accounts.length)
    return (
      <Empty icon="party" title={status === "waitlisted" ? "Nobody is waiting" : status === "approved" ? "No approved accounts" : "No denied accounts"}>
        {status === "waitlisted" ? "New sign-ins land here once they ask for access." : null}
      </Empty>
    );
  return (
    <div className="stack">
      {act.error !== undefined && !denying && <ErrorCallout error={act.error} />}
      <div className="table-wrap">
        <table className="table hz-rtable">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Note</th>
              <th scope="col">Since</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data.accounts.map((a) => {
              const tone = ACCOUNT_TONE[a.status];
              return (
                <tr key={a.id}>
                  <td data-label="Account">
                    <a href={`https://github.com/${encodeURIComponent(a.login)}`} rel="noopener noreferrer">
                      <strong>@{a.login}</strong>
                    </a>
                    {a.admin && <span className="chip hz-chip">admin</span>}
                  </td>
                  <td data-label="Note">{a.note ? <span className="hz-note">{a.note}</span> : <span className="muted">{status === "waitlisted" ? "hasn't asked yet" : "none"}</span>}</td>
                  <td data-label="Since">
                    <RelTime at={a.status === "waitlisted" ? a.created : a.updated} />
                  </td>
                  <td data-label="Status">
                    <ToneTag tone={tone.tone} word={tone.word} compact />
                  </td>
                  <td className="sz-tokens__act">
                    <span className="row sz-tight-row hz-actions">
                      {a.status !== "approved" && (
                        <button type="button" className="btn btn--sm btn--primary" onClick={() => void approve(a)} disabled={act.busy} aria-label={`Approve @${a.login}`}>
                          <Icon name="check" size={16} /> Approve
                        </button>
                      )}
                      {a.status !== "denied" && !a.admin && (
                        <button type="button" className="btn btn--sm btn--danger" onClick={() => setDenying(a)} disabled={act.busy} aria-label={`Deny @${a.login}`}>
                          Deny
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={!!denying}
        onClose={() => {
          setDenying(undefined);
          act.clear();
        }}
        title="Deny this account?"
        confirmLabel="Deny access"
        danger
        busy={act.busy}
        onConfirm={async () => {
          if (!denying) return;
          const res = await act.run(() => postJson<{ account: AdminAccount }>("/admin/accounts/deny", { id: denying.id }));
          if (!res) return;
          toast(`@${denying.login} was denied.`, "ok");
          setDenying(undefined);
          await refresh();
        }}
      >
        {denying && (
          <p>
            <strong>@{denying.login}</strong> is signed out and can't sign in again. {denying.status === "approved" ? "Their vault stops answering and their keys stop working; their repository stays theirs, untouched." : ""} You can approve them later from the Denied tab.
          </p>
        )}
        {act.error !== undefined && <ErrorCallout error={act.error} />}
      </ConfirmDialog>
    </div>
  );
}

function Vaults() {
  const list = useResource<{ vaults: AdminVault[] }>("/admin/vaults");
  return (
    <Panel title="Vaults" icon="codex" id="vaults">
      {list.error && !list.data ? (
        <ErrorCallout error={list.error} onRetry={() => void list.reload()} />
      ) : !list.data ? (
        <SkeletonPanel lines={3} />
      ) : list.data.vaults.length ? (
        <div className="table-wrap">
          <table className="table hz-rtable">
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Owner</th>
                <th scope="col">State</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {list.data.vaults.map((vault) => {
                const tone = VAULT_TONE[vault.status];
                return (
                  <tr key={vault.id}>
                    <td data-label="Repository">
                      <span className="mono sz-break">{vault.fullName}</span>
                    </td>
                    <td data-label="Owner">@{vault.login}</td>
                    <td data-label="State">
                      <ToneTag tone={tone.tone} word={tone.word} title={vault.reason ? `Reason: ${vault.reason.replace(/_/g, " ")}` : undefined} compact />
                      {vault.reason && <span className="small muted"> {vault.reason.replace(/_/g, " ")}</span>}
                    </td>
                    <td data-label="Created">
                      <RelTime at={vault.created} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="codex" title="No vaults yet" />
      )}
    </Panel>
  );
}
