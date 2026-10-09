import { useEffect } from "react";
import { BASE, href } from "../lib/routes.ts";
import { useSession } from "../lib/session.ts";
import type { SessionInfo } from "../lib/types.ts";
import { Icon } from "./Icon.tsx";
import { SkeletonPanel } from "./Parts.tsx";

/**
 * Every data page starts here: wait for the session, send a vault-less install to Session Zero,
 * and show the right door when this browser isn't signed in.
 */
export function PageGate({ children, allowSetup }: { children: (session: SessionInfo) => React.ReactNode; allowSetup?: boolean }) {
  const session = useSession();
  const toSetup = !!session.data && session.data.mode === "setup" && !allowSetup;
  useEffect(() => {
    if (toSetup) location.replace(href.page("setup"));
  }, [toSetup]);

  if (session.error?.status === 401) return <SignInDoor code={session.error.code} message={session.error.message} />;
  if (session.error && !session.data) return <ServerTrouble message={session.error.message} status={session.error.status} />;
  if (!session.data || toSetup) return <SkeletonPanel lines={6} />;
  return <>{children(session.data)}</>;
}

function SignInDoor({ code, message }: { code: string; message: string }) {
  const local = code === "LOCAL_TOKEN";
  const login = `${BASE}/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`;
  return (
    <div className="door panel">
      <Icon name={local ? "key" : "lock"} size={40} />
      <h1>{local ? "Knock twice" : "The vault is sealed"}</h1>
      {local ? (
        <>
          <p>This dashboard only opens for the browser that started it.</p>
          <p className="muted">
            Open the link that <code>hippo dashboard</code> printed in your terminal (it carries a one-time key), or run it again to get a fresh one.
          </p>
        </>
      ) : (
        <>
          <p>Sign in with the GitHub account that owns this vault.</p>
          <a className="btn btn--primary" href={login}>
            <Icon name="github" /> Sign in with GitHub
          </a>
          <p className="muted small">{message}</p>
        </>
      )}
      <p className="small">
        New here? Read <a href={href.guide("how-it-works")}>how Hippocampus works</a>.
      </p>
    </div>
  );
}

function ServerTrouble({ message, status }: { message: string; status: number }) {
  return (
    <div className="callout callout--danger" role="alert">
      <Icon name="warn" />
      <div>
        <strong>The dashboard can't reach its vault{status ? ` (${status})` : ""}.</strong>
        <div>{message}</div>
        <div className="small muted">
          If the vault isn't set up yet, start <a href={href.page("setup")}>Session Zero</a>.
        </div>
      </div>
    </div>
  );
}
