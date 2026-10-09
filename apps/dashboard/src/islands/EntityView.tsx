import { useEffect, useMemo, useState } from "react";
import "../styles/lore.css";
import { useResource } from "../lib/cache.ts";
import { emit } from "../lib/events.ts";
import { daysLeftLabel, fieldLabel, plural, shortDate, urgency } from "../lib/format.ts";
import { groupRelations } from "../lib/graph.ts";
import { href, param } from "../lib/routes.ts";
import type { DisputeView, EntityDetail, EpisodeView, FactDetail, PartyMember, QuestCard, Ref, SessionInfo } from "../lib/types.ts";
import { ClockDial } from "../ui/ClockDial.tsx";
import { EntityLink } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { AgentLink, FactTally, StatusChip, TypeLink, initial, useRefs } from "../ui/lore/bits.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { DateText, Empty, Panel, RelTime, Runes, Skeleton, SkeletonPanel } from "../ui/Parts.tsx";
import { RichText } from "../ui/RichText.tsx";
import { Seal } from "../ui/Seal.tsx";
import { Value } from "../ui/Value.tsx";

export default function EntityView() {
  const slug = param("ref")?.trim();
  return (
    <PageGate>
      {(session) =>
        slug ? (
          <Sheet slug={slug} session={session} />
        ) : (
          <div className="panel notfound">
            <Icon name="codex" size={40} />
            <h1>Which page of the codex?</h1>
            <p className="muted">This sheet needs an entry to show. Pick one from the Codex, or search for it.</p>
            <div className="row" style={{ justifyContent: "center" }}>
              <a className="btn btn--primary" href={href.page("codex")}>
                <Icon name="codex" /> Open the Codex
              </a>
              <button type="button" className="btn" onClick={() => emit("palette:open", {})}>
                <Icon name="search" /> Search
              </button>
            </div>
          </div>
        )
      }
    </PageGate>
  );
}

function Sheet({ slug, session }: { slug: string; session: SessionInfo }) {
  const { data: d, error } = useResource<EntityDetail>(`/entity?ref=${encodeURIComponent(slug)}`);
  const refs = useRefs();
  const title = d?.card.title;
  useEffect(() => {
    if (!title) return;
    document.title = `${title} · Hippocampus`;
    const bar = document.querySelector(".topbar__title");
    if (bar) bar.textContent = title;
  }, [title]);

  if (error && !d) {
    if (error.status === 404 || error.status === 400 || error.code === "NOT_FOUND") return <NotFound slug={slug} message={error.message} />;
    return (
      <div className="callout callout--danger" role="alert">
        <Icon name="warn" />
        <div>{error.message}</div>
      </div>
    );
  }
  if (!d)
    return (
      <div className="stack" aria-busy="true">
        <Skeleton h={16} w={180} />
        <SkeletonPanel lines={3} />
        <div className="grid grid--main">
          <SkeletonPanel lines={8} />
          <SkeletonPanel lines={5} />
        </div>
      </div>
    );

  const c = d.card;
  const openDisputes = d.disputes.filter((x) => x.status === "open");
  // Episode ids → their chronicle day, so provenance can link to the entry.
  const days = new Map(d.mentions.map((m) => [m.id, m.day]));

  return (
    <div className="stack" style={{ ["--gap" as string]: "24px" }}>
      <div>
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href={href.page("codex")}>Codex</a>
          <span aria-hidden>›</span>
          <a href={href.codex(c.type)}>{c.type}</a>
          <span aria-hidden>›</span>
          <span aria-current="page">{c.title}</span>
        </nav>
        <SheetHead d={d} session={session} refs={refs} />
      </div>

      {openDisputes.length > 0 && (
        <div className="callout callout--danger" role="status">
          <Icon name="council" />
          <div>
            <strong>
              {openDisputes.length === 1 ? "A dispute awaits your ruling" : `${openDisputes.length} disputes await your ruling`}:{" "}
            </strong>
            {openDisputes.map((x, i) => (
              <span key={x.slug}>
                {i > 0 && ", "}
                <a href={href.page("council", `#${x.slug}`)}>{fieldLabel(x.field)}</a>
              </span>
            ))}
            . Sources disagree, so the curator won't pick a side.
          </div>
        </div>
      )}

      <div className="grid grid--main">
        <div className="stack" style={{ ["--gap" as string]: "24px" }}>
          {d.summary.trim() && (
            <Panel title="In brief" icon="scroll">
              <p style={{ margin: 0, fontSize: "1.08rem" }}>
                <RichText text={d.summary} />
              </p>
            </Panel>
          )}
          <Ledger facts={d.facts} card={c} human={session.human ?? "you"} refs={refs} days={days} />
          <Ties relations={d.relations} slug={c.slug} />
          <Panel title="Your notes" icon="quill">
            {d.notes.trim() ? (
              <Markdown text={d.notes} />
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                No notes of your own yet. Whatever you write in Obsidian outside the curator's regions appears here, and the curator never rewrites it.
              </p>
            )}
          </Panel>
        </div>
        <div className="stack" style={{ ["--gap" as string]: "24px" }}>
          {d.quest && <QuestBlock q={d.quest} />}
          {d.party && <PartyBlock p={d.party} />}
          {d.disputes.length > 0 && <Disputes disputes={d.disputes} />}
          {d.pending.length > 0 && <Pending episodes={d.pending} refs={refs} />}
          <Mentions d={d} refs={refs} />
        </div>
      </div>
    </div>
  );
}

