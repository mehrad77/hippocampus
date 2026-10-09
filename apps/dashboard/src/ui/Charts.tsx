import { useState } from "react";
import { shortDate } from "../lib/format.ts";
import { useTerms } from "../lib/prefs.ts";
import type { FactStatus, Overview } from "../lib/types.ts";

const STATUS_ORDER: FactStatus[] = ["canon", "rumor", "disputed", "retconned"];

/** How the vault's facts split by status: one stacked bar with a legend that carries the numbers. */
export function StatusMeter({ facts }: { facts: Record<FactStatus, number> }) {
  const { t, v } = useTerms();
  const total = STATUS_ORDER.reduce((n, s) => n + facts[s], 0);
  if (!total) return <p className="muted small">{v("No facts yet. They appear after the first nightly update.", "No facts yet. They appear after the first sleep.")}</p>;
  const counted = (s: FactStatus) => `${facts[s]} ${t(s).toLowerCase()}`;
  return (
    <div className="stack" style={{ ["--gap" as string]: "10px" }}>
      <div className="meter" role="img" aria-label={STATUS_ORDER.map(counted).join(", ")}>
        {STATUS_ORDER.filter((s) => facts[s]).map((s) => (
          <span key={s} className={`meter__seg meter__seg--${s}`} style={{ flexGrow: facts[s] }} title={counted(s)} />
        ))}
      </div>
      <div className="legend">
        {STATUS_ORDER.map((s) => (
          <span key={s}>
            <i className={`swatch swatch--${s}`} aria-hidden />
            {t(s)} <strong>{facts[s]}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Thirty days of chronicle entries as columns; hover a day for who wrote what. */
export function ActivityBars({ days }: { days: Overview["activity"] }) {
  const { v } = useTerms();
  const processed = v("processed", "chronicled");
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.chronicled + d.remembered));
  const W = 600;
  const H = 120;
  const pad = { l: 26, r: 6, t: 8, b: 20 };
  const band = (W - pad.l - pad.r) / days.length;
  const bw = Math.min(14, band - 3);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const top = Math.ceil(max);
  const d = hover === null ? undefined : days[hover];
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart__svg" role="img" aria-label={v(`Notes processed per day over the last ${days.length} days`, `Chronicle entries per day over the last ${days.length} days`)} onMouseLeave={() => setHover(null)}>
        {[0, top].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="chart__grid" />
            <text x={pad.l - 6} y={y(v) + 4} className="chart__tick" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {days.map((day, i) => {
          const x = pad.l + i * band + (band - bw) / 2;
          const h1 = y(0) - y(day.chronicled);
          const h2 = y(0) - y(day.remembered);
          return (
            <g key={day.date} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${shortDate(day.date)}: ${day.chronicled} ${processed}, ${day.remembered} waiting`}>
              <rect x={pad.l + i * band} y={pad.t} width={band} height={H - pad.t - pad.b} className="chart__hit" />
              {day.chronicled > 0 && <path d={bar(x, y(0), bw, h1)} className="chart__bar chart__bar--1" />}
              {day.remembered > 0 && <path d={bar(x, y(0) - h1 - (day.chronicled ? 2 : 0), bw, h2)} className="chart__bar chart__bar--2" />}
            </g>
          );
        })}
        <text x={pad.l} y={H - 4} className="chart__tick">
          {shortDate(days[0]?.date, { year: false })}
        </text>
        <text x={W - pad.r} y={H - 4} className="chart__tick" textAnchor="end">
          today
        </text>
      </svg>
      <div className="legend">
        <span>
          <i className="swatch" style={{ ["--c" as string]: "var(--series-1)" }} aria-hidden /> {processed}
        </span>
        <span>
          <i className="swatch" style={{ ["--c" as string]: "var(--series-2)" }} aria-hidden /> {v("waiting in the inbox", "waiting in the satchel")}
        </span>
        {d && (
          <span className="chart__readout">
            <strong>{shortDate(d.date, { weekday: true, year: false })}</strong> · {d.chronicled} {processed}
            {d.remembered ? ` · ${d.remembered} waiting` : ""}
            {Object.keys(d.byAgent).length ? ` · ${Object.entries(d.byAgent).map(([a, n]) => `${a} ${n}`).join(", ")}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

/** A column with a 4px rounded top and a square base. */
function bar(x: number, base: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(4, h, w / 2);
  return `M ${x} ${base} V ${base - h + r} Q ${x} ${base - h} ${x + r} ${base - h} H ${x + w - r} Q ${x + w} ${base - h} ${x + w} ${base - h + r} V ${base} Z`;
}
