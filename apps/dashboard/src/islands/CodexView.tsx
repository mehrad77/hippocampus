import { useEffect, useMemo, useState } from "react";
import "../styles/lore.css";
import { useResource } from "../lib/cache.ts";
import { plural } from "../lib/format.ts";
import { fuzzyFilter } from "../lib/fuzzy.ts";
import { typeRank } from "../lib/graph.ts";
import { href } from "../lib/routes.ts";
import type { Catalog, EntityCard } from "../lib/types.ts";
import { TypeDot } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { FactTally, StatusChip, plainText } from "../ui/lore/bits.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Empty, RelTime, Skeleton, SkeletonPanel } from "../ui/Parts.tsx";

type Sort = "match" | "az" | "updated" | "linked";

const SORTS: [Sort, string][] = [
  ["match", "Best match"],
  ["az", "A to Z"],
  ["updated", "Recently updated"],
  ["linked", "Most connected"],
];

interface Filters {
  q: string;
  types: string[];
  tag: string;
  /** Unset means "best match while searching, A to Z otherwise". */
  sort?: Sort;
}

function readFilters(): Filters {
  const p = new URLSearchParams(location.search);
  const sort = p.get("sort") as Sort | null;
  return {
    q: p.get("q") ?? "",
    types: (p.get("type") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    tag: p.get("tag") ?? "",
    sort: sort && SORTS.some(([s]) => s === sort) ? sort : undefined,
  };
}

function writeFilters(f: Filters): void {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.types.length) p.set("type", f.types.join(","));
  if (f.tag) p.set("tag", f.tag);
  if (f.sort) p.set("sort", f.sort);
  const qs = p.toString();
  history.replaceState(history.state, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
}

export default function CodexView() {
  return <PageGate>{() => <Codex />}</PageGate>;
}

function Codex() {
  const { data, error } = useResource<Catalog>("/catalog");
  const [f, setF] = useState<Filters>(readFilters);
  useEffect(() => writeFilters(f), [f]);
  const update = (patch: Partial<Filters>) => setF((cur) => ({ ...cur, ...patch }));

  const types = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    for (const e of data.entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    const configured = data.types.map((t) => t.name);
    return [...counts]
      .sort((a, b) => {
        const ia = configured.indexOf(a[0]);
        const ib = configured.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || typeRank(a[0]) - typeRank(b[0]) || a[0].localeCompare(b[0]);
      })
      .map(([name, count]) => ({ name, count, description: data.types.find((t) => t.name === name)?.description }));
  }, [data]);

  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of data?.entities ?? []) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [data]);

  const query = f.q.trim();
  const sort: Sort = f.sort === "match" && !query ? "az" : (f.sort ?? (query ? "match" : "az"));
  const shown = useMemo(() => {
    const all = data?.entities ?? [];
    const pool = all.filter((e) => (!f.types.length || f.types.includes(e.type)) && (!f.tag || e.tags.includes(f.tag)));
    const matched = query ? fuzzyFilter(pool, query, (e) => [e.title, ...e.aliases, e.slug, e.summary], pool.length) : pool;
    return sortCards(matched, sort);
  }, [data, f.types, f.tag, query, sort]);

  if (error && !data) return <div className="callout callout--danger">{error.message}</div>;
  if (!data)
    return (
      <div className="stack">
        <Skeleton h={40} w="30%" />
        <SkeletonPanel lines={2} />
        <div className="codex-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonPanel key={i} lines={3} />
          ))}
        </div>
      </div>
    );

  const filtering = !!(query || f.types.length || f.tag);
  const toggleType = (t: string) => update({ types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t] });
  const only = f.types.length === 1 ? types.find((t) => t.name === f.types[0]) : undefined;

  return (
    <div className="stack" style={{ ["--gap" as string]: "20px" }}>
      <header className="page-head">
        <div>
          <div className="page-head__kicker">Lore of {data.campaign}</div>
          <h1>The Codex</h1>
          <p className="page-head__lede">
            {plural(data.entities.length, "entry", "entries")} across {plural(types.length, "kind")}: every person, place, faction and quest the party has written down.
          </p>
        </div>
      </header>

      <section className="panel panel--quiet codex-filters" aria-label="Filters">
        <div className="lore-toolbar">
          <label className="searchbox">
            <Icon name="search" size={18} />
            <span className="sr-only">Filter entries</span>
            <input className="input" type="search" value={f.q} onChange={(e) => update({ q: e.target.value })} placeholder="Filter by name, alias or summary…" autoComplete="off" spellCheck={false} />
          </label>
          {tags.length > 0 && (
            <label className="row" style={{ ["--gap" as string]: "6px" }}>
              <span className="sr-only">Tag</span>
              <select className="select lore-select" value={f.tag} onChange={(e) => update({ tag: e.target.value })}>
                <option value="">Any tag</option>
                {tags.map(([t, n]) => (
                  <option key={t} value={t}>
                    #{t} ({n})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="row" style={{ ["--gap" as string]: "6px" }}>
            <span className="sr-only">Sort</span>
            <select className="select lore-select" value={sort} onChange={(e) => update({ sort: e.target.value as Sort })}>
              {SORTS.filter(([s]) => s !== "match" || query).map(([s, label]) => (
                <option key={s} value={s}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="chips" role="group" aria-label="Kinds">
          <button type="button" className="chip" aria-pressed={!f.types.length} onClick={() => update({ types: [] })}>
            All <span className="chip__count">{data.entities.length}</span>
          </button>
          {types.map((t) => (
            <button key={t.name} type="button" className={`chip typed typed--${t.name}`} aria-pressed={f.types.includes(t.name)} onClick={() => toggleType(t.name)} title={t.description}>
              <TypeDot type={t.name} />
              {t.name} <span className="chip__count">{t.count}</span>
            </button>
          ))}
        </div>
        {only?.description && <p className="codex-typenote small">{only.description}</p>}
      </section>

      <div className="result-line" aria-live="polite">
        <span>{filtering ? `${shown.length} of ${plural(data.entities.length, "entry", "entries")}` : plural(shown.length, "entry", "entries")}</span>
        {filtering && (
          <button type="button" className="linkish" onClick={() => setF({ q: "", types: [], tag: "", sort: f.sort === "match" ? undefined : f.sort })}>
            Clear filters
          </button>
        )}
      </div>

      {shown.length ? (
        <div className="codex-grid">
          {shown.map((e) => (
            <CodexCard key={e.slug} e={e} />
          ))}
        </div>
      ) : data.entities.length ? (
        <Empty icon="codex" title="No entry matches">
          Try fewer filters, or <button type="button" className="linkish" onClick={() => setF({ q: "", types: [], tag: "" })}>clear them all</button>.
        </Empty>
      ) : (
        <Empty icon="codex" title="The codex is empty">
          Entries appear after the curator's first sleep, or when you add notes in Obsidian.
        </Empty>
      )}
    </div>
  );
}

function sortCards(cards: EntityCard[], sort: Sort): EntityCard[] {
  if (sort === "match") return cards;
  const out = [...cards];
  if (sort === "az") out.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === "updated") out.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.title.localeCompare(b.title));
  if (sort === "linked") out.sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title));
  return out;
}

function CodexCard({ e }: { e: EntityCard }) {
  const summary = plainText(e.summary).trim();
  return (
    <a className={`codex-card typed typed--${e.type}`} href={href.entity(e.slug)}>
      <div className="codex-card__head">
        <span className="codex-card__type">
          <TypeDot type={e.type} />
          {e.type}
        </span>
        <StatusChip status={e.status} />
      </div>
      <h2 className="codex-card__title">{e.title}</h2>
      {e.aliases.length > 0 && <div className="codex-card__aka">also {e.aliases.join(", ")}</div>}
      <p className={`codex-card__summary${summary ? "" : " codex-card__summary--empty"}`}>{summary || "No summary yet."}</p>
      <div className="codex-card__foot">
        <FactTally facts={e.facts} />
        <span className="codex-card__links" title={plural(e.degree, "connection")}>
          <Icon name="link" size={15} />
          {e.degree}
          <span className="sr-only"> connections</span>
        </span>
        {e.updated && (
          <span className="push">
            <RelTime at={e.updated} />
          </span>
        )}
      </div>
    </a>
  );
}
