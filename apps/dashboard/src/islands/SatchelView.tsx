import { useEffect, useMemo, useState } from "react";
import "../styles/play.css";
import { fold } from "@hippocampus/core/text";
import { useResource } from "../lib/cache.ts";
import { emit } from "../lib/events.ts";
import { plural, shortDate } from "../lib/format.ts";
import { href, param } from "../lib/routes.ts";
import type { Catalog, EpisodeView, Overview, PartyMember, Ref, SessionInfo } from "../lib/types.ts";
import { EntityLink, TypeDot } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Empty, RelTime, SkeletonPanel } from "../ui/Parts.tsx";
import { RichText } from "../ui/RichText.tsx";
import { useHashTarget } from "../ui/play/actions.ts";
import { PageHead } from "../ui/play/Bits.tsx";
import { KIND_LABEL, confidenceLabel, countBy, filterEpisodes, unwrapRef } from "../ui/play/model.ts";

export default function SatchelView() {
  return <PageGate>{(session) => <Satchel session={session} />}</PageGate>;
}

function Satchel({ session }: { session: SessionInfo }) {
  const { data: o, error } = useResource<Overview>("/overview", { poll: 60_000 });
  // Only for nicer "about" links (titles and type dots); the page works without it.
  const catalog = useResource<Catalog>(o?.inbox.some((e) => e.about.length) ? "/catalog" : null);
  const [agent, setAgent] = useState<string | null>(() => param("agent"));
  const [kind, setKind] = useState<string | null>(() => param("kind"));
  const [waitedOnly, setWaitedOnly] = useState(false);
  useHashTarget(!!o);

  // Filters live in the URL, so a party sheet can link to "everything job-scout is carrying".
  useEffect(() => {
    const u = new URL(location.href);
    for (const [k, v] of [
      ["agent", agent],
      ["kind", kind],
    ] as const)
      if (v) u.searchParams.set(k, v);
      else u.searchParams.delete(k);
    if (u.href !== location.href) history.replaceState(history.state, "", u);
  }, [agent, kind]);

  const resolve = useMemo(() => resolver(catalog.data), [catalog.data]);

  if (error && !o) return <div className="callout callout--danger">{error.message}</div>;
  if (!o)
    return (
      <div className="stack">
        <SkeletonPanel lines={3} />
        <SkeletonPanel lines={8} />
      </div>
    );

  const all = o.inbox;
  const shown = filterEpisodes(all, { agent, kind }).filter((e) => !waitedOnly || e.waitedThroughSleep);
  const agents = countBy(all, (e) => e.agent);
  const kinds = countBy(all, (e) => e.kind);
  const waited = all.filter((e) => e.waitedThroughSleep).length;
  const sealed = all.filter((e) => e.secret).length;
  const filtered = !!agent || !!kind || waitedOnly;
  const clear = () => {
    setAgent(null);
    setKind(null);
    setWaitedOnly(false);
  };

  return (
    <div className="stack play" style={{ ["--gap" as string]: "24px" }}>
      <PageHead
        kicker={<>The satchel · {o.campaign}</>}
        title="The Satchel"
        lede={
          o.counts.inbox ? (
            <>
              {plural(o.counts.inbox, "episode")} wait{o.counts.inbox === 1 ? "s" : ""} in the inbox for the next sleep. Until then they're notes in a satchel: not canon yet, and not in the chronicle.
            </>
          ) : (
            "Episodes the party has written down, waiting for the next sleep to consolidate them."
          )
        }
        action={
          session.capabilities.remember && (
            <button type="button" className="btn btn--primary" onClick={() => emit("scribe:open", {})}>
              <Icon name="quill" /> Scribe a memory
            </button>
          )
        }
      />

      <SleepPanel o={o} sealed={sealed} />

      {waited > 0 && (
        <div className="callout callout--warn" role="note">
          <Icon name="hourglass" />
          <div>
            <strong>{plural(waited, "episode")} sat through a sleep without being consolidated.</strong> The curator may have failed on {waited === 1 ? "it" : "them"}, or {waited === 1 ? "it" : "they"} didn't fit the batch. Check the morning review (<code>_hippo/review.md</code>) in Obsidian.{" "}
            {!waitedOnly && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setWaitedOnly(true)}>
                Show only {waited === 1 ? "that one" : "those"}
              </button>
            )}
          </div>
        </div>
      )}

      {all.length === 0 ? (
        <div className="panel">
          <Empty icon="satchel" title="The satchel is empty">
            Every episode has been consolidated into the chronicle. New ones arrive as agents remember things{session.capabilities.remember ? ", or when you scribe one" : ""}.
          </Empty>
        </div>
      ) : (
        <>
          <div className="filters" role="group" aria-label="Filter episodes">
            <div className="filters__group">
              <span className="label">Agent</span>
              <button type="button" className="chip" aria-pressed={!agent} onClick={() => setAgent(null)}>
                Everyone <span className="chip__n">{all.length}</span>
              </button>
              {agents.map(([a, n]) => {
                const member = o.party.find((p) => p.slug === a);
                return (
                  <button key={a} type="button" className="chip" aria-pressed={agent === a} onClick={() => setAgent(agent === a ? null : a)} title={member ? a : `${a} (not in the party)`}>
                    <TypeDot type={member ? "party" : "other"} />
                    {member?.title ?? a} <span className="chip__n">{n}</span>
                  </button>
                );
              })}
            </div>
            <div className="filters__group">
              <span className="label">Kind</span>
              <button type="button" className="chip" aria-pressed={!kind} onClick={() => setKind(null)}>
                Any
              </button>
              {kinds.map(([k, n]) => (
                <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>
                  {KIND_LABEL[k as EpisodeView["kind"]] ?? k} <span className="chip__n">{n}</span>
                </button>
              ))}
              {waited > 0 && (
                <button type="button" className="chip" aria-pressed={waitedOnly} onClick={() => setWaitedOnly(!waitedOnly)}>
                  <Icon name="hourglass" size={14} /> Sat through a sleep <span className="chip__n">{waited}</span>
                </button>
              )}
            </div>
          </div>

          <p className="small muted play-note" aria-live="polite">
            {filtered ? `Showing ${shown.length} of ${all.length}, newest first.` : `Newest first.`}
            {o.counts.inbox > all.length && ` The dashboard lists the newest ${all.length} of ${o.counts.inbox}.`}
            {filtered && (
              <>
                {" "}
                <button type="button" className="linklike" onClick={clear}>
                  Clear filters
                </button>
              </>
            )}
          </p>

          {shown.length ? (
            <ol className="letters">
              {shown.map((e) => (
                <Letter key={e.id} e={e} party={o.party} resolve={resolve} />
              ))}
            </ol>
          ) : (
            <div className="panel">
              <Empty icon="search" title="Nothing matches">
                No episodes in the satchel match these filters.{" "}
                <button type="button" className="linklike" onClick={clear}>
                  Show them all
                </button>
              </Empty>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SleepPanel({ o, sealed }: { o: Overview; sealed: number }) {
  const n = o.counts.inbox;
  return (
    <section className="sleep panel panel--quiet" aria-label="Sleep">
      <div className="sleep__last">
        <Icon name="moonStars" size={28} />
        <div>
          <div className="label">Last sleep</div>
          {o.lastSleep ? (
            <div>
              <strong>
                <RelTime at={o.lastSleep} />
              </strong>{" "}
              <span className="muted small">{shortDate(o.lastSleep, { weekday: true })}</span>
            </div>
          ) : (
            <div className="muted">Not yet: the curator hasn't slept.</div>
          )}
        </div>
      </div>
      <div className="sleep__next">
        <div className="label">At the next sleep</div>
        {n ? (
          <ul className="sleep__steps small">
            <li>
              The curator reads {n === 1 ? "this episode" : `these ${n} episodes`} and settles each fact by precedence: it becomes canon, stays a rumor, or goes to the <a href={href.page("council")}>council</a>.
            </li>
            <li>Quests, clocks and links they mention are updated.</li>
            {sealed > 0 && (
              <li>
                {sealed === 1 ? "The sealed episode's secret is" : `The ${sealed} sealed episodes' secrets are`} encrypted into <code>secrets/</code>; only a redacted line reaches the chronicle.
              </li>
            )}
            <li>Each one is filed in the <a href={href.page("chronicle")}>chronicle</a> and leaves the satchel. One that fails stays here for the next try: nothing is lost.</li>
          </ul>
        ) : (
          <p className="small muted">Nothing to consolidate. The next sleep just tidies up.</p>
        )}
        <a className="small" href={href.guide("how-it-works")}>
          How remembering and sleep work →
        </a>
      </div>
    </section>
  );
}

function Letter({ e, party, resolve }: { e: EpisodeView; party: PartyMember[]; resolve: (raw: string) => Ref }) {
  const member = party.find((p) => p.slug === e.agent);
  const conf = confidenceLabel(e.confidence);
  return (
    <li id={e.id} className={`letter${e.secret ? " letter--sealed" : ""}${e.waitedThroughSleep ? " letter--waited" : ""}`}>
      <header className="letter__head">
        {member ? (
          <EntityLink entity={member} />
        ) : (
          <span className="row" style={{ ["--gap" as string]: "6px" }}>
            <strong>{e.agent}</strong>
            <a className="chip" href={href.page("party", "#strangers")} title="No party note: its word counts as rumor. Add it to the party.">
              not in the party
            </a>
          </span>
        )}
        <span className="chip">{KIND_LABEL[e.kind] ?? e.kind}</span>
        {conf && (
          <span className="small muted" title="The agent's own confidence in this episode">
            {conf}
          </span>
        )}
        <RelTime at={e.at} className="muted small letter__time" />
      </header>

      {e.waitedThroughSleep && (
        <p className="letter__warn small">
          <Icon name="hourglass" size={16} /> Sat through a sleep: it may have failed. Check the morning review.
        </p>
      )}

      {e.secret ? (
        <div className="envelope">
          <span className="wax" aria-hidden>
            <Icon name="lock" size={18} />
          </span>
          <p className="small">
            <strong>Sealed.</strong> This episode carries a secret (an ID, a document or account number, a password), so the dashboard never shows its text. The next sleep encrypts it into <code>secrets/</code>; only a redacted line reaches the chronicle.
          </p>
        </div>
      ) : (
        <div className="letter__text">
          <RichText text={e.text ?? ""} />
        </div>
      )}

      {e.about.length > 0 && (
        <div className="letter__about small">
          <span className="muted">About</span>
          {e.about.map((a) => (
            <EntityLink key={a} entity={resolve(a)} />
          ))}
        </div>
      )}
      <div className="letter__path mono muted" title="Where it waits in the vault">
        {e.path}
      </div>
    </li>
  );
}

/** `[[Migration Agency]]` → its catalog entry when known (by slug, title or alias), else the bare slug. */
function resolver(catalog: Catalog | undefined): (raw: string) => Ref {
  const index = new Map<string, Ref>();
  for (const e of catalog?.entities ?? []) for (const k of [e.slug, e.title, ...e.aliases]) index.set(fold(k), { slug: e.slug, title: e.title, type: e.type });
  return (raw) => {
    const target = unwrapRef(raw);
    return index.get(fold(target)) ?? { slug: target, title: target, type: "other" };
  };
}
