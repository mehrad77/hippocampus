import { useEffect, useId, useMemo, useRef, useState } from "react";
import "../ui/lore/palette.css";
import { ApiError, getJson } from "../lib/api.ts";
import { useResource } from "../lib/cache.ts";
import { emit, on } from "../lib/events.ts";
import { relTime } from "../lib/format.ts";
import { fuzzyScore } from "../lib/fuzzy.ts";
import type { IconName } from "../lib/icons.ts";
import { href, param, type Page } from "../lib/routes.ts";
import { useSession } from "../lib/session.ts";
import type { Catalog, SearchResult } from "../lib/types.ts";
import { TypeDot } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { plainText } from "../ui/lore/bits.tsx";

interface Item {
  key: string;
  label: string;
  sub?: string;
  hint?: string;
  icon?: IconName;
  /** Entity type: shows its colored dot instead of an icon. */
  type?: string;
  href?: string;
  run?: () => void;
}

interface Section {
  title: string;
  items: Item[];
  /** Best match score in the section; sections with stronger matches come first. */
  top: number;
  busy?: boolean;
}

const PAGES: [Page, string, IconName, string][] = [
  ["tavern", "Tavern", "tavern", "home overview start"],
  ["quests", "Quest board", "quest", "quests objectives clocks deadlines tasks"],
  ["council", "Council", "council", "disputes rulings conflicts"],
  ["satchel", "Satchel", "satchel", "inbox episodes pending waiting"],
  ["codex", "Codex", "codex", "entities entries wiki all"],
  ["map", "Map", "map", "graph relations ties network"],
  ["chronicle", "Chronicle", "chronicle", "timeline history journal log"],
  ["party", "Party", "party", "agents members lanes"],
  ["guides", "Guides", "guides", "help docs how"],
  ["setup", "Setup & health", "setup", "settings tokens connect health status"],
];

const MIN_PAGE_SCORE = 25;
const DEBOUNCE = 250;

