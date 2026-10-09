import { useId } from "react";
import { clockSegments } from "../lib/clock.ts";

/**
 * A Blades-style progress clock. Read-only unless `onSet` is given: then each segment is a
 * button (click to fill up to it, click the last filled one to empty it) and arrow keys step it.
 */
export function ClockDial({ name, segments, filled, size = 64, onSet, disabled }: { name: string; segments: number; filled: number; size?: number; onSet?: (filled: number) => void; disabled?: boolean }) {
  const id = useId();
  const r = size / 2 - 3;
  const paths = clockSegments(segments, r, size / 2);
  const interactive = !!onSet && !disabled;
  const set = (n: number) => onSet?.(Math.max(0, Math.min(segments, n)));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={`clock${interactive ? " clock--live" : ""}`}
      role={interactive ? "slider" : "img"}
      aria-label={`${name}: ${filled} of ${segments}`}
      aria-valuemin={interactive ? 0 : undefined}
      aria-valuemax={interactive ? segments : undefined}
      aria-valuenow={interactive ? filled : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowUp") (e.preventDefault(), set(filled + 1));
              if (e.key === "ArrowLeft" || e.key === "ArrowDown") (e.preventDefault(), set(filled - 1));
            }
          : undefined
      }
    >
      <title id={id}>{`${name}: ${filled}/${segments}`}</title>
      <circle cx={size / 2} cy={size / 2} r={r + 1.5} className="clock__rim" />
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          className={`clock__seg${i < filled ? " clock__seg--on" : ""}`}
          onClick={interactive ? () => set(i + 1 === filled ? i : i + 1) : undefined}
        />
      ))}
    </svg>
  );
}
