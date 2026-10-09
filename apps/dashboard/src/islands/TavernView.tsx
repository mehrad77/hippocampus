import { useResource } from "../lib/cache.ts";
import { emit } from "../lib/events.ts";
import { daysLeftLabel, fieldLabel, plural, relTime, shortDate, titleCase, urgency } from "../lib/format.ts";
import { href } from "../lib/routes.ts";
import type { Overview, QuestCard, SessionInfo } from "../lib/types.ts";
import { ActivityBars, StatusMeter } from "../ui/Charts.tsx";
import { ClockDial } from "../ui/ClockDial.tsx";
import { EntityLink } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Empty, Panel, RelTime, Runes, SkeletonPanel } from "../ui/Parts.tsx";
import { RichText } from "../ui/RichText.tsx";
import { QuestSeal } from "../ui/play/Bits.tsx";
import { Value } from "../ui/Value.tsx";

export default function TavernView() {
  return <PageGate>{(session) => <Tavern session={session} />}</PageGate>;
}

function Tavern({ session }: { session: SessionInfo }) {
  const { data: o, error } = useResource<Overview>("/overview", { poll: 60_000 });
  if (error && !o) return <div className="callout callout--danger">{error.message}</div>;
  if (!o)
    return (
      <div className="grid grid--main">
        <SkeletonPanel lines={8} />
        <SkeletonPanel lines={6} />
      </div>
    );
  const active = o.quests.filter((q) => q.status === "active" || q.status === "blocked");
  const needs = o.attention.disputes.length + o.attention.waiting.length + o.attention.unknownAgents.length;
  return (
    <div className="stack" style={{ ["--gap" as string]: "28px" }}>
      <header className="page-head">
        <div>
          <div className="page-head__kicker">Previously on {o.campaign}</div>
          <h1>The Tavern</h1>
          <p className="page-head__lede">
            {greeting(o, needs)} {o.lastSleep ? <>The curator last slept <RelTime at={o.lastSleep} />.</> : "The curator hasn't slept yet."}
          </p>
        </div>
        {session.capabilities.remember && (
          <button type="button" className="btn btn--primary" onClick={() => emit("scribe:open", {})}>
            <Icon name="quill" /> Scribe a memory
          </button>
        )}
      </header>

      <div className="stats">
        <Stat label="Open disputes" value={o.counts.disputes} note={o.counts.disputes ? "await your ruling" : "all settled"} href={href.page("council")} tone={o.counts.disputes ? "danger" : undefined} />
        <Stat label="In the satchel" value={o.counts.inbox} note="until the next sleep" href={href.page("satchel")} />
        <Stat label="Active quests" value={(o.counts.quests.active ?? 0) + (o.counts.quests.blocked ?? 0)} note={o.counts.quests.blocked ? `${o.counts.quests.blocked} blocked` : "none blocked"} href={href.page("quests")} />
        <Stat label="Canon facts" value={o.counts.facts.canon} note={`${o.counts.facts.rumor} rumors`} href={href.page("codex")} />
        <Stat label="Entities" value={o.counts.entities} note={`${Object.keys(o.counts.byType).length} kinds`} href={href.page("codex")} />
      </div>

      <div className="grid grid--main">
        <div className="stack" style={{ ["--gap" as string]: "24px" }}>
          <PreviouslyOn o={o} />
          <Panel title="Quest board" icon="quest" aside={<a href={href.page("quests")}>All quests →</a>}>
            {active.length ? (
              <div className="grid grid--2" style={{ ["--gap" as string]: "14px" }}>
                {active.slice(0, 4).map((q) => (
                  <QuestTile key={q.slug} q={q} />
                ))}
              </div>
            ) : (
              <Empty icon="quest" title="No quests in motion">
                Add a quest note in Obsidian, or ask your game master agent to post one.
              </Empty>
            )}
          </Panel>
          <Panel title="Activity" icon="hourglass" aside="last 30 days">
            <ActivityBars days={o.activity} />
          </Panel>
        </div>

        <div className="stack" style={{ ["--gap" as string]: "24px" }}>
          <Attention o={o} />
          <Upcoming o={o} />
          <Party o={o} />
          <Panel title="Fact ledger" icon="scroll">
            <StatusMeter facts={o.counts.facts} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function greeting(o: Overview, needs: number): string {
  if (o.counts.disputes) return `${plural(o.counts.disputes, "dispute")} await${o.counts.disputes === 1 ? "s" : ""} your ruling.`;
  if (needs) return "A few things need your eye.";
  return "All quiet at the table.";
}

function Stat({ label, value, note, href, tone }: { label: string; value: number; note?: string; href: string; tone?: "danger" }) {
  return (
    <a className={`stat${tone ? ` stat--${tone}` : ""}`} href={href}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value.toLocaleString("en")}</span>
      {note && <span className="stat__note">{note}</span>}
    </a>
  );
}

function PreviouslyOn({ o }: { o: Overview }) {
  const entries = [...o.chronicle].reverse().slice(0, 8);
  return (
    <Panel title="Previously on…" icon="chronicle" aside={<a href={href.page("chronicle")}>The whole chronicle →</a>}>
      {entries.length ? (
        <ol className="timeline">
          {entries.map((e) => (
            <li key={e.id} className={`timeline__item kind--${e.kind}`}>
              <div className="timeline__meta">
                <EntityLink entity={{ slug: e.agent, title: titleCase(e.agent), type: "party" }} />
                <span className="chip">{e.kind}</span>
                <RelTime at={e.at} className="muted small" />
              </div>
              <RichText text={e.text} />
              {e.touched.length > 0 && (
                <div className="timeline__touched small muted">
                  ↳{" "}
                  {e.touched.map((t, i) => (
                    <span key={t}>
                      {i > 0 && " · "}
                      <a href={href.entity(t)}>{t}</a>
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <Empty icon="chronicle" title="The chronicle is blank">
          Episodes land here after each sleep consolidates the inbox.
        </Empty>
      )}
    </Panel>
  );
}

function QuestTile({ q }: { q: QuestCard }) {
  const done = q.objectives.filter((x) => x.done).length;
  const u = urgency(q.daysLeft);
  return (
    <a className={`quest-tile quest-tile--${q.status}`} href={href.entity(q.slug)}>
      <div className="row" style={{ ["--gap" as string]: "8px", justifyContent: "space-between" }}>
        <strong className="quest-tile__title">{q.title}</strong>
        {q.status === "blocked" && <QuestSeal status="blocked" />}
      </div>
      <div className="row small muted">
        {q.owner && <span>{q.owner.title}</span>}
        {q.deadline && <span className={`due due--${u}`}>· due {daysLeftLabel(q.daysLeft)}</span>}
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="row small">
          <Runes done={done} total={q.objectives.length} /> {done}/{q.objectives.length}
        </span>
        {q.clocks[0] && <ClockDial name={q.clocks[0].name} segments={q.clocks[0].segments} filled={q.clocks[0].filled} size={34} />}
      </div>
    </a>
  );
}

function Attention({ o }: { o: Overview }) {
  const a = o.attention;
  const items: { icon: "council" | "warn" | "hourglass" | "party" | "eye"; tone: string; title: React.ReactNode; detail: React.ReactNode; href: string }[] = [
    ...a.disputes.map((d) => ({
      icon: "council" as const,
      tone: "danger",
      title: (
        <>
          {d.entity.title} · {fieldLabel(d.field)}
        </>
      ),
      detail: d.claims.map((c, i) => (
        <span key={i}>
          {i > 0 && " vs "}
          <Value shown={c} /> <span className="muted">({c.by})</span>
        </span>
      )),
      href: href.page("council", `#${d.slug}`),
    })),
    ...a.waiting.map((e) => ({
      icon: "hourglass" as const,
      tone: "warn",
      title: <>An episode from {e.agent} sat through a sleep</>,
      detail: e.text ?? "Sealed (secret-bearing).",
      href: href.page("satchel", `#${e.id}`),
    })),
    ...a.unknownAgents.map((agent) => ({
      icon: "party" as const,
      tone: "warn",
      title: <>Unknown agent “{agent}”</>,
      detail: "Writes to the inbox without a party note, so its word counts as rumor.",
      href: href.page("party", "#strangers"),
    })),
    ...a.rumors.slice(0, 3).map((r) => ({
      icon: "eye" as const,
      tone: "info",
      title: (
        <>
          Rumor: {r.ref.title} · {fieldLabel(r.field)}
        </>
      ),
      detail: (
        <>
          <Value shown={r} /> <span className="muted">reported by {r.by}</span>
        </>
      ),
      href: href.entity(r.ref.slug),
    })),
    ...a.stale.slice(0, 2).map((r) => ({
      icon: "warn" as const,
      tone: "info",
      title: (
        <>
          Stale: {r.ref.title} · {fieldLabel(r.field)}
        </>
      ),
      detail: <>last confirmed {relTime(r.at)}</>,
      href: href.entity(r.ref.slug),
    })),
  ];
  return (
    <Panel title="Needs your eye" icon="eye" aside={items.length ? plural(items.length, "item") : undefined}>
      {items.length ? (
        <ul className="list attention">
          {items.slice(0, 8).map((it, i) => (
            <li key={i}>
              <a className={`attention__item tone--${it.tone}`} href={it.href}>
                <Icon name={it.icon} />
                <span>
                  <strong>{it.title}</strong>
                  <span className="small">{it.detail}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="check" title="Nothing needs you">
          No disputes, no stragglers. Enjoy the quiet.
        </Empty>
      )}
    </Panel>
  );
}

function Upcoming({ o }: { o: Overview }) {
  if (!o.upcoming.length) return null;
  return (
    <Panel title="On the horizon" icon="clock">
      <ul className="list">
        {o.upcoming.slice(0, 6).map((u, i) => (
          <li key={i} className="horizon">
            <span className={`horizon__when due due--${urgency(u.daysLeft)}`}>
              <strong>{shortDate(u.date, { year: false })}</strong>
              <span className="small">{daysLeftLabel(u.daysLeft)}</span>
            </span>
            <span>
              <EntityLink entity={u.ref} />
              <span className="small muted"> · {fieldLabel(u.what)}</span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Party({ o }: { o: Overview }) {
  return (
    <Panel title="The party" icon="party" aside={<a href={href.page("party")}>Sheets →</a>}>
      <ul className="list">
        {o.party.map((p) => (
          <li key={p.slug} className="row" style={{ justifyContent: "space-between" }}>
            <EntityLink entity={p} />
            <span className="small muted">
              {p.pending ? `${p.pending} waiting · ` : ""}
              {p.lastSeen ? <RelTime at={p.lastSeen} /> : "not seen yet"}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
