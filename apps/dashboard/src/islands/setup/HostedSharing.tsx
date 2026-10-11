import { useState } from "react";
import type { HostedIncomingInvite, HostedInvites, HostedMember, HostedMembers, HostedNewInvite, HostedVault } from "@hippocampus/dashboard";
import { postJson } from "../../lib/api.ts";
import { clearCache, invalidate, useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import { forgetVault, switchVault } from "../../lib/vault.ts";
import type { HostedStatus, SessionInfo } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Dialog, Empty, Panel, RelTime, SkeletonPanel } from "../../ui/Parts.tsx";
import { ConfirmDialog, CopyLine, ErrorCallout, Field, ToneTag, useAction } from "./common.tsx";
import { freeHumans, humanIdFor, inviteProblem, ROLE_WORDS } from "./hosted.ts";

type SharedRole = "member" | "viewer";
const refresh = () => invalidate((k) => k.startsWith("/vaults") || k.startsWith("/invites") || k.startsWith("/setup"));

/** Who the vault is shared with: its owner invites, changes roles and removes; everyone else sees the list and can leave. */
export function MembersPanel({ session, status }: { session: SessionInfo; status: HostedStatus }) {
  const { v } = useTerms();
  const vault = status.vault!;
  const owner = vault.role === "owner";
  const list = useResource<HostedMembers>("/vaults/members");
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<HostedMember>();
  const [leaving, setLeaving] = useState(false);
  const act = useAction();

  const setRole = async (m: HostedMember, role: SharedRole) => {
    const res = await act.run(() => postJson("/vaults/members/role", { user: m.user, role }));
    if (!res) return;
    toast(`@${m.login} is a ${v(...ROLE_WORDS[role].word).toLowerCase()} now.`, "ok");
    await refresh();
  };
  const revoke = async (id: string) => {
    const res = await act.run(() => postJson("/vaults/invites/revoke", { id }));
    if (!res) return;
    toast("Invite revoked: its link no longer works.", "ok");
    await refresh();
  };

  return (
    <Panel
      title={v("People", "The table")}
      icon="party"
      id="people"
      aside={
        owner ? (
          <button type="button" className="btn btn--sm" onClick={() => setInviting(true)}>
            <Icon name="plus" /> Invite someone
          </button>
        ) : (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setLeaving(true)}>
            Leave this vault…
          </button>
        )
      }
    >
      <div className="stack">
        <p className="small">
          {owner
            ? v(
                "Share this vault with people you trust. Each joins as a human of their own: a member adds memories and settles disputes as themselves; a viewer only reads. Their agents connect with keys they make.",
                "Seat others at this table. Each plays their own character: a player adds to the record and rules as themselves; a spectator only watches.",
              )
            : v(`${vault.fullName} is shared with you. You're ${vault.human ?? "a human"} in it.`, `You have a seat at ${vault.fullName}, as ${vault.human ?? "a human"}.`)}
        </p>
        {act.error !== undefined && !removing && !leaving && <ErrorCallout error={act.error} />}
        {list.error && !list.data ? (
          <ErrorCallout error={list.error} onRetry={() => void list.reload()} />
        ) : !list.data ? (
          <SkeletonPanel lines={2} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table hz-rtable">
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">In the vault as</th>
                    <th scope="col">Role</th>
                    <th scope="col">Since</th>
                    {owner && (
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {list.data.members.map((m) => (
                    <tr key={m.user}>
                      <td data-label="Person">
                        <strong>@{m.login}</strong>
                        {m.user === list.data!.you && <span className="small muted"> (you)</span>}
                      </td>
                      <td data-label="In the vault as">{m.human ? <span className="mono">{m.human}</span> : <span className="muted">{m.role === "owner" ? "the primary human" : "?"}</span>}</td>
                      <td data-label="Role">
                        {owner && m.role !== "owner" ? (
                          <select className="input input--sm" value={m.role} disabled={act.busy} onChange={(e) => void setRole(m, e.target.value as SharedRole)} aria-label={`Role of @${m.login}`}>
                            {(["member", "viewer"] as const).map((r) => (
                              <option key={r} value={r}>
                                {v(...ROLE_WORDS[r].word)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span title={v(...ROLE_WORDS[m.role].help)}>{v(...ROLE_WORDS[m.role].word)}</span>
                        )}
                      </td>
                      <td data-label="Since">
                        <RelTime at={m.since} />
                      </td>
                      {owner && (
                        <td className="sz-tokens__act">
                          {m.role !== "owner" && (
                            <button type="button" className="btn btn--sm btn--danger" onClick={() => setRemoving(m)} aria-label={`Remove @${m.login} from this vault`}>
                              Remove
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {owner && !!list.data.invites?.length && (
              <div className="stack sz-tight">
                <h3 className="sz-subhead">Open invites</h3>
                <ul className="hz-invites">
                  {list.data.invites.map((i) => (
                    <li key={i.id} className="row">
                      <span>
                        {i.login ? <strong>@{i.login}</strong> : <span>Anyone with the link</span>} · {i.role ? v(...ROLE_WORDS[i.role].word) : ""} as <span className="mono">{i.human}</span>
                        <span className="small muted">
                          {" "}
                          · expires <RelTime at={i.expires} />
                        </span>
                      </span>
                      <button type="button" className="btn btn--sm btn--ghost" disabled={act.busy} onClick={() => void revoke(i.id)} aria-label={`Revoke the invite${i.login ? ` for @${i.login}` : ""}`}>
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {owner && list.data && (
        <InviteDialog open={inviting} onClose={() => setInviting(false)} humans={freeHumans(session.humans ?? [], list.data.members, session.actor?.kind === "human" ? session.actor.id : undefined)} vault={vault} />
      )}
      <ConfirmDialog
        open={!!removing}
        onClose={() => {
          setRemoving(undefined);
          act.clear();
        }}
        title={`Remove @${removing?.login ?? ""}?`}
        confirmLabel="Remove them"
        danger
        busy={act.busy}
        onConfirm={async () => {
          if (!removing) return;
          const res = await act.run(() => postJson("/vaults/members/remove", { user: removing.user }));
          if (!res) return;
          toast(`@${removing.login} no longer has this vault.`, "ok");
          setRemoving(undefined);
          await refresh();
        }}
      >
        <p>Right away, they lose the dashboard, the keys they made for this vault stop working, and apps they connected to it are signed out.</p>
        <p>
          {removing?.human ? (
            <>
              Their human, <span className="mono">{removing.human}</span>, stays in the vault with everything they wrote; only their login is taken off it.
            </>
          ) : (
            "Everything they wrote stays."
          )}
        </p>
        {act.error !== undefined && <ErrorCallout error={act.error} />}
      </ConfirmDialog>
      <ConfirmDialog
        open={leaving}
        onClose={() => {
          setLeaving(false);
          act.clear();
        }}
        title={`Leave ${vault.fullName}?`}
        confirmLabel="Leave the vault"
        danger
        busy={act.busy}
        onConfirm={async () => {
          const res = await act.run(() => postJson("/vaults/leave", {}));
          if (!res) return;
          toast(`You left ${vault.fullName}.`, "ok");
          forgetVault();
          clearCache();
          location.assign(href.page("setup"));
        }}
      >
        <p>You lose the dashboard for this vault, the keys you made for it stop working, and apps you connected to it are signed out. What you wrote stays. Its owner can invite you again.</p>
        {act.error !== undefined && <ErrorCallout error={act.error} />}
      </ConfirmDialog>
    </Panel>
  );
}

function InviteDialog({ open, onClose, humans, vault }: { open: boolean; onClose: () => void; humans: string[]; vault: HostedVault }) {
  const { v } = useTerms();
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<SharedRole>("member");
  const [pick, setPick] = useState<string>("");
  const [fresh, setFresh] = useState("");
  const [tried, setTried] = useState(false);
  const [made, setMade] = useState<HostedNewInvite>();
  const action = useAction();
  const isNew = pick === "" || !humans.includes(pick);
  const human = isNew ? fresh.trim() || humanIdFor(login.replace(/^@/, "")) : pick;
  const problem = inviteProblem({ login, human });

  const close = () => {
    setLogin("");
    setPick("");
    setFresh("");
    setTried(false);
    setMade(undefined);
    action.clear();
    onClose();
  };
  const submit = async () => {
    setTried(true);
    if (problem) return;
    const to = login.trim().replace(/^@/, "");
    const res = await action.run(() => postJson<HostedNewInvite>("/vaults/members/invite", { role, human, ...(to ? { login: to } : {}) }));
    if (!res) return;
    setMade(res);
    await refresh();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={
        <span className="row">
          <Icon name="party" /> {made ? "Invite ready" : `Share ${vault.fullName}`}
        </span>
      }
      footer={
        made ? (
          <button type="button" className="btn btn--primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--ghost" onClick={close}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={action.busy}>
              <Icon name="party" /> {action.busy ? "Inviting…" : "Create the invite"}
            </button>
          </>
        )
      }
    >
      {made ? (
        <div className="stack">
          <p>
            {made.invite.login ? (
              <>
                <strong>@{made.invite.login}</strong> will see it when they sign in. You can also send them this link:
              </>
            ) : (
              "Send this link to them. It works once, for whoever opens it first, so send it privately:"
            )}
          </p>
          <CopyLine value={made.link} label="Invite link" />
          <p className="small muted">
            It expires <RelTime at={made.invite.expires} />. You won't see this link again; revoke the invite and make a new one if it's lost.
          </p>
        </div>
      ) : (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Their GitHub username (optional)" hint="Only they can accept it, and they'll see it when they sign in. Leave it empty for a link anyone can use once.">
            {(f) => <input id={f.id} className="input mono" value={login} onChange={(e) => setLogin(e.target.value)} aria-describedby={f.describedBy} placeholder="game-master" autoComplete="off" spellCheck={false} />}
          </Field>
          <fieldset className="sz-fieldset">
            <legend className="label">What they can do</legend>
            {(["member", "viewer"] as const).map((r) => (
              <label key={r} className="check sz-scope">
                <input type="radio" name="hz-role" checked={role === r} onChange={() => setRole(r)} />
                <span>
                  <strong>{v(...ROLE_WORDS[r].word)}</strong>
                  <span className="small muted"> · {v(...ROLE_WORDS[r].help)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="sz-fieldset">
            <legend className="label">Who they are in the vault</legend>
            {humans.map((h) => (
              <label key={h} className="check sz-scope">
                <input type="radio" name="hz-human" checked={pick === h} onChange={() => setPick(h)} />
                <span>
                  <strong className="mono">{h}</strong>
                  <span className="small muted"> · already one of the vault's humans</span>
                </span>
              </label>
            ))}
            <label className="check sz-scope">
              <input type="radio" name="hz-human" checked={isNew} onChange={() => setPick("")} />
              <span>
                <strong>Someone new</strong>
                <span className="small muted"> · added to the vault's humans when they accept</span>
              </span>
            </label>
            {isNew && (
              <Field label="Their id in the vault" hint="How notes and the chronicle name them." problem={tried ? problem : undefined}>
                {(f) => (
                  <input
                    id={f.id}
                    className="input mono"
                    value={fresh}
                    onChange={(e) => setFresh(e.target.value.toLowerCase())}
                    placeholder={humanIdFor(login.replace(/^@/, "")) || "game-master"}
                    aria-describedby={f.describedBy}
                    aria-invalid={f.invalid}
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
              </Field>
            )}
          </fieldset>
          {action.error !== undefined && <ErrorCallout error={action.error} />}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

/** Invites waiting for the signed-in person (addressed to their login): accept or decline. */
export function IncomingInvites() {
  const { v } = useTerms();
  const invites = useResource<HostedInvites>("/invites");
  const act = useAction();
  const incoming = invites.data?.incoming ?? [];
  if (!incoming.length) return null;
  const accept = async (i: HostedIncomingInvite) => {
    const res = await act.run(() => postJson<{ vault?: HostedVault }>("/invites/accept", { id: i.id }));
    if (!res) return;
    toast(res.vault ? `You're in ${res.vault.fullName}.` : "You're in.", "ok");
    clearCache();
    if (res.vault) switchVault(res.vault.id, href.page("tavern"));
    else location.reload();
  };
  const decline = async (i: HostedIncomingInvite) => {
    const res = await act.run(() => postJson("/invites/decline", { id: i.id }));
    if (!res) return;
    await refresh();
  };
  return (
    <div className="stack sz-tight">
      {incoming.map((i) => (
        <div key={i.id} className="callout callout--ok" role="status">
          <Icon name="party" />
          <div className="stack sz-tight">
            <strong>{i.vault ? `@${i.from} shared ${i.vault.fullName} with you` : `@${i.from} invited you to this Hippocampus`}</strong>
            <span className="small">
              {i.vault && i.role ? (
                <>
                  As a {v(...ROLE_WORDS[i.role].word).toLowerCase()} ({v(...ROLE_WORDS[i.role].help).replace(/\.$/, "").toLowerCase()}), named <span className="mono">{i.human}</span> in it.{" "}
                </>
              ) : null}
              Accepting lets you in right away. Expires <RelTime at={i.expires} />.
            </span>
            <span className="row">
              <button type="button" className="btn btn--sm btn--primary" disabled={act.busy} onClick={() => void accept(i)}>
                <Icon name="check" /> Accept
              </button>
              <button type="button" className="btn btn--sm btn--ghost" disabled={act.busy} onClick={() => void decline(i)}>
                Decline
              </button>
            </span>
          </div>
        </div>
      ))}
      {act.error !== undefined && <ErrorCallout error={act.error} />}
    </div>
  );
}

/** Inviting people to the app itself (no vault shared): links, open invites, and how many joined. */
export function AppInvitesPanel() {
  const invites = useResource<HostedInvites>("/invites");
  const [login, setLogin] = useState("");
  const [made, setMade] = useState<HostedNewInvite>();
  const act = useAction();
  const data = invites.data;
  const create = async () => {
    const to = login.trim().replace(/^@/, "");
    const problem = inviteProblem({ login: to, human: "x" });
    if (problem) return toast(problem, "error");
    const res = await act.run(() => postJson<HostedNewInvite>("/invites", to ? { login: to } : {}));
    if (!res) return;
    setMade(res);
    setLogin("");
    await refresh();
  };
  const revoke = async (id: string) => {
    if (!(await act.run(() => postJson("/invites/revoke", { id })))) return;
    await refresh();
  };
  return (
    <Panel title="Invite someone to Hippocampus" icon="link" id="invite">
      {invites.error && !data ? (
        <ErrorCallout error={invites.error} onRetry={() => void invites.reload()} />
      ) : !data ? (
        <SkeletonPanel lines={2} />
      ) : !data.canInvite ? (
        <Empty icon="link" title="You can't invite people right now">
          Invites open once your account is approved, unless an admin turned them off for you.
        </Empty>
      ) : (
        <div className="stack">
          <p className="small">
            An invite lets someone in without waiting for an admin, to set up vaults of their own. It shares nothing of yours. {data.accepted ? `${data.accepted} ${data.accepted === 1 ? "person has" : "people have"} joined on your invites.` : ""}
          </p>
          <form
            className="row hz-invite-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input className="input mono" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="GitHub username (optional)" aria-label="Their GitHub username (optional)" autoComplete="off" spellCheck={false} />
            <button type="submit" className="btn" disabled={act.busy || (data.limit !== undefined && data.sent.length >= data.limit)}>
              <Icon name="link" /> Create an invite link
            </button>
          </form>
          {data.limit !== undefined && data.sent.length >= data.limit && <p className="small muted">You have {data.limit} open invites, the most at once. Revoke one, or wait for them to be used.</p>}
          {made && (
            <div className="stack sz-tight">
              <p className="small">{made.invite.login ? `Only @${made.invite.login} can use it; they'll also see it when they sign in.` : "It works once, for whoever opens it first: send it privately."}</p>
              <CopyLine value={made.link} label="Invite link" />
            </div>
          )}
          {act.error !== undefined && <ErrorCallout error={act.error} />}
          {!!data.sent.length && (
            <ul className="hz-invites">
              {data.sent.map((i) => (
                <li key={i.id} className="row">
                  <span>
                    {i.login ? <strong>@{i.login}</strong> : "Anyone with the link"}
                    <span className="small muted">
                      {" "}
                      · sent <RelTime at={i.created} /> · expires <RelTime at={i.expires} />
                    </span>
                  </span>
                  <ToneTag tone="wait" word="Open" compact />
                  <button type="button" className="btn btn--sm btn--ghost" disabled={act.busy} onClick={() => void revoke(i.id)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}
