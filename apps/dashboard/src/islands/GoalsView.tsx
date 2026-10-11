import { useEffect, useId, useState } from "react";
import "../styles/play.css";
import { useResource } from "../lib/cache.ts";
import { daysLeftLabel, plural, shortDate, urgency } from "../lib/format.ts";
import { useTerms } from "../lib/prefs.ts";
import { REPEAT_CHOICES, repeatLabel } from "../lib/progress.ts";
import { href } from "../lib/routes.ts";
import type { GoalCard, Overview, SessionInfo } from "../lib/types.ts";
import { EntityLink } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Empty, RelTime, Runes, SkeletonPanel } from "../ui/Parts.tsx";
import { ProgressBar } from "../ui/ProgressBar.tsx";
import { RichText } from "../ui/RichText.tsx";
import { updateGoal, updateGoalSoon, useHashTarget, type GoalRef } from "../ui/play/actions.ts";
import { GoalSeal, Ornament, PageHead } from "../ui/play/Bits.tsx";
import { goalsOf, groupGoals, nextDue, objectiveProblem, progressProblem, stateOf, statusOptions } from "../ui/play/model.ts";

export default function GoalsView() {
  return <PageGate>{(session) => <GoalBoard session={session} />}</PageGate>;
}

/** Each goal type's status words (`statuses:` in its type note), by type name. */
type Vocab = Map<string, Record<string, string> | undefined>;