function rank<T>(items: T[], q: string, keys: (t: T) => string[], min = 1): { item: T; score: number }[] {
  return items
    .map((item) => ({ item, score: Math.max(...keys(item).map((k) => fuzzyScore(q, k))) }))
    .filter((x) => x.score >= min)
    .sort((a, b) => b.score - a.score);
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** ⌘K / Ctrl+K / "/": jump to any page, entry or action, with a semantic search underneath. */
export function CommandPalette() {
  const session = useSession();
  const ready = !!session.data && session.data.mode !== "setup";
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [deep, setDeep] = useState<{ q: string; data?: SearchResult; loading: boolean; error?: string }>({ q: "", loading: false });
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId().replace(/[^\w-]/g, "");
  const catalog = useResource<Catalog>(wanted && ready ? "/catalog" : null);

  const show = () => {
    setQuery("");
    setActive(0);
    setWanted(true);
    setOpen(true);
  };
  const close = () => {
    if (dialog.current?.open) dialog.current.close();
    setOpen(false);
  };

  useEffect(() => {
    const otherDialog = () => [...document.querySelectorAll("dialog[open]")].some((d) => d !== dialog.current);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if (otherDialog()) return;
        e.preventDefault();
        if (dialog.current?.open) close();
        else show();
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented) {
        const t = e.target as HTMLElement | null;
        if (t?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
        if (dialog.current?.open || otherDialog()) return;
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    const off = on("palette:open", show);
    return () => {
      window.removeEventListener("keydown", onKey);
      off();
    };
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      input.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  // Deep search: debounced, and only the latest query may answer.
  const q = query.trim();
  useEffect(() => {
    if (!open || !ready || q.length < 2) {
      setDeep({ q: "", loading: false });
      return;
    }
    setDeep((d) => ({ ...d, loading: true, error: undefined }));
    let live = true;
    const timer = window.setTimeout(async () => {
      try {
        const data = await getJson<SearchResult>(`/search?q=${encodeURIComponent(q)}&limit=8`);
        if (live) setDeep({ q, data, loading: false });
      } catch (err) {
        if (live) setDeep({ q, loading: false, error: err instanceof ApiError ? err.message : String(err) });
      }
    }, DEBOUNCE);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q, open, ready]);

  const sections = useMemo((): Section[] => {
    const remember = !!session.data?.capabilities.remember;
    const onEntity = location.pathname.replace(/\/+$/, "").endsWith("/entity") ? param("ref") : null;

    const pages = rank(PAGES, q, ([, label, , kw]) => [label, kw], q ? MIN_PAGE_SCORE : 0).map(({ item: [p, label, icon], score }) => ({
      score,
      item: { key: `page:${p}`, label, icon, href: href.page(p), hint: "page" } as Item,
    }));

    const actionList: (Item & { kw: string })[] = [];
    if (remember) {
      if (onEntity) actionList.push({ key: "act:scribe-about", label: "Scribe about this entry", icon: "quill", hint: "action", kw: "remember note write memory episode", run: () => emit("scribe:open", { about: [onEntity] }) });
      actionList.push({ key: "act:scribe", label: "Scribe a memory", icon: "quill", hint: "action", kw: "remember note write add episode new", run: () => emit("scribe:open", {}) });
    }
    if (onEntity) actionList.push({ key: "act:map", label: "Show this entry on the map", icon: "map", hint: "action", kw: "graph focus", href: href.map(onEntity) });
    const actions = rank(actionList, q, (a) => [a.label, a.kw], q ? MIN_PAGE_SCORE : 0);

    const all = catalog.data?.entities ?? [];
    const entities = q
      ? rank(all, q, (e) => [e.title, e.slug, ...e.aliases, ...e.tags]).slice(0, 8)
      : [...all]
          .filter((e) => e.updated)
          .sort((a, b) => b.updated!.localeCompare(a.updated!))
          .slice(0, 5)
          .map((item) => ({ item, score: 0 }));
    const seen = new Set(entities.map((x) => x.item.slug));
    const entityItems = entities.map(({ item: e, score }) => ({
      score,
      item: {
        key: `ent:${e.slug}`,
        label: e.title,
        sub: e.aliases.length ? `also ${e.aliases.join(", ")}` : clip(plainText(e.summary)),
        type: e.type,
        hint: e.type,
        href: href.entity(e.slug),
      } as Item,
    }));

    const out: Section[] = [];
    const push = (title: string, xs: { item: Item; score: number }[], extra: Partial<Section> = {}) => {
      if (xs.length || extra.busy) out.push({ title, items: xs.map((x) => x.item), top: xs[0]?.score ?? 0, ...extra });
    };
    push("Pages", pages);
    push("Actions", actions);
    push(q ? "Entries" : "Recently updated", entityItems, { busy: !!q && wanted && catalog.loading && !catalog.data });

    if (q) out.sort((a, b) => b.top - a.top);

    if (q.length >= 2 && ready) {
      const r = deep.q === q || deep.loading ? deep.data : undefined;
      const deepItems: Item[] = [];
      for (const e of r?.entities ?? []) {
        if (seen.has(e.slug)) continue;
        seen.add(e.slug);
        deepItems.push({ key: `deep:${e.slug}`, label: e.title, sub: clip(plainText(e.summary)) || undefined, type: e.type, hint: e.type, href: href.entity(e.slug) });
      }
      for (const rel of r?.related ?? []) {
        if (seen.has(rel.ref.slug)) continue;
        seen.add(rel.ref.slug);
        deepItems.push({ key: `rel:${rel.ref.slug}`, label: rel.ref.title, sub: `related, via ${rel.via}`, type: rel.ref.type, hint: rel.ref.type, href: href.entity(rel.ref.slug) });
      }
      for (const ep of r?.pending ?? []) {
        deepItems.push({
          key: `ep:${ep.id}`,
          label: ep.secret || ep.text === null ? "A sealed episode" : clip(plainText(ep.text), 90),
          sub: `${ep.agent} · ${ep.kind} · ${relTime(ep.at)} · waiting in the satchel`,
          icon: ep.secret ? "lock" : "satchel",
          hint: "pending",
          href: href.page("satchel", `#${ep.id}`),
        });
      }
      if (deepItems.length || deep.loading) out.push({ title: "Deep search", items: deepItems, top: 0, busy: deep.loading });
    }
    return out;
  }, [q, catalog.data, catalog.loading, deep, session.data, ready, wanted]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const at = flat.length ? Math.min(active, flat.length - 1) : -1;
  const optId = (i: number) => `${uid}-o${i}`;

  useEffect(() => {
    if (at >= 0) document.getElementById(optId(at))?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const activate = (item: Item | undefined, newTab = false) => {
    if (!item) return;
    if (item.href && newTab) {
      window.open(item.href, "_blank", "noopener");
      return;
    }
    close();
    if (item.run) item.run();
    else if (item.href) location.assign(item.href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = flat.length;
    if (e.key === "ArrowDown" && n) (e.preventDefault(), setActive((at + 1) % n));
    else if (e.key === "ArrowUp" && n) (e.preventDefault(), setActive((at - 1 + n) % n));
    else if (e.key === "PageDown" && n) (e.preventDefault(), setActive(Math.min(n - 1, at + 5)));
    else if (e.key === "PageUp" && n) (e.preventDefault(), setActive(Math.max(0, at - 5)));
    else if (e.key === "Enter") (e.preventDefault(), activate(flat[at], e.metaKey || e.ctrlKey));
    else if (e.key === "Escape" && query) (e.preventDefault(), setQuery(""), setActive(0));
  };

  const status = !q ? "" : deep.loading ? "Searching…" : `${flat.length} result${flat.length === 1 ? "" : "s"}`;
  let index = -1;
  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Search and commands"
      onClose={() => setOpen(false)}
      onClick={(e) => {
        if (e.target === dialog.current) close();
      }}
    >
      {open && (
        <>
          <div className="palette__head">
            <Icon name="search" />
            <input
              ref={input}
              className="palette__input"
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${uid}-list`}
              aria-activedescendant={at >= 0 ? optId(at) : undefined}
              aria-autocomplete="list"
              aria-label="Search pages, entries and actions"
              placeholder="Search the codex, or jump to a page…"
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
            <button type="button" className="palette__esc" onClick={close} aria-label="Close">
              esc
            </button>
          </div>
          <div className="palette__list" id={`${uid}-list`} role="listbox" aria-label="Results">
            {sections.map((s, si) => (
              <div key={s.title} role="group" aria-labelledby={`${uid}-s${si}`}>
                <div className="palette__section" id={`${uid}-s${si}`} role="presentation">
                  {s.title}
                  {s.busy && <span className="palette__spin" aria-hidden />}
                </div>
                {s.items.map((item) => {
                  const i = ++index;
                  return (
                    <div
                      key={item.key}
                      id={optId(i)}
                      role="option"
                      aria-selected={i === at}
                      className={`pal-opt${i === at ? " is-active" : ""}`}
                      onMouseMove={() => i !== at && setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => activate(item, e.metaKey || e.ctrlKey)}
                    >
                      <span className="pal-opt__icon">{item.type ? <TypeDot type={item.type} /> : <Icon name={item.icon ?? "chevron"} />}</span>
                      <span className="pal-opt__main">
                        <span className="pal-opt__label">{item.label}</span>
                        {item.sub && <span className="pal-opt__sub">{item.sub}</span>}
                      </span>
                      <span className="pal-opt__hint">
                        {item.hint}
                        <kbd className="pal-opt__enter" aria-hidden>
                          ↵
                        </kbd>
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            {!flat.length && !sections.some((s) => s.busy) && (
              <div className="palette__empty">
                <strong>Nothing answers to “{q}”</strong>
                <span className="small">{ready ? "Try other words, or browse the Codex." : "Only pages are searchable until a vault is connected."}</span>
              </div>
            )}
            {deep.error && q.length >= 2 && <div className="palette__empty small">Deep search failed: {deep.error}</div>}
          </div>
          <div className="palette__foot" aria-hidden>
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>↵</kbd> open
            </span>
            <span>
              <kbd>⌘</kbd>
              <kbd>↵</kbd> new tab
            </span>
            <span>
              <kbd>esc</kbd> close
            </span>
          </div>
          <div className="sr-only" aria-live="polite">
            {status}
          </div>
        </>
      )}
    </dialog>
  );
}
