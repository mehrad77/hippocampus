import { useEffect, useState } from "react";
import type { HostedDeviceRequest } from "@hippocampus/dashboard";
import { ACCESS } from "@hippocampus/dashboard/connect";
import { ApiError, getJson, postJson } from "../lib/api.ts";
import { href } from "../lib/routes.ts";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { RelTime, SkeletonPanel } from "../ui/Parts.tsx";
import { ErrorCallout, Field, useAction } from "./setup/common.tsx";

const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

/**
 * Device sign-in's approval page (`/dashboard/connect/?code=…`): an app or agent asked to connect on
 * the person's behalf; they choose the vault, or refuse. What it may do is what it asked for, and the
 * agents in it name themselves.
 */
export default function ConnectApprove() {
  return <PageGate allowSetup>{() => <Approve />}</PageGate>;
}

function Approve() {
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("code")?.toUpperCase() ?? "");
  const [typed, setTyped] = useState("");
  if (!code)
    return (
      <div className="door panel">
        <Icon name="link" size={40} />
        <h1>Connect an app</h1>
        <p>Type the code the app or agent showed you.</p>
        <form
          className="row hz-invite-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (CODE.test(typed.trim().toUpperCase())) setCode(typed.trim().toUpperCase());
          }}
        >
          <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="BCDF-GHJK" aria-label="The code" autoComplete="off" spellCheck={false} />
          <button type="submit" className="btn btn--primary" disabled={!CODE.test(typed.trim().toUpperCase())}>
            Continue
          </button>
        </form>
      </div>
    );
  return <Request code={code} />;
}

function Request({ code }: { code: string }) {
  const [req, setReq] = useState<HostedDeviceRequest>();
  const [gone, setGone] = useState<string>();
  const [vault, setVault] = useState("");
  const [done, setDone] = useState<"approved" | "denied">();
  const load = useAction();
  const act = useAction();

  useEffect(() => {
    void (async () => {
      try {
        const r = await getJson<HostedDeviceRequest>(`/connect?code=${encodeURIComponent(code)}`);
        setReq(r);
        setVault(r.current ?? r.vaults[0]?.id ?? "");
      } catch (err) {
        if (err instanceof ApiError && err.status === 410) setGone(err.message);
        else void load.run(() => Promise.reject(err));
      }
    })();
  }, [code]);

  if (done)
    return (
      <div className="door panel">
        <Icon name={done === "approved" ? "check" : "close"} size={40} />
        <h1>{done === "approved" ? "Approved" : "Refused"}</h1>
        <p>{done === "approved" ? "Go back to the app: it picks up its key by itself within a few seconds. You'll find it under Connected apps." : "The app was told no. Nothing was connected."}</p>
        <a className="btn" href={href.page("setup", "#connections")}>
          To Connected apps
        </a>
      </div>
    );
  if (gone)
    return (
      <div className="door panel">
        <Icon name="warn" size={40} />
        <h1>This code can't be used</h1>
        <p>{gone}</p>
      </div>
    );
  if (load.error !== undefined) return <ErrorCallout error={load.error} />;
  if (!req) return <SkeletonPanel lines={5} />;

  const picked = req.vaults.find((x) => x.id === vault);
  const access = req.access ?? "remember";
  const answer = async (approve: boolean) => {
    const res = await act.run(() => (approve ? postJson("/connect/approve", { code: req.code, vault }) : postJson("/connect/deny", { code: req.code })));
    if (res) setDone(approve ? "approved" : "denied");
  };

  return (
    <div className="panel hz-approve stack">
      <div className="row">
        <Icon name="link" size={28} />
        <h1>
          <strong>{req.client}</strong> wants to connect
        </h1>
      </div>
      <p className="small muted">
        Code <span className="mono">{req.code}</span>. Check it's the one the app shows. Its name isn't verified: approve only an app you just started connecting. Expires <RelTime at={req.expires} />.
      </p>
      {!req.vaults.length ? (
        <p>You don't have a vault you can connect apps to yet. <a href={href.page("setup")}>Set one up</a>.</p>
      ) : (
        <>
          <Field label="To which vault" hint="One vault per connection; it can't reach the others.">
            {(f) => (
              <select id={f.id} className="input" value={vault} onChange={(e) => setVault(e.target.value)} aria-describedby={f.describedBy}>
                {req.vaults.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.fullName}
                    {x.role && x.role !== "owner" ? " (shared with you)" : ""}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <p className="small">
            It asked to <strong>{ACCESS[access].title.toLowerCase()}</strong>. {ACCESS[access].help} {access === "curate" ? "" : "The agents in it name themselves, and join your Agents page with no authority until you give them some."}
          </p>
          {access === "curate" && (
            <div className="callout callout--warn" role="note">
              <Icon name="lock" />
              <div>
                <strong>The curator sees secret memories.</strong> Approve it only for a bot that only curates, with an AI provider you trust with your secrets.
                {picked && picked.role !== "owner" ? " Only this vault's owner can approve that." : ""}
              </div>
            </div>
          )}
        </>
      )}
      {act.error !== undefined && <ErrorCallout error={act.error} />}
      <div className="row">
        <button type="button" className="btn btn--primary" disabled={act.busy || !picked || (access === "curate" && picked.role !== "owner")} onClick={() => void answer(true)}>
          <Icon name="check" /> Approve
        </button>
        <button type="button" className="btn btn--ghost" disabled={act.busy} onClick={() => void answer(false)}>
          Refuse
        </button>
      </div>
    </div>
  );
}
