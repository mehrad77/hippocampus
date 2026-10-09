import { useEffect, useRef, useState } from "react";
import type { IconName } from "../lib/icons.ts";
import { relTime, shortDate } from "../lib/format.ts";
import { toast } from "../lib/events.ts";
import { Icon } from "./Icon.tsx";

export function Panel({ title, icon, aside, children, className = "", id }: { title?: React.ReactNode; icon?: IconName; aside?: React.ReactNode; children: React.ReactNode; className?: string; id?: string }) {
  return (
    <section className={`panel ${className}`} id={id} aria-label={typeof title === "string" ? title : undefined}>
      {(title || aside) && (
        <header className="panel__head">
          {title && (
            <h2 className="panel__title">
              {icon && <Icon name={icon} />}
              {title}
            </h2>
          )}
          {aside && <div className="panel__aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ icon = "scroll", title, children }: { icon?: IconName; title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <div className="empty__title">{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function Skeleton({ h = 16, w = "100%", r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r }} aria-hidden />;
}

export function SkeletonPanel({ lines = 4 }: { lines?: number }) {
  return (
    <div className="panel" aria-busy="true" aria-label="Loading">
      <div className="stack" style={{ ["--gap" as string]: "12px" }}>
        <Skeleton h={22} w="40%" />
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} h={14} w={`${90 - i * 9}%`} />
        ))}
      </div>
    </div>
  );
}

/** Relative time that stays fresh, with the exact time on hover. */
export function RelTime({ at, className }: { at?: string; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);
  if (!at) return null;
  return (
    <time className={className} dateTime={at} title={new Date(at).toLocaleString()}>
      {relTime(at)}
    </time>
  );
}

export function DateText({ date }: { date?: string }) {
  if (!date) return null;
  return <time dateTime={date}>{shortDate(date)}</time>;
}

export function Runes({ done, total, label }: { done: number; total: number; label?: string }) {
  if (!total) return null;
  return (
    <span className="runes" role="img" aria-label={label ?? `${done} of ${total} done`} title={`${done} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} data-on={i < done ? "" : undefined} />
      ))}
    </span>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn--sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        } catch {
          toast("Couldn't copy; select the text and copy it yourself.", "error");
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} size={16} />
      {done ? "Copied" : label}
    </button>
  );
}

/** A native <dialog>, opened and closed by the `open` prop. Escape and the backdrop close it. */
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? " dialog--wide" : ""}`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog__head">
        <h2>{title}</h2>
        <span className="spacer" />
        <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="dialog__body">{children}</div>
      {footer && <div className="dialog__foot">{footer}</div>}
    </dialog>
  );
}