function SheetHead({ d, session, refs }: { d: EntityDetail; session: SessionInfo; refs: Map<string, Ref> }) {
  const c = d.card;
  const v = session.vault;
  const obsidian = v?.kind === "dir" && v.dir ? `obsidian://open?path=${encodeURIComponent(`${v.dir.replace(/\/+$/, "")}/${d.path}`)}` : undefined;
  const github = v?.kind === "github" && v.repo ? `https://github.com/${v.repo}/blob/${encodeURIComponent(v.branch ?? "main")}/${d.path.split("/").map(encodeURIComponent).join("/")}` : undefined;
  return (
    <header className={`panel sheet-head typed typed--${c.type}`}>
      <div className="sigil" aria-hidden>
        {initial(c.title)}
      </div>
      <div>
        <div className="sheet-head__kicker">
          <TypeLink type={c.type} />
          <StatusChip status={c.status} />
          {c.tags.map((t) => (
            <a key={t} className="sheet-tag" href={`${href.page("codex")}?tag=${encodeURIComponent(t)}`}>
              #{t}
            </a>
          ))}
        </div>
        <h1>{c.title}</h1>
        {c.aliases.length > 0 && <p className="sheet-head__aka">Also known as {c.aliases.join(", ")}</p>}
        <div className="sheet-head__meta">
          {c.updated && (
            <span>
              Updated <RelTime at={c.updated} />
              {c.updatedBy && (
                <>
                  {" "}
                  by <AgentLink agent={c.updatedBy} refs={refs} />
                </>
              )}
            </span>
          )}
          <span>{plural(d.facts.length, "fact")}</span>
          <span>{plural(c.degree, "tie")}</span>
          <span className="mono" title="Path in the vault">
            {d.path}
          </span>
        </div>
      </div>
      <div className="sheet-head__actions">
        {session.capabilities.remember && (
          <button type="button" className="btn btn--primary" onClick={() => emit("scribe:open", { about: [c.slug] })}>
            <Icon name="quill" /> Scribe about this
          </button>
        )}
        <a className="btn" href={href.map(c.slug)}>
          <Icon name="map" /> Show on the map
        </a>
        {obsidian && (
          <a className="btn" href={obsidian}>
            <Icon name="external" /> Open in Obsidian
          </a>
        )}
        {github && (
          <a className="btn" href={github} target="_blank" rel="noreferrer noopener">
            <Icon name="github" /> View on GitHub
          </a>
        )}
      </div>
    </header>
  );
}

const AUTHORITY: Record<FactDetail["authority"], [string, string]> = {
  human: ["human authority", "Your word: it outranks every agent"],
  authority: ["lane authority", "Written by the agent whose lane covers this"],
  none: ["no authority", "Reported by an agent without authority here"],
};

