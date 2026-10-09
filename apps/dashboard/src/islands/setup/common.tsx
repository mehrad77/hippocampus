import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, getJson, postJson } from "../../lib/api.ts";
import { invalidate } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import type { IconName } from "../../lib/icons.ts";
import { href } from "../../lib/routes.ts";
import type { Job, SetupItem, Snippet } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { CopyButton, Dialog, RelTime } from "../../ui/Parts.tsx";
import { describeError, STATE_META, type BadgeState } from "./model.ts";

/** Refetch Session Zero's status (and the session, which changes when a vault opens). */
export function refreshSetup(): Promise<void[]> {
  return invalidate((k) => k.startsWith("/setup") || k === "/session");
}

/** A setup state as glyph + word (+ color), never color alone. */
export function StateBadge({ state, compact, className = "" }: { state: BadgeState; compact?: boolean; className?: string }) {
  const meta = STATE_META[state];
  return (
    <span className={`sz-state sz-state--${state} ${compact ? "sz-state--compact" : ""} ${className}`} title={meta.help}>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={meta.path} />
      </svg>
      {meta.word}
    </span>
  );
}

export function HowChip({ how }: { how: SetupItem["how"] }) {
  return how === "performed" ? (
    <span className="chip sz-how" title="The dashboard can do this for you, after you confirm.">
      <Icon name="sparkle" size={14} /> Done for you
    </span>
  ) : (
    <span className="chip sz-how" title="The dashboard shows exactly what to run; you run it.">
      <Icon name="copy" size={14} /> Guided
    </span>
  );
}

/** A copy-paste snippet. The dashboard never runs these. */
export function SnippetBlock({ snippet }: { snippet: Snippet }) {
  return (
    <figure className="sz-snippet">
      <figcaption className="sz-snippet__head">
        <span className="sz-snippet__label">{snippet.label}</span>
        <span className="sz-snippet__lang" aria-hidden>
          {snippet.lang}
        </span>
        <CopyButton text={snippet.code} />
      </figcaption>
      <pre className="sz-snippet__code" tabIndex={0} aria-label={`${snippet.label} (${snippet.lang})`}>
        <code>{snippet.code}</code>
      </pre>
      {snippet.note && <p className="hint sz-snippet__note">{snippet.note}</p>}
    </figure>
  );
}

export function Snippets({ snippets }: { snippets: readonly Snippet[] }) {
  return (
    <div className="stack sz-snippets">
      {snippets.map((s, i) => (
        <SnippetBlock key={`${s.label}-${i}`} snippet={s} />
      ))}
    </div>
  );
}

