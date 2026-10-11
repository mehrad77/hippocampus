import { useResource } from "../lib/cache.ts";
import { emit } from "../lib/events.ts";
import { daysLeftLabel, fieldLabel, plural, relTime, shortDate, titleCase, urgency } from "../lib/format.ts";
import { useTerms, type Voice } from "../lib/prefs.ts";
import { href } from "../lib/routes.ts";
import type { GoalCard, Overview, SessionInfo } from "../lib/types.ts";
import { ActivityBars, StatusMeter } from "../ui/Charts.tsx";
import { EntityLink } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Empty, Panel, RelTime, Runes, SkeletonPanel } from "../ui/Parts.tsx";
import { RichText } from "../ui/RichText.tsx";
import { ProgressBar } from "../ui/ProgressBar.tsx";
import { GoalSeal } from "../ui/play/Bits.tsx";
import { goalsOf, kindLabel } from "../ui/play/model.ts";
import { Value } from "../ui/Value.tsx";

export default function TavernView() {
  return <PageGate>{(session) => <Tavern session={session} />}</PageGate>;
}

function Tavern({ session }: { session: SessionInfo }) {
  const voice = useTerms();
  const { t, v } = voice;
  const { data: o, error } = useResource<Overview>("/overview", { poll: 60_000 });
  if (error && !o) return <div className="callout callout--danger">{error.message}</div>;
  if (!o)
    return (
      <div className="grid grid--main">
        <SkeletonPanel lines={8} />
        <SkeletonPanel lines={6} />
      </div>
    );
  const active = goalsOf(o).filter((g) => (g.state ?? g.status) === "active" || (g.state ?? g.status) === "blocked");
  const goals = o.counts.goals ?? o.counts.quests;
  const name = o.name ?? o.campaign;
  const needs = o.attention.disputes.length + o.attention.waiting.length + o.attention.introductions.length + o.attention.unknownAgents.length + (o.attention.overdue?.length ?? 0);
  return (
    <div className="stack" style={{ ["--gap" as string]: "28px" }}>
      <header className="page-head">
        <div>
          <div className="page-head__kicker">{v(name, `Previously on ${name}`)}</div>
          <h1>{v("Home", "The Tavern")}</h1>
          <p className="page-head__lede">
            {greeting(o, needs, voice)}{" "}
            {o.lastSleep ? (
              <>
                {v("Last nightly update", "The curator last slept")} <RelTime at={o.lastSleep} />.
              </>
            ) : (
              v("No nightly update has run yet.", "The curator hasn't slept yet.")
            )}
          </p>
        </div>
        {session.capabilities.remember && (
          <button type="button" className="btn btn--primary" onClick={() => emit("scribe:open", {})}>
            <Icon name="quill" /> {t("scribe")}
          </button>
        )}
      </header>

      <div className="stats">
        <Stat label="Open disputes" value={o.counts.disputes} note={o.counts.disputes ? v("need your decision", "await your ruling") : v("none open", "all settled")} href={href.page("council")} tone={o.counts.disputes ? "danger" : undefined} />
        <Stat label={v("In the inbox", "In the satchel")} value={o.counts.inbox} note={v("until the nightly update", "until the next sleep")} href={href.page("satchel")} />
        <Stat label={v("Active goals", "Active quests")} value={(goals.active ?? 0) + (goals.blocked ?? 0)} note={goals.blocked ? `${goals.blocked} blocked` : "none blocked"} href={href.page("goals")} />
        <Stat label={v("Confirmed facts", "Canon facts")} value={o.counts.facts.canon} note={v(`${o.counts.facts.rumor} unverified`, `${o.counts.facts.rumor} rumors`)} href={href.page("codex")} />
        <Stat label={v("Records", "Entities")} value={o.counts.entities} note={`${Object.keys(o.counts.byType).length} kinds`} href={href.page("codex")} />
      </div>

      <div className="grid grid--main">
        <div className="stack" style={{ ["--gap" as string]: "24px" }}>
          <PreviouslyOn o={o} voice={voice} />
          <Panel title={t("goals")} icon="quest" aside={<a href={href.page("goals")}>{v("All goals →", "All quests →")}</a>}>
            {active.length ? (
              <div className="grid grid--2" style={{ ["--gap" as string]: "14px" }}>
                {active.slice(0, 4).map((g) => (
                  <GoalTile key={g.slug} g={g} />
                ))}
              </div>
            ) : (
              <Empty icon="quest" title={v("No active goals", "No quests in motion")}>
                {v("Add a goal note (goals/ folder) in Obsidian, or ask an agent to create one.", "Add a goal note in Obsidian, or ask an agent to post one.")}
              </Empty>
            )}
          </Panel>
          <Panel title="Activity" icon="hourglass" aside="last 30 days">
            <ActivityBars days={o.activity} />
          </Panel>
        </div>

        <div className="stack" style={{ ["--gap" as string]: "24px" }}>
          <Attention o={o} voice={voice} />
          <Upcoming o={o} voice={voice} />
          <Party o={o} voice={voice} />
          <Panel title={v("Facts by status", "Fact ledger")} icon="scroll">
            <StatusMeter facts={o.counts.facts} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function greeting(o: Overview, needs: number, { v }: Voice): string {
  const n = o.attention.disputes.filter((d) => d.kind === "conflict").length;
  const asks = o.attention.disputes.length - n;
  if (n) return v(`${plural(n, "dispute")} need${n === 1 ? "s" : ""} your decision.`, `${plural(n, "dispute")} await${n === 1 ? "s" : ""} your ruling.`);
  if (asks) return v(`${plural(asks, "suggestion")} wait${asks === 1 ? "s" : ""} for your decision.`, `${plural(asks, "petition")} await${asks === 1 ? "s" : ""} your word.`);
  if (needs) return v("A few things need your attention.", "A few things need your eye.");
  return v("Nothing needs your attention.", "All quiet at the table.");
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

function PreviouslyOn({ o, voice: { v, look } }: { o: Overview; voice: Voice }) {
  const entries = [...o.chronicle].reverse().slice(0, 8);
  return (
    <Panel title={v("Recent activity", "Previously on…")} icon="chronicle" aside={<a href={href.page("chronicle")}>{v("Full timeline →", "The whole chronicle →")}</a>}>
      {entries.length ? (
        <ol className="timeline">
          {entries.map((e) => (
            <li key={e.id} className={`timeline__item kind--${e.kind}`}>
              <div className="timeline__meta">
                <EntityLink entity={{ slug: e.agent, title: titleCase(e.agent), type: "party" }} />
                <span className="chip">{kindLabel(e.kind, o.schema?.kinds, look)}</span>
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
        <Empty icon="chronicle" title={v("No activity yet", "The chronicle is blank")}>
          {v("Notes from your agents appear here after each nightly update processes the inbox.", "Episodes land here after each sleep consolidates the inbox.")}
        </Empty>
      )}
    </Panel>
  );
}

function GoalTile({ g }: { g: GoalCard }) {
  const done = g.objectives.filter((x) => x.done).length;
  const u = urgency(g.daysLeft);
  const state = g.state ?? g.status ?? "active";
  const due = g.nextDue ?? g.due ?? g.deadline;
  return (
    <a className={`quest-tile quest-tile--${state}`} href={href.entity(g.slug)}>
      <div className="row" style={{ ["--gap" as string]: "8px", justifyContent: "space-between" }}>
        <strong className="quest-tile__title">{g.title}</strong>
        {(state === "blocked" || (g.word && g.word !== state)) && <GoalSeal status={state} word={g.word} />}
      </div>
      <div className="row small muted">
        {g.owner && <span>{g.owner.title}</span>}
        {g.counterparty && <span>· with {g.counterparty.title}</span>}
        {due && <span className={`due due--${u}`}>· due {daysLeftLabel(g.daysLeft)}</span>}
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        {g.objectives.length > 0 ? (
          <span className="row small">
            <Runes done={done} total={g.objectives.length} /> {done}/{g.objectives.length}
          </span>
        ) : (
          <span />
        )}
        {g.progress && <ProgressBar name={g.title} done={g.progress.done} total={g.progress.total} size="sm" />}
      </div>
    </a>
  );
}

function Attention({ o, voice: { t, v } }: { o: Overview; voice: Voice }) {
  const a = o.attention;
  const items: { icon: "council" | "warn" | "hourglass" | "party" | "eye" | "clock"; tone: string; title: React.ReactNode; detail: React.ReactNode; href: string }[] = [
    ...a.disputes
      .filter((d) => d.kind === "conflict")
      .map((d) => ({
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
    // Suggestions for fields only a person sets, and notes that may be the same thing.
    ...a.disputes
      .filter((d) => d.kind !== "conflict")
      .map((d) => ({
        icon: "council" as const,
        tone: "warn",
        title:
          d.kind === "merge" ? (
            <>
              {v("Possible duplicate", "Two entries, one soul?")}: {(d.targets ?? [d.entity]).map((r) => r.title).join(" · ")}
            </>
          ) : (
            <>
              {v("Suggestion", "Petition")}: {d.entity.title} · {fieldLabel(d.field)}
            </>
          ),
        detail:
          d.kind === "merge" ? (
            (d.evidence ?? v("They share an identifying detail.", "They share a mark."))
          ) : (
            <>
              {d.claims.at(-1) ? <Value shown={d.claims.at(-1)!} /> : null} <span className="muted">({d.claims.at(-1)?.by ?? "?"} · {v("only a person sets this", "a player's call")})</span>
            </>
          ),
        href: href.page("council", `#${d.slug}`),
      })),
    ...(a.overdue ?? []).map((c) => ({
      icon: "clock" as const,
      tone: "warn",
      title: v(<>Time to get in touch with {c.ref.title}</>, <>{c.ref.title} hasn't heard from you</>),
      detail: (
        <>
          {v("last contact", "last met")} {shortDate(c.lastContact)} · every {c.cadence} · {plural(c.daysOverdue, "day")} overdue
          {c.group ? ` · ${c.group.title}` : ""}
        </>
      ),
      href: href.entity(c.ref.slug),
    })),
    ...a.waiting.map((e) => ({
      icon: "hourglass" as const,
      tone: "warn",
      title: v(<>A note from {e.agent} wasn't processed by the last nightly update</>, <>An episode from {e.agent} sat through a sleep</>),
      detail: e.text ?? v("Hidden (contains a secret).", "Sealed (secret-bearing)."),
      href: href.page("satchel", `#${e.id}`),
    })),
    ...a.introductions.map((i) => ({
      icon: "party" as const,
      tone: "warn",
      title: v(<>{i.title} asks to join as an agent</>, <>{i.title} knocks at the door</>),
      // The agent's own words: plain text.
      detail: i.lane ?? v("Waiting for your approval.", "Awaits your word."),
      href: href.page("party", "#introductions"),
    })),
    ...a.unknownAgents.map((agent) => ({
      icon: "party" as const,
      tone: "warn",
      title: <>Unknown agent “{agent}”</>,
      detail: v("Sends notes but isn't set up as an agent, so its facts stay unverified.", "Writes to the inbox without a party note, so its word counts as rumor."),
      href: href.page("party", "#strangers"),
    })),
    ...a.rumors.slice(0, 3).map((r) => ({
      icon: "eye" as const,
      tone: "info",
      title: (
        <>
          {t("rumor")}: {r.ref.title} · {fieldLabel(r.field)}
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
          {v("Needs re-checking", "Stale")}: {r.ref.title} · {fieldLabel(r.field)}
        </>
      ),
      detail: <>last confirmed {relTime(r.at)}</>,
      href: href.entity(r.ref.slug),
    })),
  ];
  return (
    <Panel title={v("Needs your attention", "Needs your eye")} icon="eye" aside={items.length ? plural(items.length, "item") : undefined}>
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
        <Empty icon="check" title={v("All clear", "Nothing needs you")}>
          {v("No disputes and no unprocessed notes.", "No disputes, no stragglers. Enjoy the quiet.")}
        </Empty>
      )}
    </Panel>
  );
}

function Upcoming({ o, voice: { v } }: { o: Overview; voice: Voice }) {
  if (!o.upcoming.length) return null;
  return (
    <Panel title={v("Coming up", "On the horizon")} icon="clock">
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

function Party({ o, voice: { t, v } }: { o: Overview; voice: Voice }) {
  return (
    <Panel title={v(t("party"), "The party")} icon="party" aside={<a href={href.page("party")}>{v("Details →", "Sheets →")}</a>}>
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
