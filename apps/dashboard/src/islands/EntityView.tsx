import { useEffect, useMemo, useState } from "react";
import "../styles/lore.css";
import { useResource } from "../lib/cache.ts";
import { emit } from "../lib/events.ts";
import { daysLeftLabel, fieldLabel, plural, shortDate, urgency } from "../lib/format.ts";
import { groupRelations } from "../lib/graph.ts";
import { useTerms, type Voice } from "../lib/prefs.ts";
import { href, param } from "../lib/routes.ts";
import { postJson } from "../lib/api.ts";
import { toast } from "../lib/events.ts";
import { repeatLabel } from "../lib/progress.ts";
import type { DisputeView, EntityDetail, EpisodeView, FactDetail, GoalCard, GuidelineView, PartyMember, Ref, SessionInfo } from "../lib/types.ts";
import { ProgressBar } from "../ui/ProgressBar.tsx";
import { errorMessage, settle } from "../ui/play/actions.ts";
import { GoalSeal } from "../ui/play/Bits.tsx";
import { EntityLink } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { AgentLink, FactTally, StatusChip, TypeLink, initial, useKindLabel, useRefs, useTypeLabel } from "../ui/lore/bits.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { DateText, Empty, Panel, RelTime, Runes, Skeleton, SkeletonPanel } from "../ui/Parts.tsx";
import { RichText } from "../ui/RichText.tsx";
import { Seal } from "../ui/Seal.tsx";
import { Value } from "../ui/Value.tsx";

/** Names the tab and the top bar: the record's title once known, else the page's name in the reader's voice. */
function usePageName(title: string | undefined, skip = false) {
  const { v } = useTerms();
  const name = title ?? v("Record", "Codex entry");
  useEffect(() => {
    if (skip) return;
    document.title = `${name} · Hippocampus`;
    const bar = document.querySelector(".topbar__title");
    if (bar) bar.textContent = name;
  }, [name, skip]);
}

