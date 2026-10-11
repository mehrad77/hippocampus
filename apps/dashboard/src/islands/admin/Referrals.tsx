import { useMemo, useState } from "react";
import type { AdminReferrals } from "@hippocampus/dashboard";
import { postJson } from "../../lib/api.ts";
import { invalidate, useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { around, layoutReferrals, referralGraph, topInviters, type PlacedPerson, type ReferralGraph } from "../../lib/referrals.ts";
import { trimSegment } from "../../lib/graph.ts";
import { Empty, Panel, RelTime, SkeletonPanel } from "../../ui/Parts.tsx";
import { ErrorCallout, TabPanel, Tabs, ToneTag, useAction } from "../setup/common.tsx";
import type { BadgeState } from "../setup/model.ts";

const W = 720;
const H = 420;

const STATUS: Record<PlacedPerson["status"], { tone: BadgeState; word: string }> = {
  approved: { tone: "done", word: "Approved" },
  waitlisted: { tone: "wait", word: "Waiting" },
  denied: { tone: "error", word: "Denied" },
  deleted: { tone: "na", word: "Deleted" },
};

const VIEWS = [
  ["graph", "Graph"],
  ["table", "Table"],
] as const;

/** Who invited whom: a graph of people and the invites they accepted, a table of inviters, and stopping someone's invites. */
export function Referrals() {
  const data = useResource<AdminReferrals>("/admin/referrals");
  const [view, setView] = useState<"graph" | "table">("graph");
  const graph = useMemo(() => (data.data ? referralGraph(data.data) : undefined), [data.data]);
  return (
    <Panel title="Referrals" icon="party" id="referrals">
      {data.error && !data.data ? (
        <ErrorCallout error={data.error} onRetry={() => void data.reload()} />
      ) : !graph || !data.data ? (
        <SkeletonPanel lines={4} />
      ) : !graph.edges.length ? (
        <Empty icon="party" title="No invites accepted yet">
          When someone accepts an invite (to the app or to a vault), who brought them in shows here.
        </Empty>
      ) : (
        <div className="stack">
          <p className="small muted">
            {graph.edges.length} accepted {graph.edges.length === 1 ? "invite" : "invites"} among {graph.nodes.length} people. Logins and states only.
          </p>
          <Tabs tabs={VIEWS} value={view} onChange={setView} label="Referrals as" idBase="hz-ref" />
          <TabPanel idBase="hz-ref" id={view}>
            {view === "graph" ? <ReferralMap graph={graph} /> : <ReferralTable graph={graph} people={data.data.people} />}
          </TabPanel>
        </div>
      )}
    </Panel>
  );
}

function ReferralMap({ graph }: { graph: ReferralGraph }) {
  const { people, view } = useMemo(() => layoutReferrals(graph, W, H), [graph]);
  const [picked, setPicked] = useState<string>();
  const at = new Map(people.map((p) => [p.user, p]));
  const screen = (p: PlacedPerson) => [p.x * view.k + view.x, p.y * view.k + view.y] as const;
  const near = picked ? around(graph, picked) : undefined;
  const focus = picked ? new Set([picked, ...(near?.by ? [near.by.user] : []), ...(near?.brought.map((b) => b.person.user) ?? [])]) : undefined;
  return (
    <div className="hz-refmap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Referral graph: ${graph.nodes.length} people, ${graph.edges.length} invites. Arrows point from who invited to who joined.`}>
        <defs>
          <marker id="hz-ref-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="hz-refmap__head" />
          </marker>
        </defs>
        {graph.edges.map((e) => {
          const a = at.get(e.from);
          const b = at.get(e.to);
          if (!a || !b) return null;
          const [x1, y1] = screen(a);
          const [x2, y2] = screen(b);
          const [sx, sy, tx, ty] = trimSegment(x1, y1, x2, y2, a.r * view.k + 2, b.r * view.k + 4);
          const dim = focus && !(focus.has(e.from) && focus.has(e.to));
          return <line key={e.key} x1={sx} y1={sy} x2={tx} y2={ty} className={`hz-refmap__edge${dim ? " is-dim" : ""}`} markerEnd="url(#hz-ref-arrow)" />;
        })}
        {people.map((p) => {
          const [x, y] = screen(p);
          const dim = focus && !focus.has(p.user);
          return (
            <g
              key={p.user}
              className={`hz-refmap__node hz-refmap__node--${p.status}${dim ? " is-dim" : ""}${p.user === picked ? " is-picked" : ""}`}
              transform={`translate(${x} ${y})`}
              tabIndex={0}
              role="button"
              aria-label={`@${p.login}, ${STATUS[p.status].word.toLowerCase()}, invited ${p.invited}`}
              aria-pressed={p.user === picked}
              onClick={() => setPicked(p.user === picked ? undefined : p.user)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  setPicked(p.user === picked ? undefined : p.user);
                }
              }}
            >
              <circle r={p.r * view.k} />
              <text y={p.r * view.k + 14}>@{p.login}</text>
            </g>
          );
        })}
      </svg>
      <div className="hz-refmap__legend small">
        {(["approved", "waitlisted", "denied"] as const).map((s) => (
          <ToneTag key={s} tone={STATUS[s].tone} word={STATUS[s].word} compact />
        ))}
        <span className="muted">Bigger: brought in more people. Arrows run from who invited to who joined.</span>
      </div>
      {picked && near && (
        <div className="hz-refmap__about" aria-live="polite">
          <strong>@{at.get(picked)?.login}</strong>{" "}
          {near.by ? (
            <>
              joined on @{near.by.login}'s invite, <RelTime at={near.at!} />.
            </>
          ) : (
            "wasn't invited by anyone here."
          )}{" "}
          {near.brought.length ? <>Brought in {near.brought.map((b) => `@${b.person.login}`).join(", ")}.</> : "Hasn't brought anyone in."}
        </div>
      )}
    </div>
  );
}

