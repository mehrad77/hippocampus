import { useEffect, useMemo, useRef, useState } from "react";
import "../styles/lore.css";
import { useResource } from "../lib/cache.ts";
import { plural } from "../lib/format.ts";
import { param } from "../lib/routes.ts";
import type { ChronicleEntryView, ChroniclePage, Ref } from "../lib/types.ts";
import { TypeDot } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { AgentLink, SlugLink, useRefs } from "../ui/lore/bits.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Empty, Skeleton, SkeletonPanel } from "../ui/Parts.tsx";
import { RichText } from "../ui/RichText.tsx";

const MONTH = /^\d{4}-\d{2}$/;

export default function ChronicleView() {
  return <PageGate>{() => <Chronicle />}</PageGate>;
}

function monthLabel(month: string): string {
  const d = new Date(`${month}-01T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function localToday(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const hashId = () => decodeURIComponent(location.hash.slice(1));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function Chronicle() {
  const [month, setMonth] = useState<string | undefined>(() => {
    const m = param("month");
    return m && MONTH.test(m) ? m : undefined;
  });
  const { data: fresh, error } = useResource<ChroniclePage>(month ? `/chronicle?month=${month}` : "/chronicle");
  // Keep the header (months, selector) up while the next month loads.
  const last = useRef<ChroniclePage | undefined>(undefined);
  if (fresh) last.current = fresh;
  const data = fresh ?? last.current;
  const loadingMonth = !fresh && !error;

  const refs = useRefs();
  const [agents, setAgents] = useState<Set<string>>(new Set());
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string>(() => hashId());

  useEffect(() => {
    const onPop = () => {
      const m = param("month");
      setMonth(m && MONTH.test(m) ? m : undefined);
      setTarget(hashId());
    };
    const onHash = () => setTarget(hashId());
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  const entries = useMemo(() => fresh?.days.flatMap((d) => d.entries) ?? [], [fresh]);
  const facets = useMemo(() => {
    const a = new Map<string, number>();
    const k = new Map<string, number>();
    for (const e of entries) {
      a.set(e.agent, (a.get(e.agent) ?? 0) + 1);
      k.set(e.kind, (k.get(e.kind) ?? 0) + 1);
    }
    const byCount = (m: Map<string, number>) => [...m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    return { agents: byCount(a), kinds: byCount(k) };
  }, [entries]);

  const keep = (e: ChronicleEntryView) => (!agents.size || agents.has(e.agent)) && (!kinds.size || kinds.has(e.kind));
  const days = useMemo(() => (fresh?.days ?? []).map((d) => ({ date: d.date, entries: [...d.entries].reverse().filter(keep) })).filter((d) => d.entries.length), [fresh, agents, kinds]);
  const shownCount = days.reduce((n, d) => n + d.entries.length, 0);

  // A deep link to an entry: clear filters that would hide it, then bring it into view.
  const scrolled = useRef("");
  useEffect(() => {
    if (!fresh || !target || target.startsWith("day-")) return;
    const entry = entries.find((e) => e.id === target);
    if (!entry) return;
    if (!keep(entry)) {
      setAgents(new Set());
      setKinds(new Set());
      return;
    }
    const key = `${fresh.month}#${target}`;
    if (scrolled.current === key) return;
    scrolled.current = key;
    requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" }));
  }, [fresh, target, entries, agents, kinds]);

  const go = (m: string) => {
    if (!MONTH.test(m)) return;
    history.pushState(null, "", `${location.pathname}?month=${m}`);
    setMonth(m);
    setTarget("");
    setAgents(new Set());
    setKinds(new Set());
    window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  if (error && !data) return <div className="callout callout--danger">{error.message}</div>;
  if (!data)
    return (
      <div className="stack">
        <Skeleton h={40} w="35%" />
        <SkeletonPanel lines={2} />
        <SkeletonPanel lines={8} />
      </div>
    );

  const i = data.months.indexOf(data.month);
  const older = i >= 0 ? data.months[i + 1] : data.months[0];
  const newer = i > 0 ? data.months[i - 1] : undefined;
  const toggle = (set: Set<string>, value: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  return (
    <div className="stack" style={{ ["--gap" as string]: "20px" }}>
      <header className="page-head">
        <div>
          <div className="page-head__kicker">The chronicle</div>
          <h1>{monthLabel(data.month)}</h1>
          <p className="page-head__lede">
            {entries.length
              ? `${plural(entries.length, "entry", "entries")} from ${plural(facets.agents.length, "agent")} over ${plural(data.days.length, "day")}. Newest first.`
              : loadingMonth
                ? "Unrolling the scroll…"
                : "Nothing was chronicled this month."}
          </p>
        </div>
        {data.months.length > 0 && (
          <nav className="month-nav" aria-label="Months">
            <button type="button" className="btn btn--icon" onClick={() => older && go(older)} disabled={!older} aria-label={older ? `Older: ${monthLabel(older)}` : "No older month"} title={older ? monthLabel(older) : undefined}>
              <Icon name="back" />
            </button>
            <label>
              <span className="sr-only">Month</span>
              <select className="select" value={data.month} onChange={(e) => go(e.target.value)}>
                {!data.months.includes(data.month) && <option value={data.month}>{monthLabel(data.month)}</option>}
                {data.months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn--icon" onClick={() => newer && go(newer)} disabled={!newer} aria-label={newer ? `Newer: ${monthLabel(newer)}` : "No newer month"} title={newer ? monthLabel(newer) : undefined}>
              <Icon name="chevron" />
            </button>
          </nav>
        )}
      </header>

      {fresh && entries.length > 0 && (
        <section className="panel panel--quiet codex-filters" aria-label="Month at a glance and filters">
          <MonthStrip month={fresh.month} days={days} />
          <div className="chron-filters">
            <div className="chron-filters__row" role="group" aria-label="Filter by agent">
              <span className="chron-filters__label" aria-hidden>
                Agents
              </span>
              {facets.agents.map(([a, n]) => (
                <button key={a} type="button" className="chip" aria-pressed={agents.has(a)} onClick={() => toggle(agents, a, setAgents)}>
                  <TypeDot type={refs.get(a)?.type ?? "party"} />
                  {refs.get(a)?.title ?? a} <span className="chip__count">{n}</span>
                </button>
              ))}
            </div>
            {facets.kinds.length > 1 && (
              <div className="chron-filters__row" role="group" aria-label="Filter by kind">
                <span className="chron-filters__label" aria-hidden>
                  Kinds
                </span>
                {facets.kinds.map(([k, n]) => (
                  <button key={k} type="button" className="chip" aria-pressed={kinds.has(k)} onClick={() => toggle(kinds, k, setKinds)}>
                    {k} <span className="chip__count">{n}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {(agents.size > 0 || kinds.size > 0) && (
            <div className="result-line" aria-live="polite">
              <span>
                {shownCount} of {plural(entries.length, "entry", "entries")}
              </span>
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  setAgents(new Set());
                  setKinds(new Set());
                }}
              >
                Clear filters
              </button>
            </div>
          )}
        </section>
      )}

      {error && !fresh ? (
        <div className="callout callout--danger" role="alert">
          <Icon name="warn" />
          <div>{error.message}</div>
        </div>
      ) : loadingMonth ? (
        <SkeletonPanel lines={8} />
      ) : !data.months.length ? (
        <Empty icon="chronicle" title="The chronicle is blank">
          Episodes are written here, day by day, each time the curator sleeps and consolidates the inbox.
        </Empty>
      ) : !entries.length ? (
        <Empty icon="chronicle" title={`Nothing in ${monthLabel(data.month)}`}>
          {older ? (
            <button type="button" className="linkish" onClick={() => go(older)}>
              Go to {monthLabel(older)}
            </button>
          ) : (
            "Try another month."
          )}
        </Empty>
      ) : !days.length ? (
        <Empty icon="chronicle" title="No entry matches these filters" />
      ) : (
        <div className="chron-days">
          {days.map((d) => (
            <section key={d.date} id={`day-${d.date}`} className="chron-day" aria-labelledby={`h-${d.date}`}>
              <div className="chron-day__head">
                <h2 id={`h-${d.date}`}>{dayLabel(d.date)}</h2>
                <span className="muted">
                  {d.date === localToday() ? "today · " : d.date === localToday(-1) ? "yesterday · " : ""}
                  {plural(d.entries.length, "entry", "entries")}
                </span>
              </div>
              <ol className="timeline">
                {d.entries.map((e) => (
                  <Entry key={e.id} e={e} refs={refs} target={e.id === target} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Entry({ e, refs, target }: { e: ChronicleEntryView; refs: Map<string, Ref>; target: boolean }) {
  return (
    <li id={e.id} className={`timeline__item kind--${e.kind} chron-entry${target ? " is-target" : ""}`} aria-current={target ? "true" : undefined}>
      <div className="timeline__meta">
        <time className="chron-entry__time" dateTime={e.at} title={new Date(e.at).toLocaleString()}>
          {e.time}
        </time>
        <AgentLink agent={e.agent} refs={refs} />
        <span className="chip">{e.kind}</span>
        <a className="chron-entry__perma" href={`#${e.id}`} title="Link to this entry">
          <Icon name="link" size={15} />
          <span className="sr-only">Link to this entry</span>
        </a>
      </div>
      <RichText text={e.text} />
      {e.touched.length > 0 && (
        <div className="touched">
          <span className="muted" aria-hidden>
            ↳
          </span>
          <span className="sr-only">Touched:</span>
          {e.touched.map((t) => (
            <SlugLink key={t} slug={t} refs={refs} />
          ))}
        </div>
      )}
    </li>
  );
}

/** The month at a glance: one cell per day, warmer the busier; busy days link to their section. */
function MonthStrip({ month, days }: { month: string; days: { date: string; entries: unknown[] }[] }) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const per = new Map(days.map((d) => [d.date, d.entries.length]));
  const max = Math.max(1, ...per.values());
  const today = localToday();
  return (
    <div>
      <div className="month-strip" style={{ ["--days" as string]: count }} role="list" aria-label="Entries per day">
        {Array.from({ length: count }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          const n = per.get(date) ?? 0;
          const label = `${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}: ${plural(n, "entry", "entries")}`;
          return (
            <span key={date} role="listitem" className="month-strip__cell">
              {n ? (
                <a className="month-strip__day" href={`#day-${date}`} title={label} aria-label={label} data-today={date === today ? "" : undefined} style={{ ["--heat" as string]: 0.25 + 0.75 * (n / max) }} />
              ) : (
                <span className="month-strip__day" title={label} data-today={date === today ? "" : undefined} />
              )}
            </span>
          );
        })}
      </div>
      <div className="month-strip__axis" aria-hidden>
        <span>1</span>
        <span>{Math.ceil(count / 2)}</span>
        <span>{count}</span>
      </div>
    </div>
  );
}