function Ledger({ facts, card, human, refs, days }: { facts: FactDetail[]; card: EntityDetail["card"]; human: string; refs: Map<string, Ref>; days: Map<string, string> }) {
  return (
    <Panel title="Ledger" icon="codex" aside={facts.length ? <FactTally facts={card.facts} /> : undefined}>
      {facts.length ? (
        <ul className="ledger">
          {facts.map((f) => (
            <FactRow key={f.field} f={f} human={human} refs={refs} days={days} />
          ))}
        </ul>
      ) : (
        <Empty icon="codex" title="No facts recorded">
          Facts land here when the curator consolidates episodes about this entry.
        </Empty>
      )}
    </Panel>
  );
}

function FactRow({ f, human, refs, days }: { f: FactDetail; human: string; refs: Map<string, Ref>; days: Map<string, string> }) {
  const [label, help] = AUTHORITY[f.authority];
  const hasProv = f.src.length > 0 || f.seenBy.length > 0 || f.was.length > 0;
  const bits = [f.src.length && plural(f.src.length, "source"), f.seenBy.length && `seen by ${f.seenBy.length}`, f.was.length && plural(f.was.length, "earlier value")].filter(Boolean);
  return (
    <li className={`ledger__row ledger__row--${f.status}`}>
      <div className="ledger__field">{fieldLabel(f.field)}</div>
      <div className="ledger__main">
        <span className="ledger__value">
          <Value shown={f} />
        </span>
        <Seal status={f.status} />
        {f.dispute && (
          <a className="flag flag--dispute" href={href.page("council", `#${f.dispute}`)}>
            <Icon name="council" /> open dispute
          </a>
        )}
      </div>
      <div className="ledger__who">
        <span>{f.byHuman ? <strong>{human}</strong> : <AgentLink agent={f.by} refs={refs} />}</span>
        <span className={`authority authority--${f.authority}`} title={help}>
          {f.authority === "human" && <Icon name="key" size={13} />}
          {label}
        </span>
        {f.at && <RelTime at={f.at} />}
        {f.stale && (
          <span className="flag flag--stale" title="Canon, but nobody has confirmed it for a while">
            <Icon name="hourglass" /> stale
          </span>
        )}
      </div>
      {hasProv && (
        <details className="prov">
          <summary>
            <Icon name="chevron" /> Provenance <span className="muted">· {bits.join(" · ")}</span>
          </summary>
          <dl className="prov__body">
            {f.src.length > 0 && (
              <>
                <dt>Sources</dt>
                <dd className="row" style={{ ["--gap" as string]: "4px 10px" }}>
                  {f.src.map((id) => {
                    const day = days.get(id);
                    return day ? (
                      <a key={id} className="mono" href={href.chronicle(day.slice(0, 7), id)} title={`Chronicle, ${shortDate(day)}`}>
                        {id}
                      </a>
                    ) : (
                      <span key={id} className="mono">
                        {id}
                      </span>
                    );
                  })}
                </dd>
              </>
            )}
            {f.seenBy.length > 0 && (
              <>
                <dt>Seen by</dt>
                <dd className="row" style={{ ["--gap" as string]: "4px 10px" }}>
                  {f.seenBy.map((a) => (
                    <AgentLink key={a} agent={a} refs={refs} />
                  ))}
                </dd>
              </>
            )}
            {f.was.length > 0 && (
              <>
                <dt>Before</dt>
                <dd>
                  <ol className="was">
                    {[...f.was].reverse().map((w, i) => (
                      <li key={i}>
                        <span className="mono">
                          <Value shown={w} />
                        </span>
                        <span className="small muted">
                          {w.by && <>by {w.by}</>}
                          {w.at && (
                            <>
                              {" "}
                              · <RelTime at={w.at} />
                            </>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                </dd>
              </>
            )}
          </dl>
        </details>
      )}
    </li>
  );
}

function Ties({ relations, slug }: { relations: EntityDetail["relations"]; slug: string }) {
  const groups = useMemo(() => groupRelations(relations), [relations]);
  return (
    <Panel title="Ties" icon="link" aside={relations.length ? <a href={href.map(slug)}>On the map →</a> : undefined}>
      {groups.length ? (
        <dl className="ties">
          {groups.map((g) => (
            <div key={g.rel} className="ties__group">
              <dt>{g.rel.replace(/_/g, " ")}</dt>
              <dd>
                {g.items.map((it) => (
                  <span key={`${it.dir}:${it.ref.slug}`} className="ties__item" title={it.dir === "out" ? `This ${g.rel} ${it.ref.title}` : `${it.ref.title} ${g.rel} this`}>
                    <span className="ties__arrow" aria-hidden>
                      {it.dir === "out" ? "→" : "←"}
                    </span>
                    <span className="sr-only">{it.dir === "out" ? "to" : "from"}</span>
                    <EntityLink entity={it.ref} />
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <Empty icon="link" title="No ties yet">
          An orphan: nothing links here, and it links nowhere.
        </Empty>
      )}
    </Panel>
  );
}

function QuestBlock({ q }: { q: QuestCard }) {
  const done = q.objectives.filter((o) => o.done).length;
  const u = urgency(q.daysLeft);
  return (
    <Panel title="Quest" icon="quest" aside={<a href={href.page("quests", `#${q.slug}`)}>Quest board →</a>}>
      <div className="stack">
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <StatusChip status={q.status} />
          </dd>
          {q.owner && (
            <>
              <dt>Owner</dt>
              <dd>
                <EntityLink entity={q.owner} />
              </dd>
            </>
          )}
          {q.deadline && (
            <>
              <dt>Deadline</dt>
              <dd>
                <DateText date={q.deadline} /> <span className={`small due due--${u}`}>· {daysLeftLabel(q.daysLeft)}</span>
              </dd>
            </>
          )}
          {q.campaign && (
            <>
              <dt>Campaign</dt>
              <dd>
                <EntityLink entity={q.campaign} />
              </dd>
            </>
          )}
        </dl>
        {q.objectives.length > 0 && (
          <div className="stack" style={{ ["--gap" as string]: "8px" }}>
            <div className="row small muted">
              <Runes done={done} total={q.objectives.length} /> {done} of {q.objectives.length} objectives
            </div>
            <ul className="objectives">
              {q.objectives.map((o, i) => (
                <li key={i} data-done={o.done ? "" : undefined}>
                  <span className="objectives__box" aria-hidden />
                  <span>
                    <span className="sr-only">{o.done ? "Done: " : "Open: "}</span>
                    {o.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {q.clocks.length > 0 && (
          <div className="clocks">
            {q.clocks.map((ck) => (
              <div key={ck.name} className="clocks__item">
                <ClockDial name={ck.name} segments={ck.segments} filled={ck.filled} size={52} />
                <div>
                  <strong>{ck.name}</strong>
                  <span className="small muted">
                    {ck.filled}/{ck.segments}
                    {ck.deadline && (
                      <span className={`due due--${urgency(ck.daysLeft)}`}> · {daysLeftLabel(ck.daysLeft)}</span>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

function PartyBlock({ p }: { p: PartyMember }) {
  return (
    <Panel title="Party member" icon="party" aside={<a href={href.page("party", `#${p.slug}`)}>The party →</a>}>
      <dl className="kv">
        {p.lane && (
          <>
            <dt>Lane</dt>
            <dd>{p.lane}</dd>
          </>
        )}
        <dt>Authority</dt>
        <dd>
          {p.authority.length ? (
            <span className="chips">
              {p.authority.map((a) => (
                <span key={a} className="chip">
                  {a}
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">none: its word counts as rumor</span>
          )}
        </dd>
        {p.host && (
          <>
            <dt>Host</dt>
            <dd>{p.host}</dd>
          </>
        )}
        <dt>Last seen</dt>
        <dd>{p.lastSeen ? <RelTime at={p.lastSeen} /> : <span className="muted">not yet</span>}</dd>
        <dt>Activity</dt>
        <dd>
          {plural(p.chronicled30d, "entry", "entries")} in 30 days
          {p.pending > 0 && (
            <>
              {" · "}
              <a href={href.page("satchel")}>{p.pending} waiting</a>
            </>
          )}
        </dd>
        {p.owns.length > 0 && (
          <>
            <dt>Owns</dt>
            <dd className="row" style={{ ["--gap" as string]: "4px 12px" }}>
              {p.owns.map((r) => (
                <EntityLink key={r.slug} entity={r} />
              ))}
            </dd>
          </>
        )}
      </dl>
    </Panel>
  );
}

function Disputes({ disputes }: { disputes: DisputeView[] }) {
  return (
    <Panel title="Council" icon="council">
      <ul className="list">
        {disputes.map((x) => (
          <li key={x.slug} className="mention">
            <div className="mention__meta">
              <strong>{fieldLabel(x.field)}</strong>
              {x.status === "open" ? <Seal status="disputed" /> : <span className="chip">resolved</span>}
              {(x.resolved ?? x.opened) && <RelTime at={x.resolved ?? x.opened} />}
            </div>
            <div className="small">
              {x.claims.map((cl, i) => (
                <span key={i}>
                  {i > 0 && <span className="muted"> vs </span>}
                  <span className="mono">
                    <Value shown={cl} />
                  </span>{" "}
                  <span className="muted">({cl.by})</span>
                </span>
              ))}
            </div>
            {x.status === "open" && (
              <a className="small" href={href.page("council", `#${x.slug}`)}>
                Rule on it →
              </a>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Pending({ episodes, refs }: { episodes: EpisodeView[]; refs: Map<string, Ref> }) {
  return (
    <Panel title="In the satchel" icon="satchel" aside="joins canon at the next sleep">
      <ul className="list">
        {episodes.map((ep) => (
          <li key={ep.id} className="mention">
            <div className="mention__meta">
              <AgentLink agent={ep.agent} refs={refs} />
              <span className="chip">{ep.kind}</span>
              <RelTime at={ep.at} />
              {ep.waitedThroughSleep && (
                <span className="flag flag--stale" title="Older than the last sleep: it failed or didn't fit the batch">
                  <Icon name="hourglass" /> waited
                </span>
              )}
            </div>
            {ep.secret || ep.text === null ? (
              <span className="episode--sealed">
                <span className="lock">
                  <Icon name="lock" size={14} /> sealed
                </span>{" "}
                Carries a secret; hidden until the curator encrypts it.
              </span>
            ) : (
              <span className="mention__text">
                <RichText text={ep.text} />
              </span>
            )}
            <a className="small" href={href.page("satchel", `#${ep.id}`)}>
              In the satchel →
            </a>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const MENTIONS_FIRST = 6;

function Mentions({ d, refs }: { d: EntityDetail; refs: Map<string, Ref> }) {
  const [all, setAll] = useState(false);
  const list = all ? d.mentions : d.mentions.slice(0, MENTIONS_FIRST);
  return (
    <Panel title="In the chronicle" icon="chronicle" aside={d.mentions.length ? `last 90 days · ${d.mentions.length}` : undefined}>
      {list.length ? (
        <div className="stack" style={{ ["--gap" as string]: "10px" }}>
          <ul className="list">
            {list.map((m) => (
              <li key={m.id} className="mention">
                <div className="mention__meta">
                  <a href={href.chronicle(m.day.slice(0, 7), m.id)} title={new Date(m.at).toLocaleString()}>
                    {shortDate(m.day, { year: false })} · {m.time}
                  </a>
                  <AgentLink agent={m.agent} refs={refs} />
                  <span className="chip">{m.kind}</span>
                </div>
                <span className="mention__text">
                  <RichText text={m.text} />
                </span>
              </li>
            ))}
          </ul>
          {d.mentions.length > MENTIONS_FIRST && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAll((x) => !x)} aria-expanded={all}>
              {all ? "Show fewer" : `Show all ${d.mentions.length}`}
            </button>
          )}
        </div>
      ) : (
        <Empty icon="chronicle" title="Not in the chronicle lately">
          No consolidated episode touched this entry in the last 90 days.
        </Empty>
      )}
    </Panel>
  );
}

function NotFound({ slug, message }: { slug: string; message: string }) {
  useEffect(() => {
    document.title = "Not in the codex · Hippocampus";
  }, []);
  return (
    <div className="panel notfound" role="alert">
      <Icon name="scroll" size={44} />
      <h1>Not in the codex</h1>
      <p>
        No entry answers to <code>{slug}</code>.
      </p>
      <p className="muted">
        <RichText text={message.replace(/^no entity "[^"]*";?\s*/i, "").replace(/^did you mean/i, "Did you mean") || "The vault has no page by that name."} />
      </p>
      <div className="row" style={{ justifyContent: "center" }}>
        <a className="btn btn--primary" href={`${href.page("codex")}?q=${encodeURIComponent(slug)}`}>
          <Icon name="codex" /> Search the Codex
        </a>
        <button type="button" className="btn" onClick={() => emit("palette:open", {})}>
          <Icon name="search" /> Search everything
        </button>
      </div>
    </div>
  );
}