function ReferralTable({ graph, people }: { graph: ReferralGraph; people: AdminReferrals["people"] }) {
  const act = useAction();
  const logins = new Map(people.map((p) => [p.user, p.login]));
  const allow = async (user: string, value: boolean) => {
    const res = await act.run(() => postJson("/admin/referrals/invites", { user, allow: value }));
    if (!res) return;
    toast(value ? `@${logins.get(user)} can invite people again.` : `@${logins.get(user)} can't invite people anymore. Invites they already sent still work.`, "ok");
    await invalidate((k) => k.startsWith("/admin/referrals"));
  };
  const inviters = topInviters(graph);
  return (
    <div className="stack">
      {act.error !== undefined && <ErrorCallout error={act.error} />}
      <div className="table-wrap">
        <table className="table hz-rtable">
          <thead>
            <tr>
              <th scope="col">Inviter</th>
              <th scope="col">Brought in</th>
              <th scope="col">Invited by</th>
              <th scope="col">Invites</th>
            </tr>
          </thead>
          <tbody>
            {inviters.map((n) => (
              <tr key={n.user}>
                <td data-label="Inviter">
                  <strong>@{n.login}</strong>
                </td>
                <td data-label="Brought in">
                  {n.invited}: {around(graph, n.user).brought.map((b) => `@${b.person.login}`).join(", ")}
                </td>
                <td data-label="Invited by">{n.invitedBy ? `@${logins.get(n.invitedBy) ?? "?"}` : <span className="muted">nobody</span>}</td>
                <td data-label="Invites">
                  <button type="button" className="btn btn--sm" disabled={act.busy} onClick={() => void allow(n.user, !n.canInvite)} aria-label={`${n.canInvite ? "Stop" : "Allow"} invites from @${n.login}`}>
                    {n.canInvite ? "Stop invites" : "Allow invites"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
