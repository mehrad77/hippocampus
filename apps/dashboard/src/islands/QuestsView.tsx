import { useEffect, useId, useState } from "react";
import "../styles/play.css";
import { useResource } from "../lib/cache.ts";
import { daysLeftLabel, plural, shortDate, urgency } from "../lib/format.ts";
import { useTerms } from "../lib/prefs.ts";
import { href } from "../lib/routes.ts";
import type { Overview, QuestCard, SessionInfo } from "../lib/types.ts";
import { ClockDial } from "../ui/ClockDial.tsx";
import { EntityLink } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Empty, RelTime, Runes, SkeletonPanel } from "../ui/Parts.tsx";
import { RichText } from "../ui/RichText.tsx";
import { updateQuest, updateQuestSoon, useHashTarget } from "../ui/play/actions.ts";
import { Ornament, PageHead, QuestSeal } from "../ui/play/Bits.tsx";
import { QUEST_STATUSES, clockProblem, groupQuests, isQuestStatus, nextDue, objectiveProblem, questStatusWord } from "../ui/play/model.ts";

export default function QuestsView() {
  return <PageGate>{(session) => <QuestBoard session={session} />}</PageGate>;
}

function QuestBoard({ session }: { session: SessionInfo }) {
  const { t, v, look } = useTerms();
  const { data: o, error } = useResource<Overview>("/overview", { poll: 60_000 });
  useHashTarget(!!o);
  if (error && !o) return <div className="callout callout--danger">{error.message}</div>;
  if (!o)
    return (
      <div className="stack">
        <SkeletonPanel lines={3} />
        <div className="grid grid--3">
          <SkeletonPanel lines={6} />
          <SkeletonPanel lines={6} />
          <SkeletonPanel lines={6} />
        </div>
      </div>
    );

  const editable = session.capabilities.quest;
  const { board, dormant, finished } = groupQuests(o.quests);
  const blocked = board.filter((q) => q.status === "blocked").length;
  const overdue = board.filter((q) => q.daysLeft !== undefined && q.daysLeft < 0).length;
  const next = nextDue(board, look);

  return (
    <div className="stack play" style={{ ["--gap" as string]: "28px" }}>
      <PageHead
        kicker={v<React.ReactNode>(o.campaign, <>Quest board · {o.campaign}</>)}
        title={v(t("quests"), "The Quest Board")}
        lede={
          o.quests.length ? (
            <>
              {plural(board.length, t("quest"))} {v("in progress", "in motion")}
              {blocked ? `, ${blocked} blocked` : ""}
              {overdue ? `, ${overdue} overdue` : ""}.{" "}
              {next && (
                <>
                  Next due: <a href={`#${next.slug}`}>{next.what}</a>, {daysLeftLabel(next.daysLeft)}.{" "}
                </>
              )}
              {editable
                ? v("Check off steps, update progress and set deadlines here. Each change is saved to the vault right away.", "Tick objectives, wind clocks and set deadlines here: each change is written to the vault right away.")
                : v("Read-only: this dashboard's data source doesn't accept changes to goals.", "Read-only here: this dashboard's source doesn't accept quest updates.")}
            </>
          ) : (
            v("Goals are what your agents work toward: steps to check off, progress to track, deadlines to meet.", "Quests are the party's goals: objectives to tick, clocks to fill, deadlines to beat.")
          )
        }
        action={
          <a className="btn btn--ghost btn--sm" href={href.guide("quests-and-clocks")}>
            <Icon name="guides" size={16} /> {v("How goals and progress tracking work", "How quests and clocks work")}
          </a>
        }
      />

      {!o.quests.length ? (
        <div className="panel">
          <Empty icon="quest" title={v("No goals yet", "The board is bare")}>
            {v(
              "Add a goal note (quests/ folder) in Obsidian, or ask an agent to create one. It shows up here as soon as it exists.",
              "No quests yet. Add a quest note in Obsidian, or ask your game master agent to post one. It's pinned here as soon as it exists.",
            )}
          </Empty>
        </div>
      ) : (
        <>
          <section aria-labelledby="board-h" className="stack" style={{ ["--gap" as string]: "14px" }}>
            <h2 className="play-h" id="board-h">
              <Icon name="quest" /> {v("In progress", "On the board")} <span className="play-h__count">{board.length}</span>
            </h2>
            {board.length ? (
              <ul className="board" aria-label={v("Active and blocked goals", "Active and blocked quests")}>
                {board.map((q) => (
                  <QuestNotice key={q.slug} q={q} today={o.today} editable={editable} />
                ))}
              </ul>
            ) : (
              <div className="board board--empty">
                <Empty icon="quest" title={v("Nothing in progress", "Nothing in motion")}>
                  {editable
                    ? v("Every goal is on hold or finished. Set one to Active below to resume it.", "Every quest is dormant or finished. Wake one below by setting it to active.")
                    : v("Every goal is on hold or finished. Add a new goal in Obsidian.", "Every quest is dormant or finished. Post a new quest in Obsidian.")}
                </Empty>
              </div>
            )}
          </section>

          {dormant.length > 0 && (
            <section aria-labelledby="dormant-h" className="stack" style={{ ["--gap" as string]: "14px" }}>
              <Ornament id="dormant-h">
                {v("On hold", "Dormant")} · {dormant.length}
              </Ornament>
              <p className="muted small play-note">{v("Paused for now. Set one back to Active to move it to the goals in progress.", "Set aside, not forgotten. Set one back to active to pin it on the board again.")}</p>
              <ul className="board board--quiet" aria-label={v("Goals on hold", "Dormant quests")}>
                {dormant.map((q) => (
                  <QuestNotice key={q.slug} q={q} today={o.today} editable={editable} />
                ))}
              </ul>
            </section>
          )}

          {finished.length > 0 && <CompletedTales quests={finished} today={o.today} editable={editable} />}
        </>
      )}
    </div>
  );
}