function GoalBoard({ session }: { session: SessionInfo }) {
  const { t, v } = useTerms();
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

  const vocab: Vocab = new Map((o.schema?.types ?? []).map((ty) => [ty.name, ty.statuses]));
  const editable = session.capabilities.goal ?? session.capabilities.quest;
  const goals = goalsOf(o);
  const { board, dormant, finished } = groupGoals(goals);
  const blocked = board.filter((g) => (g.state ?? g.status) === "blocked").length;
  const overdue = board.filter((g) => g.daysLeft !== undefined && g.daysLeft < 0).length;
  const next = nextDue(board);
  const name = o.name ?? o.campaign;

  return (
    <div className="stack play" style={{ ["--gap" as string]: "28px" }}>
      <PageHead
        kicker={v<React.ReactNode>(name, <>Quest board · {name}</>)}
        title={v(t("goals"), "The Quest Board")}
        lede={
          goals.length ? (
            <>
              {plural(board.length, t("goal"))} {v("in progress", "in motion")}
              {blocked ? `, ${blocked} blocked` : ""}
              {overdue ? `, ${overdue} overdue` : ""}.{" "}
              {next && (
                <>
                  Next due: <a href={`#${next.slug}`}>{next.what}</a>, {daysLeftLabel(next.daysLeft)}.{" "}
                </>
              )}
              {editable
                ? v("Check off steps, move progress and set due dates here. Each change is saved to the vault right away.", "Tick objectives, mark progress and set due dates here: each change is written to the vault right away.")
                : v("Read-only: this dashboard's data source doesn't accept changes to goals.", "Read-only here: this dashboard's source doesn't accept quest updates.")}
            </>
          ) : (
            v("Goals are what you and your agents work toward: steps to check off, progress to track, due dates to meet.", "Quests are the party's goals: objectives to tick, progress to mark, due dates to beat.")
          )
        }
        action={
          <a className="btn btn--ghost btn--sm" href={href.guide("goals-and-progress")}>
            <Icon name="guides" size={16} /> {v("How goals and progress work", "How quests and progress work")}
          </a>
        }
      />

      {!goals.length ? (
        <div className="panel">
          <Empty icon="quest" title={v("No goals yet", "The board is bare")}>
            {v(
              "Add a goal note (goals/ folder) in Obsidian, or ask an agent to create one. It shows up here as soon as it exists.",
              "No quests yet. Add a goal note in Obsidian, or ask an agent to post one. It's pinned here as soon as it exists.",
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
                {board.map((g) => (
                  <GoalNotice key={g.slug} g={g} today={o.today} editable={editable} statuses={vocab.get(g.type)} />
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
                {dormant.map((g) => (
                  <GoalNotice key={g.slug} g={g} today={o.today} editable={editable} statuses={vocab.get(g.type)} />
                ))}
              </ul>
            </section>
          )}

          {finished.length > 0 && <Finished goals={finished} today={o.today} editable={editable} vocab={vocab} />}
        </>
      )}
    </div>
  );
}

const refOf = (g: GoalCard, statuses?: Record<string, string>): GoalRef => ({ slug: g.slug, title: g.title, statuses });

// ── One notice on the board ────────────────────────────────────────────────

function GoalNotice({ g, today, editable, statuses }: { g: GoalCard; today: string; editable: boolean; statuses?: Record<string, string> }) {
  const { v } = useTerms();
  const done = g.objectives.filter((x) => x.done).length;
  const state = g.state ?? stateOf(g.status, statuses);
  const due = g.nextDue ?? g.due ?? g.deadline;
  const u = urgency(g.daysLeft);
  const repeats = repeatLabel(g.repeat);
  return (
    <li className={`notice notice--${state}`} id={g.slug}>
      <span className="notice__pin" aria-hidden />
      <header className="notice__head">
        <h3 className="notice__title">
          <EntityLink entity={g} />
        </h3>
        <GoalSeal status={state} word={g.word} />
      </header>

      <div className="notice__meta small">
        {g.campaign && (
          <span>
            <span className="muted">in</span> <EntityLink entity={g.campaign} />
          </span>
        )}
        {g.owner ? (
          <span>
            <span className="muted">owner</span> <EntityLink entity={g.owner} />
          </span>
        ) : (
          <span className="muted">no owner</span>
        )}
        {g.counterparty && (
          <span>
            <span className="muted">{v("with", "with")}</span> <EntityLink entity={g.counterparty} />
          </span>
        )}
        {repeats && (
          <span title={g.lastDone ? `Last done ${shortDate(g.lastDone)}` : undefined}>
            <Icon name="refresh" size={14} /> {v("repeats", "returns")} {repeats}
          </span>
        )}
      </div>

      {due && (
        <div className={`notice__due due due--${u ?? "far"}`}>
          <Icon name="hourglass" size={16} />
          <span>
            {repeats && due !== g.due ? v("Next due", "Next due") : "Due"} {shortDate(due)}
            {g.daysLeft !== undefined && <strong> · {daysLeftLabel(g.daysLeft)}</strong>}
          </span>
        </div>
      )}

      {g.summary && <RichText text={g.summary} className="notice__summary" />}

      <div className="notice__section">
        <div className="notice__label">
          <span>{v("Steps", "Objectives")}</span>
          {g.objectives.length > 0 && (
            <span className="row small" style={{ ["--gap" as string]: "6px" }}>
              <Runes done={done} total={g.objectives.length} /> {done}/{g.objectives.length}
            </span>
          )}
        </div>
        <Objectives g={g} today={today} editable={editable} statuses={statuses} />
      </div>

      {(g.progress || editable) && (
        <div className="notice__section">
          <div className="notice__label">
            <span>Progress</span>
          </div>
          <Progress g={g} today={today} editable={editable} statuses={statuses} />
        </div>
      )}

      {editable && <Controls g={g} today={today} statuses={statuses} />}
    </li>
  );
}

function Objectives({ g, today, editable, statuses }: { g: GoalCard; today: string; editable: boolean; statuses?: Record<string, string> }) {
  const { v } = useTerms();
  const ref = refOf(g, statuses);
  return (
    <>
      {g.objectives.length ? (
        <ul className="quest-objectives">
          {g.objectives.map((ob) => (
            <li key={ob.text} className={`objective${ob.done ? " objective--done" : ""}`}>
              {editable ? (
                <label className="objective__row">
                  <input type="checkbox" checked={ob.done} onChange={() => void updateGoal(ref, ob.done ? { reopen: [ob.text] } : { complete: [ob.text] }, today)} />
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
      {editable && <AddObjective g={g} today={today} statuses={statuses} />}
    </>
  );
}

function AddObjective({ g, today, statuses }: { g: GoalCard; today: string; statuses?: Record<string, string> }) {
  const { v, look } = useTerms();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const errId = useId();
  const problem = objectiveProblem(g, text, look);
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
    void updateGoal(refOf(g, statuses), { add: [text.trim()] }, today);
    close();
  };
  return (
    <form className="inline-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), close())}>
      <input
        className="input input--sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Book the biometric photos"
        aria-label={v(`New step for ${g.title}`, `New objective for ${g.title}`)}
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

function Progress({ g, today, editable, statuses }: { g: GoalCard; today: string; editable: boolean; statuses?: Record<string, string> }) {
  const { v } = useTerms();
  const ref = refOf(g, statuses);
  return (
    <div className="stack" style={{ ["--gap" as string]: "8px" }}>
      {g.progress ? (
        <div className="goal-progress">
          <ProgressBar
            name={g.title}
            done={g.progress.done}
            total={g.progress.total}
            onSet={editable ? (done) => updateGoalSoon(ref, { progress: { done } }, today, "progress") : undefined}
          />
        </div>
      ) : (
        !editable && <p className="muted small play-note">{v("No progress tracked.", "No progress marked.")}</p>
      )}
      {editable && <SetTotal g={g} today={today} statuses={statuses} />}
    </div>
  );
}

/** Start tracking progress, or change how many steps make it done. */
function SetTotal({ g, today, statuses }: { g: GoalCard; today: string; statuses?: Record<string, string> }) {
  const { v, look } = useTerms();
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState(g.progress?.total ?? 4);
  const [tried, setTried] = useState(false);
  const errId = useId();
  const problem = progressProblem(total, look);
  if (!open)
    return (
      <button type="button" className="btn btn--ghost btn--sm notice__add" onClick={() => setOpen(true)}>
        <Icon name="clock" size={16} /> {g.progress ? v("Change the number of steps", "Change the steps") : v("Track progress", "Mark progress")}
      </button>
    );
  const close = () => {
    setOpen(false);
    setTried(false);
  };
  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem) return;
    void updateGoal(refOf(g, statuses), { progress: { total, done: g.progress?.done ?? 0 } }, today);
    close();
  };
  return (
    <form className="inline-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), close())}>
      <label className="small" htmlFor={`${errId}-n`}>
        {v("Steps to done", "Steps")}
      </label>
      <input
        id={`${errId}-n`}
        className="input input--sm"
        type="number"
        min={1}
        max={1000}
        value={Number.isFinite(total) ? total : ""}
        onChange={(e) => setTotal(Number(e.target.value))}
        aria-invalid={tried && !!problem}
        aria-describedby={tried && problem ? errId : undefined}
        style={{ width: "6em" }}
        autoFocus
      />
      <button type="submit" className="btn btn--sm btn--primary">
        Set
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

/** Status, due date and repeat: the goal's frontmatter, edited in place. */
function Controls({ g, today, statuses }: { g: GoalCard; today: string; statuses?: Record<string, string> }) {
  const { look, v } = useTerms();
  const ref = refOf(g, statuses);
  const currentDue = (g.due ?? g.deadline) && /^\d{4}-\d{2}-\d{2}/.test(g.due ?? g.deadline ?? "") ? (g.due ?? g.deadline)!.slice(0, 10) : "";
  const [draft, setDraft] = useState(currentDue);
  useEffect(() => setDraft(currentDue), [currentDue]);
  const statusId = useId();
  const dateId = useId();
  const repeatId = useId();
  const changed = /^\d{4}-\d{2}-\d{2}$/.test(draft) && draft !== currentDue;
  const options = statusOptions(statuses, look);
  const word = g.word ?? g.status ?? "active";
  const known = options.some((o) => o.word.toLowerCase() === word.toLowerCase());
  const every = g.repeat?.every ?? "";
  return (
    <div className="notice__controls">
      <div className="field">
        <label htmlFor={statusId}>Status</label>
        <select id={statusId} className="select select--sm" value={known ? options.find((o) => o.word.toLowerCase() === word.toLowerCase())!.word : word} onChange={(e) => void updateGoal(ref, { status: e.target.value }, today)}>
          {!known && <option value={word}>{word}</option>}
          {options.map((o) => (
            <option key={o.word} value={o.word}>
              {o.label}
              {o.label.toLowerCase() !== o.state && !(look === "plain" && o.word === o.state) ? ` (${o.state})` : ""}
            </option>
          ))}
        </select>
      </div>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) void updateGoal(ref, { due: draft }, today);
        }}
      >
        <label htmlFor={dateId}>{v("Due", "Due")}</label>
        <span className="row" style={{ ["--gap" as string]: "6px", flexWrap: "nowrap" }}>
          <input id={dateId} type="date" className="input input--sm" value={draft} onChange={(e) => setDraft(e.target.value)} />
          {changed && (
            <button type="submit" className="btn btn--sm btn--primary" aria-label={`Set due date to ${shortDate(draft)}`}>
              Set
            </button>
          )}
          {currentDue && !changed && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void updateGoal(ref, { due: null }, today)} aria-label="Clear the due date">
              Clear
            </button>
          )}
        </span>
      </form>
      <div className="field">
        <label htmlFor={repeatId}>Repeats</label>
        <select
          id={repeatId}
          className="select select--sm"
          value={every}
          onChange={(e) => void updateGoal(ref, { repeat: e.target.value ? { every: e.target.value, ...(g.repeat?.after_last ? { after_last: g.repeat.after_last } : {}) } : null }, today)}
        >
          <option value="">never</option>
          {every && !REPEAT_CHOICES.some((c) => c.every === every) && <option value={every}>every {every}</option>}
          {REPEAT_CHOICES.map((c) => (
            <option key={c.every} value={c.every}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ── Done and failed ────────────────────────────────────────────────────────

function Finished({ goals, today, editable, vocab }: { goals: GoalCard[]; today: string; editable: boolean; vocab: Vocab }) {
  const { t, v } = useTerms();
  const done = goals.filter((g) => (g.state ?? g.status) === "done").length;
  return (
    <details className="tales">
      <summary className="tales__summary">
        <Icon name="chevron" className="tales__chev" />
        <span className="tales__title">{v("Finished goals", "Completed tales")}</span>
        <span className="muted small">
          {done} done{goals.length - done ? ` · ${goals.length - done} failed` : ""}
        </span>
      </summary>
      <ul className="list tales__list">
        {goals.map((g) => {
          const n = g.objectives.filter((x) => x.done).length;
          return (
            <li key={g.slug} id={g.slug} className="tale">
              <span className="tale__main">
                <EntityLink entity={g} />
                <GoalSeal status={g.state ?? g.status} word={g.word} />
              </span>
              <span className="tale__meta small muted">
                {g.objectives.length > 0 && (
                  <span className="row" style={{ ["--gap" as string]: "6px" }}>
                    <Runes done={n} total={g.objectives.length} /> {n}/{g.objectives.length}
                  </span>
                )}
                {g.owner && <span>{g.owner.title}</span>}
                {g.updated && (
                  <span>
                    {v("last updated", "last touched")} <RelTime at={g.updated} />
                  </span>
                )}
              </span>
              {editable && (
                <button type="button" className="btn btn--sm" onClick={() => void updateGoal(refOf(g, vocab.get(g.type)), { status: "active" }, today)} title={v("Set this goal back to Active", "Set this quest back to active and pin it on the board")}>
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