export default function EntityView() {
  const slug = param("ref")?.trim();
  const { t, v } = useTerms();
  usePageName(undefined, !!slug);
  return (
    <PageGate>
      {(session) =>
        slug ? (
          <Sheet slug={slug} session={session} />
        ) : (
          <div className="panel notfound">
            <Icon name="codex" size={40} />
            <h1>{v("Which record?", "Which page of the codex?")}</h1>
            <p className="muted">{v(`This page shows one record. Pick one from ${t("codex")}, or search for it.`, "This sheet needs an entry to show. Pick one from the Codex, or search for it.")}</p>
            <div className="row" style={{ justifyContent: "center" }}>
              <a className="btn btn--primary" href={href.page("codex")}>
                <Icon name="codex" /> {v(`Open ${t("codex")}`, "Open the Codex")}
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
  const voice = useTerms();
  const { t, v } = voice;
  const typeLabel = useTypeLabel();
  const { data: d, error } = useResource<EntityDetail>(`/entity?ref=${encodeURIComponent(slug)}`);
  const refs = useRefs();
  // A missing entry is named by NotFound instead.
  usePageName(d?.card.title, !!error && !d);

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
          <a href={href.page("codex")}>{t("codex")}</a>
          <span aria-hidden>›</span>
          <a href={href.codex(c.type)}>{typeLabel(c.type)}</a>
          <span aria-hidden>›</span>
          <span aria-current="page">{c.title}</span>
        </nav>
        <SheetHead d={d} session={session} refs={refs} voice={voice} />
      </div>

      {openDisputes.length > 0 && (
        <div className="callout callout--danger" role="status">
          <Icon name="council" />
          <div>
            <strong>
              {openDisputes.length === 1 ? v("A dispute needs your decision", "A dispute awaits your ruling") : v(`${openDisputes.length} disputes need your decision`, `${openDisputes.length} disputes await your ruling`)}:{" "}
            </strong>
            {openDisputes.map((x, i) => (
              <span key={x.slug}>
                {i > 0 && ", "}
                <a href={href.page("council", `#${x.slug}`)}>{fieldLabel(x.field)}</a>
              </span>
            ))}
            {v(". Sources disagree, so nothing changes until you decide.", ". Sources disagree, so the curator won't pick a side.")}
          </div>
        </div>
      )}

      <div className="grid grid--main">
        <div className="stack" style={{ ["--gap" as string]: "24px" }}>
          {d.summary.trim() && (
            <Panel title={v("Summary", "In brief")} icon="scroll">
              <p className="sheet-brief" style={{ margin: 0, fontSize: "1.08rem" }}>
                <RichText text={d.summary} />
              </p>
            </Panel>
          )}
          <Ledger facts={d.facts} card={c} me={session.actor?.kind === "human" ? session.actor.id : undefined} canRetract={!!session.capabilities.retract && session.actor?.kind === "human"} slug={c.slug} refs={refs} days={days} voice={voice} />
          {d.guidelines && <Guidelines g={d.guidelines} me={session.actor?.kind === "human" ? session.actor.id : undefined} refs={refs} voice={voice} />}
          <Ties relations={d.relations} slug={c.slug} voice={voice} />
          <Panel title="Your notes" icon="quill" className="sheet-notes">
            {d.notes.trim() ? (
              <Markdown text={d.notes} />
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                {v(
                  "No notes of your own yet. Whatever you write in Obsidian outside the automatically managed sections appears here, and Hippocampus never rewrites it.",
                  "No notes of your own yet. Whatever you write in Obsidian outside the curator's regions appears here, and the curator never rewrites it.",
                )}
              </p>
            )}
          </Panel>
        </div>
        <div className="stack" style={{ ["--gap" as string]: "24px" }}>
          {(d.goal ?? d.quest) && <GoalBlock g={(d.goal ?? d.quest)!} voice={voice} />}
          {d.party && <PartyBlock p={d.party} voice={voice} />}
          {(d.stats || d.cadence) && <Contact d={d} voice={voice} />}
          {d.inherits && d.inherits.length > 0 && <Inherits refs={d.inherits} voice={voice} />}
          {d.questions && d.questions.length > 0 && <Questions d={d} refs={refs} voice={voice} />}
          {d.decisions && d.decisions.length > 0 && <Decisions d={d} refs={refs} voice={voice} />}
          {d.disputes.length > 0 && <Disputes disputes={d.disputes} voice={voice} />}
          {d.pending.length > 0 && <Pending episodes={d.pending} refs={refs} voice={voice} />}
          <Mentions d={d} refs={refs} voice={voice} />
        </div>
      </div>
    </div>
  );
}

function SheetHead({ d, session, refs, voice: { v } }: { d: EntityDetail; session: SessionInfo; refs: Map<string, Ref>; voice: Voice }) {
  const c = d.card;
  const vault = session.vault;
  const obsidian = vault?.kind === "dir" && vault.dir ? `obsidian://open?path=${encodeURIComponent(`${vault.dir.replace(/\/+$/, "")}/${d.path}`)}` : undefined;
  const github = vault?.kind === "github" && vault.repo ? `https://github.com/${vault.repo}/blob/${encodeURIComponent(vault.branch ?? "main")}/${d.path.split("/").map(encodeURIComponent).join("/")}` : undefined;
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
          <span>{v(plural(c.degree, "connection"), plural(c.degree, "tie"))}</span>
          <span className="mono" title="Path in the vault">
            {d.path}
          </span>
        </div>
      </div>
      <div className="sheet-head__actions">
        {session.capabilities.remember && (
          <button type="button" className="btn btn--primary" onClick={() => emit("scribe:open", { about: [c.slug] })}>
            <Icon name="quill" /> {v("Add a note about this", "Scribe about this")}
          </button>
        )}
        <a className="btn" href={href.map(c.slug)}>
          <Icon name="map" /> {v("Show connections", "Show on the map")}
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

/** Why an earlier value left: [plain, codex]. */
const WHY: Record<string, [string, string]> = {
  replaced: ["replaced", "overruled"],
  succeeded: ["changed since", "succeeded"],
  retconned: ["withdrawn", "retconned"],
  ruled: ["decided", "ruled"],
};

/** [label, tooltip] per authority, in the plain and codex voices. */
const AUTHORITY: Record<FactDetail["authority"], [plain: [string, string], codex: [string, string]]> = {
  human: [
    ["set by you", "You set this, and your word outranks every agent"],
    ["human authority", "Your word: it outranks every agent"],
  ],
  authority: [
    ["responsible agent", "Written by the agent responsible for this"],
    ["lane authority", "Written by the agent whose lane covers this"],
  ],
  none: [
    ["other agent", "Reported by an agent that isn't responsible for this"],
    ["no authority", "Reported by an agent without authority here"],
  ],
};

interface LedgerProps {
  facts: FactDetail[];
  card: EntityDetail["card"];
  /** The human the dashboard acts as: their facts read "you", other people's their name. */
  me?: string;
  canRetract: boolean;
  slug: string;
  refs: Map<string, Ref>;
  days: Map<string, string>;
  voice: Voice;
}

function Ledger({ facts, card, me, canRetract, slug, refs, days, voice }: LedgerProps) {
  const { v } = voice;
  return (
    <Panel title={v("Facts", "Ledger")} icon="codex" aside={facts.length ? <FactTally facts={card.facts} /> : undefined}>
      {facts.length ? (
        <ul className="ledger">
          {facts.map((f) => (
            <FactRow key={f.field} f={f} me={me} retract={canRetract ? () => retract(slug, f) : undefined} refs={refs} days={days} voice={voice} />
          ))}
        </ul>
      ) : (
        <Empty icon="codex" title="No facts recorded">
          {v("Facts appear here after the nightly update processes notes about this record.", "Facts land here when the curator consolidates episodes about this entry.")}
        </Empty>
      )}
    </Panel>
  );
}

/** A human withdraws a fact: it becomes "replaced" (retconned), and the next report about it starts over. */
async function retract(slug: string, f: FactDetail): Promise<void> {
  const field = f.name ?? f.field;
  try {
    await postJson("/actions/retract", { entity: slug, field, ...(f.scope ? { scope: f.scope } : {}) });
    toast(`${fieldLabel(field)}${f.scope ? ` (${f.scope})` : ""}: withdrawn`, "ok");
  } catch (err) {
    toast(`${fieldLabel(field)}: ${errorMessage(err)}`, "error");
  } finally {
    void settle();
  }
}

/** The fact's qualifiers: where it holds, when, how sure its source was, and who may set it. */
function Qualifiers({ f, voice: { v } }: { f: FactDetail; voice: Voice }) {
  const range = f.validFrom || f.validUntil ? `${f.validFrom ? shortDate(f.validFrom) : "…"} – ${f.validUntil ? shortDate(f.validUntil) : v("now", "now")}` : undefined;
  if (!f.scope && !range && f.confidence === undefined && !f.humanOnly) return null;
  return (
    <div className="ledger__quals small">
      {f.scope && (
        <span className="chip" title={v(`Holds only in this context: ${f.scope}`, `Holds only where ${f.scope}`)}>
          @ {f.scope}
        </span>
      )}
      {range && (
        <span className="chip" title={v("When this was true", "When this held")}>
          <Icon name="hourglass" size={12} /> {range}
        </span>
      )}
      {f.confidence !== undefined && (
        <span className="chip" title={v("How sure the source was", "The source's own confidence")}>
          {Math.round(f.confidence * 100)}% sure
        </span>
      )}
      {f.humanOnly && (
        <span className="chip chip--human-only" title={v("Only a person sets this; an agent's report becomes a suggestion for you", "Only a player sets this; an agent's word becomes a petition")}>
          <Icon name="key" size={12} /> {v("people only", "players only")}
        </span>
      )}
    </div>
  );
}

function FactRow({ f, me, retract, refs, days, voice }: { f: FactDetail; me?: string; retract?: () => void; refs: Map<string, Ref>; days: Map<string, string>; voice: Voice }) {
  const { t, v } = voice;
  const [confirm, setConfirm] = useState(false);
  const mine = f.byHuman && (!me || f.by.toLowerCase() === me.toLowerCase());
  const [label, help] = f.authority === "human" && !mine ? [v(`set by ${f.by}`, `${f.by}'s word`), v(`${f.by} set this; a person's word outranks every agent`, `${f.by}'s word outranks every agent`)] : v(...AUTHORITY[f.authority]);
  const hasProv = f.src.length > 0 || f.seenBy.length > 0 || f.was.length > 0;
  const bits = [
    f.src.length && v(plural(f.src.length, "source note"), plural(f.src.length, "source")),
    f.seenBy.length && v(`reported by ${f.seenBy.length}`, `seen by ${f.seenBy.length}`),
    f.was.length && plural(f.was.length, "earlier value"),
  ].filter(Boolean);
  return (
    <li className={`ledger__row ledger__row--${f.status}`}>
      <div className="ledger__field">{fieldLabel(f.name ?? f.field)}</div>
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
      <Qualifiers f={f} voice={voice} />
      <div className="ledger__who">
        <span>{f.byHuman ? <strong>{mine ? v("You", me ?? "you") : f.by}</strong> : <AgentLink agent={f.by} refs={refs} />}</span>
        <span className={`authority authority--${f.authority}`} title={help}>
          {f.authority === "human" && <Icon name="key" size={13} />}
          {label}
        </span>
        {f.at && <RelTime at={f.at} />}
        {f.stale && (
          <span className="flag flag--stale" title={v("Confirmed, but nobody has re-checked it for a while", "Canon, but nobody has confirmed it for a while")}>
            <Icon name="hourglass" /> {v("needs re-checking", "stale")}
          </span>
        )}
        {retract && f.status !== "retconned" && !f.secret && (
          confirm ? (
            <span className="row" style={{ ["--gap" as string]: "6px" }}>
              <span className="small">{v("Withdraw this fact?", "Strike it from canon?")}</span>
              <button type="button" className="btn btn--sm btn--danger" onClick={() => (setConfirm(false), retract())}>
                {v("Withdraw", "Retcon")}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(true)} title={v("Mark it replaced; the next report about it starts over", "Retcon it; the next report starts over")}>
              {v("Withdraw", "Retcon")}
            </button>
          )
        )}
      </div>
      {hasProv && (
        <details className="prov">
          <summary>
            <Icon name="chevron" /> {v("Sources and history", "Provenance")} <span className="muted">· {bits.join(" · ")}</span>
          </summary>
          <dl className="prov__body">
            {f.src.length > 0 && (
              <>
                <dt>{v("Source notes", "Sources")}</dt>
                <dd className="row" style={{ ["--gap" as string]: "4px 10px" }}>
                  {f.src.map((id) => {
                    const day = days.get(id);
                    return day ? (
                      <a key={id} className="mono" href={href.chronicle(day.slice(0, 7), id)} title={`${t("chronicle")}, ${shortDate(day)}`}>
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
                <dt>{v("Reported by", "Seen by")}</dt>
                <dd className="row" style={{ ["--gap" as string]: "4px 10px" }}>
                  {f.seenBy.map((a) => (
                    <AgentLink key={a} agent={a} refs={refs} />
                  ))}
                </dd>
              </>
            )}
            {f.was.length > 0 && (
              <>
                <dt>{v("Earlier values", "Before")}</dt>
                <dd>
                  <ol className="was">
                    {[...f.was].reverse().map((w, i) => (
                      <li key={i}>
                        <span className="mono">
                          <Value shown={w} />
                        </span>
                        <span className="small muted">
                          {w.why && <>{WHY[w.why] ? v(...WHY[w.why]!) : w.why} · </>}
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

function Ties({ relations, slug, voice: { v } }: { relations: EntityDetail["relations"]; slug: string; voice: Voice }) {
  const groups = useMemo(() => groupRelations(relations), [relations]);
  return (
    <Panel title={v("Relationships", "Ties")} icon="link" aside={relations.length ? <a href={href.map(slug)}>{v("See connections →", "On the map →")}</a> : undefined}>
      {groups.length ? (
        <dl className="ties">
          {groups.map((g) => (
            <div key={g.rel} className="ties__group">
              <dt>{g.rel.replace(/_/g, " ")}</dt>
              <dd>
                {g.items.map((it) => (
                  <span key={`${it.dir}:${it.ref.slug}`} className="ties__item" title={v(it.dir === "out" ? `This record ${g.rel.replace(/_/g, " ")} ${it.ref.title}` : `${it.ref.title} ${g.rel.replace(/_/g, " ")} this record`, it.dir === "out" ? `This ${g.rel} ${it.ref.title}` : `${it.ref.title} ${g.rel} this`)}>
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
        <Empty icon="link" title={v("No relationships yet", "No ties yet")}>
          {v("Nothing links to this record, and it links to nothing.", "An orphan: nothing links here, and it links nowhere.")}
        </Empty>
      )}
    </Panel>
  );
}

function GoalBlock({ g, voice: { v } }: { g: GoalCard; voice: Voice }) {
  const done = g.objectives.filter((o) => o.done).length;
  const u = urgency(g.daysLeft);
  const due = g.nextDue ?? g.due ?? g.deadline;
  const repeats = repeatLabel(g.repeat);
  return (
    <Panel title={v("Goal", "Quest")} icon="quest" aside={<a href={href.page("goals", `#${g.slug}`)}>{v("All goals →", "Quest board →")}</a>}>
      <div className="stack">
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <GoalSeal status={g.state ?? g.status} word={g.word} />
          </dd>
          {g.owner && (
            <>
              <dt>Owner</dt>
              <dd>
                <EntityLink entity={g.owner} />
              </dd>
            </>
          )}
          {g.counterparty && (
            <>
              <dt>{v("With", "With")}</dt>
              <dd>
                <EntityLink entity={g.counterparty} />
              </dd>
            </>
          )}
          {due && (
            <>
              <dt>{repeats && due !== g.due ? "Next due" : "Due"}</dt>
              <dd>
                <DateText date={due} /> <span className={`small due due--${u}`}>· {daysLeftLabel(g.daysLeft)}</span>
              </dd>
            </>
          )}
          {repeats && (
            <>
              <dt>Repeats</dt>
              <dd>
                {repeats}
                {g.lastDone && <span className="small muted"> · last done {shortDate(g.lastDone)}</span>}
              </dd>
            </>
          )}
          {g.campaign && (
            <>
              <dt>{v("Part of", "Campaign")}</dt>
              <dd>
                <EntityLink entity={g.campaign} />
              </dd>
            </>
          )}
          {g.progress && (
            <>
              <dt>Progress</dt>
              <dd>
                <ProgressBar name={g.title} done={g.progress.done} total={g.progress.total} size="sm" />
              </dd>
            </>
          )}
        </dl>
        {g.objectives.length > 0 && (
          <div className="stack" style={{ ["--gap" as string]: "8px" }}>
            <div className="row small muted">
              <Runes done={done} total={g.objectives.length} /> {done} of {g.objectives.length} {v("steps", "objectives")}
            </div>
            <ul className="objectives">
              {g.objectives.map((o, i) => (
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
      </div>
    </Panel>
  );
}

/** A guideline's standing: canon (✓) once enough sources or a person said it, else a rumor (?). */
function GuidelineItem({ g, me, refs, source, voice: { v } }: { g: GuidelineView; me?: string; refs: Map<string, Ref>; source?: Ref; voice: Voice }) {
  const status = g.status === "canon" ? "canon" : "rumor";
  return (
    <li className="mention">
      <div className="mention__meta">
        <Seal status={status} />
        {g.scope && <span className="chip">@ {g.scope}</span>}
        <span className="small muted">
          {g.byHuman ? (me && g.by.toLowerCase() !== me.toLowerCase() ? g.by : v("you", "your word")) : <AgentLink agent={g.by} refs={refs} />}
        </span>
        {source && (
          <span className="small muted">
            {v("from", "inherited from")} <EntityLink entity={source} />
          </span>
        )}
      </div>
      <span className="mention__text">
        <RichText text={g.rule} />
      </span>
    </li>
  );
}

function Guidelines({ g, me, refs, voice }: { g: NonNullable<EntityDetail["guidelines"]>; me?: string; refs: Map<string, Ref>; voice: Voice }) {
  const { v } = voice;
  return (
    <Panel title={v("Guidelines", "Customs")} icon="scroll" aside={v("how to deal with this", "how to treat this")}>
      <div className="stack" style={{ ["--gap" as string]: "12px" }}>
        {g.human.trim() && (
          <div>
            <div className="small muted">{v("Yours (the Guidelines section of the note)", "Your own (under ## Guidelines in the note)")}</div>
            <Markdown text={g.human} />
          </div>
        )}
        {g.items.length > 0 && (
          <ul className="list">
            {g.items.map((it, i) => (
              <GuidelineItem key={i} g={it} me={me} refs={refs} voice={voice} />
            ))}
          </ul>
        )}
        {g.inherited.length > 0 && (
          <ul className="list">
            {g.inherited.map((it, i) => (
              <GuidelineItem key={i} g={it} me={me} refs={refs} source={it.source} voice={voice} />
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function Contact({ d, voice: { v } }: { d: EntityDetail; voice: Voice }) {
  const st = d.stats;
  const c = d.cadence;
  const counts = Object.entries(st?.counts ?? {}).filter(([k]) => !k.includes("/"));
  return (
    <Panel title={v("Contact", "Encounters")} icon="hourglass">
      <dl className="kv">
        {st?.last_contact && (
          <>
            <dt>{v("Last contact", "Last met")}</dt>
            <dd>
              <DateText date={st.last_contact} />
            </dd>
          </>
        )}
        {st?.first_met && (
          <>
            <dt>{v("First contact", "First met")}</dt>
            <dd>
              <DateText date={st.first_met} />
            </dd>
          </>
        )}
        {c && (
          <>
            <dt>{v("Keep in touch", "Cadence")}</dt>
            <dd>
              {c.every === "none" ? v("no schedule", "none") : `every ${c.every}`}
              {c.due && (
                <span className={`small due due--${c.overdueDays ? "overdue" : "far"}`}>
                  {" "}
                  · {c.overdueDays ? `${plural(c.overdueDays, "day")} overdue` : `next by ${shortDate(c.due)}`}
                </span>
              )}
            </dd>
          </>
        )}
        {counts.length > 0 && (
          <>
            <dt>{v("Times", "Tally")}</dt>
            <dd className="row" style={{ ["--gap" as string]: "4px 10px" }}>
              {counts.map(([k, n]) => (
                <span key={k} className="chip">
                  {k} · {n}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </Panel>
  );
}

function Inherits({ refs, voice: { v } }: { refs: Ref[]; voice: Voice }) {
  return (
    <Panel title={v("Based on", "Inherits from")} icon="link" aside={v("defaults and guidelines come from these", "its customs come from these")}>
      <ol className="row" style={{ ["--gap" as string]: "4px 10px", listStyle: "none", margin: 0, padding: 0 }}>
        {refs.map((r, i) => (
          <li key={r.slug}>
            {i > 0 && (
              <span className="muted" aria-hidden>
                ›{" "}
              </span>
            )}
            <EntityLink entity={r} />
          </li>
        ))}
      </ol>
    </Panel>
  );
}

const QUESTION: Record<string, [glyph: string, plain: string, codex: string]> = {
  open: ["?", "open", "open"],
  answered: ["✓", "answered", "answered"],
  dropped: ["✕", "dropped", "let go"],
};

function Questions({ d, refs, voice: { v } }: { d: EntityDetail; refs: Map<string, Ref>; voice: Voice }) {
  const qs = [...(d.questions ?? [])].sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1));
  return (
    <Panel title={v("Open questions", "Riddles")} icon="eye" aside={`${qs.filter((q) => q.status === "open").length} open`}>
      <ul className="list">
        {qs.map((q) => {
          const [glyph, plain, codex] = QUESTION[q.status] ?? QUESTION.open!;
          return (
            <li key={q.id} className="mention">
              <div className="mention__meta">
                <span className={`seal seal--${q.status === "open" ? "rumor" : q.status === "answered" ? "canon" : "retconned"}`}>
                  <span className="seal__glyph" aria-hidden>
                    {glyph}
                  </span>
                  {v(plain, codex)}
                </span>
                {q.by && <AgentLink agent={q.by} refs={refs} />}
                {q.at && <RelTime at={q.at} />}
              </div>
              <span className="mention__text">
                <RichText text={q.q} />
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Decisions({ d, refs, voice: { v } }: { d: EntityDetail; refs: Map<string, Ref>; voice: Voice }) {
  const list = [...(d.decisions ?? [])].reverse();
  return (
    <Panel title={v("Decisions", "Decrees")} icon="council">
      <ul className="list">
        {list.map((x) => (
          <li key={x.id} className="mention">
            <div className="mention__meta">
              {x.by && <AgentLink agent={x.by} refs={refs} />}
              {x.at && <RelTime at={x.at} />}
              {x.revisit && <span className="chip">{v("revisit", "revisit")} {shortDate(x.revisit)}</span>}
            </div>
            <span className="mention__text">
              <RichText text={x.what} />
            </span>
            {x.why && <span className="small muted">Why: {x.why}</span>}
            {x.alternatives.length > 0 && <span className="small muted">{v("Instead of", "Over")}: {x.alternatives.join("; ")}</span>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function PartyBlock({ p, voice: { v } }: { p: PartyMember; voice: Voice }) {
  return (
    <Panel title={v("Agent", "Party member")} icon="party" aside={<a href={href.page("party", `#${p.slug}`)}>{v("All agents →", "The party →")}</a>}>
      <dl className="kv">
        {p.lane && (
          <>
            <dt>{v("Role", "Lane")}</dt>
            <dd>{p.lane}</dd>
          </>
        )}
        <dt>{v("Responsible for", "Authority")}</dt>
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
            <span className="muted">{v("nothing: its facts stay unverified", "none: its word counts as rumor")}</span>
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
          {v(plural(p.chronicled30d, "event"), plural(p.chronicled30d, "entry", "entries"))} in 30 days
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

function Disputes({ disputes, voice: { t, v } }: { disputes: DisputeView[]; voice: Voice }) {
  return (
    <Panel title={t("council")} icon="council">
      <ul className="list">
        {disputes.map((x) => (
          <li key={x.slug} className="mention">
            <div className="mention__meta">
              <strong>{fieldLabel(x.field)}</strong>
              {x.kind === "proposal" && <span className="chip chip--proposal">{v("suggestion", "petition")}</span>}
              {x.kind === "merge" && <span className="chip chip--proposal">{v("possible duplicate", "one soul?")}</span>}
              {x.status === "open" ? x.kind === "conflict" ? <Seal status="disputed" /> : <span className="chip">{x.state ?? "pending"}</span> : <span className="chip">{x.state ?? "resolved"}</span>}
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
                {x.kind === "conflict" ? v("Decide →", "Rule on it →") : v("Accept or decline →", "Answer it →")}
              </a>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Pending({ episodes, refs, voice: { v } }: { episodes: EpisodeView[]; refs: Map<string, Ref>; voice: Voice }) {
  const kindLabel = useKindLabel();
  return (
    <Panel title={v("In the inbox", "In the satchel")} icon="satchel" aside={v("processed at the next nightly update", "joins canon at the next sleep")}>
      <ul className="list">
        {episodes.map((ep) => (
          <li key={ep.id} className="mention">
            <div className="mention__meta">
              <AgentLink agent={ep.agent} refs={refs} />
              <span className="chip">{kindLabel(ep.kind)}</span>
              <RelTime at={ep.at} />
              {ep.waitedThroughSleep && (
                <span className="flag flag--stale" title={v("Older than the last nightly update: it failed or didn't fit in that run", "Older than the last sleep: it failed or didn't fit the batch")}>
                  <Icon name="hourglass" /> {v("delayed", "waited")}
                </span>
              )}
            </div>
            {ep.confidential && !ep.secret ? (
              <span className="episode--sealed">
                <span className="conf">
                  <span aria-hidden>◐</span> confidential
                </span>{" "}
                {v("Kept out of every view until it's consolidated.", "Kept from the table until the curator reads it.")}
              </span>
            ) : ep.secret || ep.text === null ? (
              <span className="episode--sealed">
                <span className="lock">
                  <Icon name="lock" size={14} /> {v("hidden", "sealed")}
                </span>{" "}
                {v("Contains a secret, so it stays hidden until it's encrypted.", "Carries a secret; hidden until the curator encrypts it.")}
              </span>
            ) : (
              <span className="mention__text">
                <RichText text={ep.text} />
              </span>
            )}
            <a className="small" href={href.page("satchel", `#${ep.id}`)}>
              {v("Open in the inbox →", "In the satchel →")}
            </a>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const MENTIONS_FIRST = 6;

function Mentions({ d, refs, voice: { v } }: { d: EntityDetail; refs: Map<string, Ref>; voice: Voice }) {
  const kindLabel = useKindLabel();
  const [all, setAll] = useState(false);
  const list = all ? d.mentions : d.mentions.slice(0, MENTIONS_FIRST);
  return (
    <Panel title={v("On the timeline", "In the chronicle")} icon="chronicle" aside={d.mentions.length ? `last 90 days · ${d.mentions.length}` : undefined}>
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
                  <span className="chip">{kindLabel(m.kind)}</span>
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
        <Empty icon="chronicle" title={v("No recent timeline events", "Not in the chronicle lately")}>
          {v("No processed note mentioned this record in the last 90 days.", "No consolidated episode touched this entry in the last 90 days.")}
        </Empty>
      )}
    </Panel>
  );
}

function NotFound({ slug, message }: { slug: string; message: string }) {
  const { t, v } = useTerms();
  const heading = v("Record not found", "Not in the codex");
  useEffect(() => {
    document.title = `${heading} · Hippocampus`;
  }, [heading]);
  return (
    <div className="panel notfound" role="alert">
      <Icon name="scroll" size={44} />
      <h1>{heading}</h1>
      <p>
        {v("No record is called", "No entry answers to")} <code>{slug}</code>.
      </p>
      <p className="muted">
        <RichText text={message.replace(/^no entity "[^"]*";?\s*/i, "").replace(/^did you mean/i, "Did you mean") || "The vault has no page by that name."} />
      </p>
      <div className="row" style={{ justifyContent: "center" }}>
        <a className="btn btn--primary" href={`${href.page("codex")}?q=${encodeURIComponent(slug)}`}>
          <Icon name="codex" /> {v(`Search ${t("codex")}`, "Search the Codex")}
        </a>
        <button type="button" className="btn" onClick={() => emit("palette:open", {})}>
          <Icon name="search" /> Search everything
        </button>
      </div>
    </div>
  );
}