// ── One notice on the board ────────────────────────────────────────────────

function QuestNotice({ q, today, editable }: { q: QuestCard; today: string; editable: boolean }) {
  const { v } = useTerms();
  const done = q.objectives.filter((x) => x.done).length;
  const u = urgency(q.daysLeft);
  return (
    <li className={`notice notice--${q.status ?? "active"}`} id={q.slug}>
      <span className="notice__pin" aria-hidden />
      <header className="notice__head">
        <h3 className="notice__title">
          <EntityLink entity={q} />
        </h3>
        <QuestSeal status={q.status} />
      </header>

      <div className="notice__meta small">
        {q.campaign && (
          <span>
            <span className="muted">in</span> <EntityLink entity={q.campaign} />
          </span>
        )}
        {q.owner ? (
          <span>
            <span className="muted">owner</span> <EntityLink entity={q.owner} />
          </span>
        ) : (
          <span className="muted">no owner</span>
        )}
      </div>

      {q.deadline && (
        <div className={`notice__due due due--${u ?? "far"}`}>
          <Icon name="hourglass" size={16} />
          <span>
            Due {shortDate(q.deadline)}
            {q.daysLeft !== undefined && <strong> · {daysLeftLabel(q.daysLeft)}</strong>}
          </span>
        </div>
      )}

      {q.summary && <RichText text={q.summary} className="notice__summary" />}

      <div className="notice__section">
        <div className="notice__label">
          <span>{v("Steps", "Objectives")}</span>
          {q.objectives.length > 0 && (
            <span className="row small" style={{ ["--gap" as string]: "6px" }}>
              <Runes done={done} total={q.objectives.length} /> {done}/{q.objectives.length}
            </span>
          )}
        </div>
        <Objectives q={q} today={today} editable={editable} />
      </div>

      {(q.clocks.length > 0 || editable) && (
        <div className="notice__section">
          <div className="notice__label">
            <span>{v("Progress", "Clocks")}</span>
          </div>
          <Clocks q={q} today={today} editable={editable} />
        </div>
      )}

      {editable && <Controls q={q} today={today} />}
    </li>
  );
}