export function ErrorCallout({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = describeError(error);
  return (
    <div className={`callout ${e.unsupported ? "callout--warn" : "callout--danger"}`} role="alert">
      <Icon name="warn" />
      <div className="stack sz-tight">
        <strong>{e.title}</strong>
        <span>{e.message}</span>
        {e.noVault && (
          <a href="#vault" className="small">
            Go to the vault step →
          </a>
        )}
        {e.unsupported && (
          <a href={href.page("guides")} className="small">
            Open the guides →
          </a>
        )}
        {onRetry && (
          <span>
            <button type="button" className="btn btn--sm" onClick={onRetry}>
              <Icon name="refresh" size={16} /> Try again
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Runs one server action at a time with a busy flag and a remembered error.
 * NO_VAULT sends the wizard to the vault step, since nothing else can work yet.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "NO_VAULT") {
        toast("Set up the vault first.", "info");
        location.hash = "vault";
      }
      setError(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: useCallback(() => setError(undefined), []) };
}

export type EffectKind = "writes" | "runs" | "reads" | "contacts" | "shows" | "never";

const EFFECT: Record<EffectKind, { icon: IconName; verb: string }> = {
  writes: { icon: "quill", verb: "Writes" },
  runs: { icon: "hourglass", verb: "Runs" },
  reads: { icon: "eye", verb: "Reads" },
  contacts: { icon: "cloud", verb: "Contacts" },
  shows: { icon: "copy", verb: "Only shows" },
  never: { icon: "lock", verb: "Never" },
};

/** "What happens on this machine": every step says it plainly, before you press anything. */
export function Effects({ items, title = "What this step does" }: { items: (readonly [EffectKind, React.ReactNode] | false | null | undefined)[]; title?: string }) {
  const shown = items.filter((x): x is readonly [EffectKind, React.ReactNode] => !!x);
  return (
    <aside className="sz-effects" aria-label={title}>
      <div className="sz-effects__title">{title}</div>
      <ul className="sz-effects__list">
        {shown.map(([kind, text], i) => (
          <li key={i} className={`sz-effect sz-effect--${kind}`}>
            <Icon name={EFFECT[kind].icon} size={16} />
            <span>
              <strong>{EFFECT[kind].verb}</strong> {text}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** Accessible tabs: arrow keys move between them, only the selected one is in the tab order. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idBase }: { tabs: readonly (readonly [T, string])[]; value: T; onChange: (t: T) => void; label: string; idBase: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (i: number) => {
    const n = tabs.length;
    const j = ((i % n) + n) % n;
    const t = tabs[j];
    if (!t) return;
    onChange(t[0]);
    refs.current[j]?.focus();
  };
  return (
    <div className="tabs sz-tabs" role="tablist" aria-label={label}>
      {tabs.map(([id, text], i) => (
        <button
          key={id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${id}`}
          aria-selected={value === id}
          aria-controls={`${idBase}-panel-${id}`}
          tabIndex={value === id ? 0 : -1}
          onClick={() => onChange(id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") move(i + 1);
            else if (e.key === "ArrowLeft") move(i - 1);
            else if (e.key === "Home") move(0);
            else if (e.key === "End") move(tabs.length - 1);
            else return;
            e.preventDefault();
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idBase, id, children }: { idBase: string; id: string; children: React.ReactNode }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} tabIndex={0} className="sz-tabpanel">
      {children}
    </div>
  );
}

/** A labelled input with an optional hint and a live validation message wired to aria-describedby. */
export function Field({ label, hint, problem, children, wide }: { label: React.ReactNode; hint?: React.ReactNode; problem?: string; children: (ids: { id: string; describedBy?: string; invalid: boolean }) => React.ReactNode; wide?: boolean }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : "", problem ? errId : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field${wide ? " sz-wide" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy, invalid: !!problem })}
      {hint && (
        <span id={hintId} className="hint">
          {hint}
        </span>
      )}
      {problem && (
        <span id={errId} className="sz-problem" role="status">
          {problem}
        </span>
      )}
    </div>
  );
}

/** Editable chips: type and press Enter (or comma) to add, click a chip to remove it. */
export function ChipsInput({ values, onChange, validate, label, placeholder }: { values: string[]; onChange: (v: string[]) => void; validate: (raw: string, existing: string[]) => string | undefined; label: string; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string>();
  const id = useId();
  const add = () => {
    const parts = draft
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...values];
    for (const p of parts) {
      const err = validate(p, next);
      if (err) {
        setProblem(err);
        return;
      }
      next.push(p);
    }
    onChange(next);
    setDraft("");
    setProblem(undefined);
  };
  return (
    <div className="field sz-wide">
      <label htmlFor={id}>{label}</label>
      <div className="sz-chips">
        {values.map((v) => (
          <button key={v} type="button" className="chip sz-chip" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`}>
            {v} <Icon name="close" size={12} />
          </button>
        ))}
        <span className="sz-chips__add">
          <input
            id={id}
            className="input"
            value={draft}
            placeholder={placeholder}
            aria-invalid={!!problem}
            aria-describedby={problem ? `${id}-err` : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              } else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
            }}
          />
          <button type="button" className="btn btn--sm" onClick={add} disabled={!draft.trim()}>
            <Icon name="plus" size={16} /> Add
          </button>
        </span>
      </div>
      {problem && (
        <span id={`${id}-err`} className="sz-problem" role="status">
          {problem}
        </span>
      )}
    </div>
  );
}

/** A confirm dialog that says exactly what is about to happen. */
export function ConfirmDialog({ open, title, children, confirmLabel, danger, busy, onConfirm, onClose }: { open: boolean; title: React.ReactNode; children: React.ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? "btn--danger" : "btn--primary"}`} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">{children}</div>
    </Dialog>
  );
}

const JOB_WORD: Record<Job["kind"], string> = { "sleep-dry-run": "Dry-run sleep", reindex: "Index rebuild" };

/**
 * Starts a server job and follows it: polls `setup/jobs/<id>` every second until it is done,
 * showing the log as it grows.
 */
export function JobRunner({ kind, limit, label, disabled, idleHint }: { kind: Job["kind"]; limit?: number; label: string; disabled?: boolean; idleHint?: React.ReactNode }) {
  const [id, setId] = useState<string>();
  const [job, setJob] = useState<Job>();
  const start = useAction();
  const [pollError, setPollError] = useState<unknown>();
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = await getJson<Job>(`/setup/jobs/${encodeURIComponent(id)}`);
        if (stopped) return;
        setJob(next);
        if (next.state === "running") timer = window.setTimeout(tick, 1000);
      } catch (err) {
        if (!stopped) setPollError(err);
      }
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job?.log.length]);

  const running = start.busy || (!!id && (!job || job.state === "running") && !pollError);
  const begin = async () => {
    setJob(undefined);
    setPollError(undefined);
    const res = await start.run(() => postJson<{ id: string }>("/setup/jobs", limit === undefined ? { kind } : { kind, limit }));
    if (res) setId(res.id);
  };

  return (
    <div className="stack sz-job">
      <div className="row">
        <button type="button" className="btn" onClick={begin} disabled={disabled || running}>
          <Icon name={running ? "hourglass" : kind === "reindex" ? "refresh" : "moonStars"} className={running ? "sz-spin" : undefined} />
          {running ? "Running…" : label}
        </button>
        {job && (
          <span className="small muted">
            {JOB_WORD[job.kind]} started <RelTime at={job.started} />
          </span>
        )}
        {!job && !running && idleHint && <span className="small muted">{idleHint}</span>}
      </div>
      {start.error !== undefined && <ErrorCallout error={start.error} />}
      {pollError !== undefined && <ErrorCallout error={pollError} />}
      {job && (
        <>
          <pre ref={logRef} className="sz-log" role="log" aria-label={`${JOB_WORD[job.kind]} log`} tabIndex={0}>
            {job.log.length ? job.log.join("\n") : "Waiting for the first line…"}
          </pre>
          {job.state === "done" && (
            <div className="callout callout--ok" role="status">
              <Icon name="check" />
              <div>{job.summary ?? "Finished."}</div>
            </div>
          )}
          {job.state === "error" && (
            <div className="callout callout--danger" role="alert">
              <Icon name="warn" />
              <div>
                <strong>It stopped with an error.</strong>
                <div>{job.error ?? "See the log above."}</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A small key/value list. */
export function Facts({ rows }: { rows: [React.ReactNode, React.ReactNode][] }) {
  return (
    <dl className="sz-facts">
      {rows.map(([k, v], i) => (
        <div key={i} className="sz-facts__row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
