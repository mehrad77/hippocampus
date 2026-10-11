import { useEffect, useState } from "react";
import type { HostedIncomingInvite, HostedVault } from "@hippocampus/dashboard";
import { ApiError, postJson } from "../lib/api.ts";
import { clearCache } from "../lib/cache.ts";
import { useTerms } from "../lib/prefs.ts";
import { href } from "../lib/routes.ts";
import { switchVault } from "../lib/vault.ts";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { RelTime, SkeletonPanel } from "../ui/Parts.tsx";
import { ErrorCallout, useAction } from "./setup/common.tsx";
import { ROLE_WORDS } from "./setup/hosted.ts";

const KEY = "hippo:invite";

/**
 * The page an invite link opens (`/dashboard/invite/#<token>`). The token lives in the fragment, so it
 * never reaches a server log; it's kept in this tab while the person signs in, then taken off the address.
 */
function takeToken(): string | undefined {
  const fromHash = location.hash.slice(1);
  try {
    if (fromHash.startsWith("hinv_")) sessionStorage.setItem(KEY, fromHash);
    if (fromHash) history.replaceState(null, "", location.pathname);
    return sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return fromHash.startsWith("hinv_") ? fromHash : undefined;
  }
}

const forget = () => {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage off: nothing was kept.
  }
};

export default function InviteView() {
  const [token] = useState(takeToken);
  return <PageGate allowSetup>{() => (token ? <Invite token={token} /> : <NoInvite />)}</PageGate>;
}

function NoInvite() {
  return (
    <div className="door panel">
      <Icon name="link" size={40} />
      <h1>No invite here</h1>
      <p>Open the invite link you were sent. It looks like this page's address with a long code after a #.</p>
      <a className="btn" href={href.page("setup")}>
        To setup
      </a>
    </div>
  );
}

function Invite({ token }: { token: string }) {
  const { v } = useTerms();
  const [invite, setInvite] = useState<HostedIncomingInvite>();
  const [gone, setGone] = useState<string>();
  const peek = useAction();
  const accept = useAction();

  useEffect(() => {
    void (async () => {
      try {
        setInvite(await postJson<HostedIncomingInvite>("/invites/peek", { token }));
      } catch (err) {
        if (err instanceof ApiError && err.status === 410) {
          forget();
          setGone(err.message);
        } else void peek.run(() => Promise.reject(err));
      }
    })();
  }, [token]);

  if (gone)
    return (
      <div className="door panel">
        <Icon name="warn" size={40} />
        <h1>This invite can't be used</h1>
        <p>{gone}</p>
        <a className="btn" href={href.page("setup")}>
          To setup
        </a>
      </div>
    );
  if (peek.error !== undefined) return <ErrorCallout error={peek.error} />;
  if (!invite) return <SkeletonPanel lines={4} />;

  const go = async () => {
    const res = await accept.run(() => postJson<{ vault?: HostedVault }>("/invites/accept", { token }));
    if (!res) return;
    forget();
    clearCache();
    if (res.vault) switchVault(res.vault.id, href.page("tavern"));
    else location.assign(href.page("setup"));
  };

  return (
    <div className="door panel hz-invite">
      <Icon name="party" size={40} />
      <h1>{invite.vault ? `@${invite.from} shared a vault with you` : `@${invite.from} invited you to Hippocampus`}</h1>
      {invite.vault ? (
        <>
          <p>
            <strong className="mono">{invite.vault.fullName}</strong>: you'd be <span className="mono">{invite.human}</span> in it, as a{" "}
            {invite.role ? v(...ROLE_WORDS[invite.role].word).toLowerCase() : "member"}.
          </p>
          {invite.role && <p className="small muted">{v(...ROLE_WORDS[invite.role].help)}</p>}
        </>
      ) : (
        <p>Accepting lets you in right away, to set up a vault of your own. Nothing of theirs is shared.</p>
      )}
      {invite.login && <p className="small muted">This invite is for @{invite.login} only.</p>}
      <p className="small muted">
        It expires <RelTime at={invite.expires} />.
      </p>
      {accept.error !== undefined && <ErrorCallout error={accept.error} />}
      <div className="row">
        <button type="button" className="btn btn--primary" onClick={() => void go()} disabled={accept.busy}>
          <Icon name="check" /> {accept.busy ? "Accepting…" : "Accept"}
        </button>
        <a
          className="btn btn--ghost"
          href={href.page("setup")}
          onClick={() => {
            forget();
          }}
        >
          Not now
        </a>
      </div>
    </div>
  );
}
