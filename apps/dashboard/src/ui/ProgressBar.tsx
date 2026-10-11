import { progressLabel, progressShape } from "../lib/progress.ts";

/**
 * A goal's progress: one cell per step up to 12 steps, a bar beyond. Read-only unless `onSet` is
 * given: then cells are clickable (click to fill up to one, click the last filled one to empty it),
 * arrow keys step it, and − / + buttons do the same for pointer and touch.
 */
export function ProgressBar({
  name,
  done,
  total,
  size = "md",
  onSet,
  disabled,
}: {
  name: string;
  done: number;
  total: number;
  size?: "sm" | "md";
  onSet?: (done: number) => void;
  disabled?: boolean;
}) {
  const p = progressShape(done, total);
  const interactive = !!onSet && !disabled;
  const set = (n: number) => onSet?.(Math.max(0, Math.min(p.total, n)));
  const label = `${name}: ${progressLabel(p.done, p.total)}`;
  const track = (
    <span
      className={`progress__track${p.segmented ? " progress__track--cells" : ""}`}
      role={interactive ? "slider" : "img"}
      aria-label={label}
      aria-valuemin={interactive ? 0 : undefined}
      aria-valuemax={interactive ? p.total : undefined}
      aria-valuenow={interactive ? p.done : undefined}
      aria-valuetext={interactive ? progressLabel(p.done, p.total) : undefined}
      tabIndex={interactive ? 0 : undefined}
      title={label}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowUp") (e.preventDefault(), set(p.done + 1));
              if (e.key === "ArrowLeft" || e.key === "ArrowDown") (e.preventDefault(), set(p.done - 1));
              if (e.key === "Home") (e.preventDefault(), set(0));
              if (e.key === "End") (e.preventDefault(), set(p.total));
            }
          : undefined
      }
    >
      {p.segmented ? (
        Array.from({ length: p.total }, (_, i) => (
          <span key={i} className={`progress__cell${i < p.done ? " progress__cell--on" : ""}`} onClick={interactive ? () => set(i + 1 === p.done ? i : i + 1) : undefined} />
        ))
      ) : (
        <span className="progress__fill" style={{ width: `${p.percent}%` }} />
      )}
    </span>
  );
  return (
    <span className={`progress progress--${size}${interactive ? " progress--live" : ""}`}>
      {interactive && (
        <button type="button" className="btn btn--ghost btn--sm progress__step" onClick={() => set(p.done - 1)} disabled={p.done <= 0} aria-label={`${name}: one step back`}>
          −
        </button>
      )}
      {track}
      {interactive && (
        <button type="button" className="btn btn--ghost btn--sm progress__step" onClick={() => set(p.done + 1)} disabled={p.done >= p.total} aria-label={`${name}: one step forward`}>
          +
        </button>
      )}
      <span className="progress__count mono" aria-hidden>
        {p.done}/{p.total}
      </span>
    </span>
  );
}