function Objectives({ q, today, editable }: { q: QuestCard; today: string; editable: boolean }) {
  const { v } = useTerms();
  return (
    <>
      {q.objectives.length ? (
        <ul className="quest-objectives">
          {q.objectives.map((ob) => (
            <li key={ob.text} className={`objective${ob.done ? " objective--done" : ""}`}>
              {editable ? (
                <label className="objective__row">
                  <input type="checkbox" checked={ob.done} onChange={() => void updateQuest(q, ob.done ? { reopen: [ob.text] } : { complete: [ob.text] }, today)} />
                  <RichText text={ob.text} />
                </label>
              ) : (
                <span className="objective__row">
                  <span className="objective__mark" aria-hidden>
                    {ob.done ? "✓" : "○"}
                  </span>
                  <span className="sr-only">{ob.done ? "Done: " : "To do: "}</span>
                  <RichText text={ob.text} />
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small play-note">{v("No steps yet.", "No objectives yet.")}</p>
      )}
      {editable && <AddObjective q={q} today={today} />}
    </>
  );
}

function AddObjective({ q, today }: { q: QuestCard; today: string }) {
  const { v, look } = useTerms();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const errId = useId();
  const problem = objectiveProblem(q, text, look);
  if (!open)
    return (
      <button type="button" className="btn btn--ghost btn--sm notice__add" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} /> {v("Add a step", "Add objective")}
      </button>
    );
  const close = () => {
    setOpen(false);
    setText("");
    setTried(false);
  };
  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem) return;
    void updateQuest(q, { add: [text.trim()] }, today);
    close();
  };
  return (
    <form className="inline-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), close())}>
      <input
        className="input input--sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Book the biometric photos"
        aria-label={v(`New step for ${q.title}`, `New objective for ${q.title}`)}
        aria-invalid={tried && !!problem}
        aria-describedby={tried && problem ? errId : undefined}
        maxLength={300}
        autoFocus
      />
      <button type="submit" className="btn btn--sm btn--primary">
        Add
      </button>
      <button type="button" className="btn btn--sm btn--ghost" onClick={close}>
        Cancel
      </button>
      {tried && problem && (
        <span className="field-error small" id={errId} role="alert">
          {problem}
        </span>
      )}
    </form>
  );
}

function Clocks({ q, today, editable }: { q: QuestCard; today: string; editable: boolean }) {
  const { v } = useTerms();
  return (
    <>
      {q.clocks.length > 0 && (
        <ul className="quest-clocks">
          {q.clocks.map((c) => (
            <li key={c.name} className="clockbox">
              <ClockDial name={c.name} segments={c.segments} filled={c.filled} size={58} onSet={editable ? (filled) => updateQuestSoon(q, { clock: { name: c.name, filled } }, today, `clock:${c.name}`) : undefined} />
              <span className="clockbox__name">{c.name}</span>
              <span className="clockbox__count mono">
                {c.filled}/{c.segments}
              </span>
              {c.deadline && (
                <span className={`small due due--${urgency(c.daysLeft) ?? "far"}`} title={shortDate(c.deadline)}>
                  {c.daysLeft !== undefined ? daysLeftLabel(c.daysLeft) : shortDate(c.deadline)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && q.clocks.length > 0 && (
        <p className="hint play-note">{v("Click a part to fill the tracker up to it, or select a tracker and use the arrow keys.", "Click a segment to fill the clock up to it, or focus a clock and use the arrow keys.")}</p>
      )}
      {editable && <AddClock q={q} today={today} />}
    </>
  );
}

function AddClock({ q, today }: { q: QuestCard; today: string }) {
  const { v, look } = useTerms();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [segments, setSegments] = useState(4);
  const [tried, setTried] = useState(false);
  const errId = useId();
  const problem = clockProblem(q, name, segments, look);
  if (!open)
    return (
      <button type="button" className="btn btn--ghost btn--sm notice__add" onClick={() => setOpen(true)}>
        <Icon name="clock" size={16} /> {v("Add a progress tracker", "Add a clock")}
      </button>
    );
  const close = () => {
    setOpen(false);
    setName("");
    setSegments(4);
    setTried(false);
  };
  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem) return;
    void updateQuest(q, { clock: { name: name.trim(), segments } }, today);
    close();
  };
  return (
    <form className="inline-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), close())}>
      <input
        className="input input--sm"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={v("Name, e.g. Paperwork", "Clock name, e.g. Landlord patience")}
        aria-label={v(`New progress tracker name for ${q.title}`, `New clock name for ${q.title}`)}
        aria-invalid={tried && !!problem}
        aria-describedby={tried && problem ? errId : undefined}
        maxLength={100}
        autoFocus
      />
      <select className="select select--sm" value={segments} onChange={(e) => setSegments(Number(e.target.value))} aria-label={v("Number of parts", "Segments")}>
        {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => (
          <option key={n} value={n}>
            {n} {v("parts", "segments")}
          </option>
        ))}
      </select>
      <button type="submit" className="btn btn--sm btn--primary">
        {v("Add tracker", "Add clock")}
      </button>
      <button type="button" className="btn btn--sm btn--ghost" onClick={close}>
        Cancel
      </button>
      {tried && problem && (
        <span className="field-error small" id={errId} role="alert">
          {problem}
        </span>
      )}
    </form>
  );
}

/** Status and deadline: the quest's frontmatter, edited in place. */
function Controls({ q, today }: { q: QuestCard; today: string }) {
  const { look } = useTerms();
  const current = q.deadline && /^\d{4}-\d{2}-\d{2}/.test(q.deadline) ? q.deadline.slice(0, 10) : "";
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const statusId = useId();
  const dateId = useId();
  const changed = /^\d{4}-\d{2}-\d{2}$/.test(draft) && draft !== current;
  return (
    <div className="notice__controls">
      <div className="field">
        <label htmlFor={statusId}>Status</label>
        <select
          id={statusId}
          className="select select--sm"
          value={isQuestStatus(q.status) ? q.status : "active"}
          onChange={(e) => {
            const status = e.target.value;
            if (isQuestStatus(status)) void updateQuest(q, { status }, today);
          }}
        >
          {QUEST_STATUSES.map((s) => (
            <option key={s} value={s}>
              {questStatusWord(s, look)}
            </option>
          ))}
        </select>
      </div>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) void updateQuest(q, { deadline: draft }, today);
        }}
      >
        <label htmlFor={dateId}>Deadline</label>
        <span className="row" style={{ ["--gap" as string]: "6px", flexWrap: "nowrap" }}>
          <input id={dateId} type="date" className="input input--sm" value={draft} onChange={(e) => setDraft(e.target.value)} />
          {changed && (
            <button type="submit" className="btn btn--sm btn--primary" aria-label={`Set deadline to ${shortDate(draft)}`}>
              Set
            </button>
          )}
        </span>
      </form>
    </div>
  );
}

// ── Done and failed ────────────────────────────────────────────────────────

function CompletedTales({ quests, today, editable }: { quests: QuestCard[]; today: string; editable: boolean }) {
  const { t, v } = useTerms();
  const done = quests.filter((q) => q.status === "done").length;
  return (
    <details className="tales">
      <summary className="tales__summary">
        <Icon name="chevron" className="tales__chev" />
        <span className="tales__title">{v("Finished goals", "Completed tales")}</span>
        <span className="muted small">
          {done} done{quests.length - done ? ` · ${quests.length - done} failed` : ""}
        </span>
      </summary>
      <ul className="list tales__list">
        {quests.map((q) => {
          const n = q.objectives.filter((x) => x.done).length;
          return (
            <li key={q.slug} id={q.slug} className="tale">
              <span className="tale__main">
                <EntityLink entity={q} />
                <QuestSeal status={q.status} />
              </span>
              <span className="tale__meta small muted">
                {q.objectives.length > 0 && (
                  <span className="row" style={{ ["--gap" as string]: "6px" }}>
                    <Runes done={n} total={q.objectives.length} /> {n}/{q.objectives.length}
                  </span>
                )}
                {q.owner && <span>{q.owner.title}</span>}
                {q.updated && (
                  <span>
                    {v("last updated", "last touched")} <RelTime at={q.updated} />
                  </span>
                )}
              </span>
              {editable && (
                <button type="button" className="btn btn--sm" onClick={() => void updateQuest(q, { status: "active" }, today)} title={v("Set this goal back to Active", "Set this quest back to active and pin it on the board")}>
                  <Icon name="refresh" size={16} /> Reopen
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="small muted play-note">
        {v("Their full history is in the ", "Their full story lives in the ")}
        <a href={href.page("chronicle")}>{v(t("chronicle").toLowerCase(), "chronicle")}</a>.
      </p>
    </details>
  );
}
