import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import "../styles/lore.css";
import { useResource } from "../lib/cache.ts";
import { plural } from "../lib/format.ts";
import { fuzzyFilter } from "../lib/fuzzy.ts";
import {
  centerOn,
  createSimulation,
  fitView,
  mergeEdges,
  neighborsOf,
  nodeRadius,
  panBy,
  pinch,
  settle,
  showLabel,
  toScreen,
  toWorld,
  trimSegment,
  typeCounts,
  visibleGraph,
  zoomAt,
  type GraphNode,
  type MapSimulation,
  type MergedEdge,
  type SimNode,
  type View,
} from "../lib/graph.ts";
import { href, param } from "../lib/routes.ts";
import type { Graph } from "../lib/types.ts";
import { EntityLink, TypeBadge, TypeDot } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Empty, Skeleton } from "../ui/Parts.tsx";

type Mode = "map" | "list";

export default function MapView() {
  return <PageGate>{() => <MapPage />}</PageGate>;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches;
const short = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function MapPage() {
  const { data, error } = useResource<Graph>("/graph");
  const [mode, setMode] = useState<Mode>(() => (param("view") === "list" ? "list" : "map"));
  const [hidden, setHidden] = useState<Set<string>>(() => new Set((param("hide") ?? "").split(",").filter(Boolean)));
  const [focus, setFocus] = useState<string | null>(() => param("focus"));
  const [flyTo, setFlyTo] = useState<{ slug: string; seq: number } | null>(() => {
    const f = param("focus");
    return f ? { slug: f, seq: 1 } : null;
  });
  const [query, setQuery] = useState("");

  useEffect(() => {
    const p = new URLSearchParams();
    if (focus) p.set("focus", focus);
    if (hidden.size) p.set("hide", [...hidden].join(","));
    if (mode === "list") p.set("view", "list");
    const qs = p.toString();
    history.replaceState(history.state, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
  }, [focus, hidden, mode]);

  // Revalidation returns a new object even when nothing changed; only a real change should reheat the layout.
  const sig = useMemo(() => (data ? JSON.stringify([data.nodes.map((n) => [n.slug, n.type, n.title, n.degree, n.status]), data.edges]) : ""), [data]);
  const visible = useMemo(() => (data ? visibleGraph(data, hidden) : { nodes: [], edges: [] }), [sig, hidden]);
  const merged = useMemo(() => mergeEdges(visible.edges), [visible]);
  const byslug = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.slug, n])), [sig]);
  const types = useMemo(() => typeCounts(data?.nodes ?? []), [sig]);

  const focused = focus ? byslug.get(focus) : undefined;
  // A focus on a hidden kind, or on a slug the map doesn't know (a stale link), would dim everything.
  useEffect(() => {
    if (!data || !focus) return;
    if (!focused || hidden.has(focused.type)) setFocus(null);
  }, [data, focus, focused, hidden]);
  const live = focused && !hidden.has(focused.type) ? focused : undefined;

  const select = (slug: string) => {
    const n = byslug.get(slug);
    if (!n) return;
    if (hidden.has(n.type)) setHidden((h) => new Set([...h].filter((t) => t !== n.type)));
    setFocus(slug);
    setFlyTo((f) => ({ slug, seq: (f?.seq ?? 0) + 1 }));
  };

  if (error && !data) return <div className="callout callout--danger">{error.message}</div>;
  if (!data)
    return (
      <div className="stack">
        <Skeleton h={40} w="30%" />
        <Skeleton h={38} w="60%" />
        <Skeleton h={480} r={14} />
      </div>
    );

  return (
    <div className="stack" style={{ ["--gap" as string]: "18px" }}>
      <header className="page-head">
        <div>
          <div className="page-head__kicker">Lore</div>
          <h1>The Map</h1>
          <p className="page-head__lede">
            {plural(data.nodes.length, "entity", "entities")} bound by {plural(data.edges.length, "tie")}. {mode === "map" ? "Drag to pan, scroll or pinch to zoom, and pick a node to light up its neighbors." : "Every tie, as a table."}
          </p>
        </div>
        <div className="seg" role="group" aria-label="View">
          <button type="button" aria-pressed={mode === "map"} onClick={() => setMode("map")}>
            <Icon name="map" /> Map
          </button>
          <button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>
            <Icon name="codex" /> List
          </button>
        </div>
      </header>

      {data.nodes.length === 0 ? (
        <div className="panel">
          <Empty icon="map" title="The map is blank">
            Entities and their ties appear here once the codex has entries.
          </Empty>
        </div>
      ) : (
        <>
          <div className="map-tools">
            <FindNode nodes={data.nodes} query={query} setQuery={setQuery} onPick={select} listMode={mode === "list"} />
            <div className="chips" role="group" aria-label="Show or hide kinds">
              {types.map(([t, n]) => (
                <button
                  key={t}
                  type="button"
                  className={`chip chip--toggle typed typed--${t}`}
                  aria-pressed={!hidden.has(t)}
                  title={hidden.has(t) ? `Show ${t}` : `Hide ${t}`}
                  onClick={() =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (next.has(t)) next.delete(t);
                      else next.add(t);
                      return next;
                    })
                  }
                >
                  <TypeDot type={t} />
                  {t} <span className="chip__count">{n}</span>
                </button>
              ))}
              {hidden.size > 0 && (
                <button type="button" className="linkish small" onClick={() => setHidden(new Set())}>
                  Show all
                </button>
              )}
            </div>
          </div>

          {mode === "map" ? (
            <div className="map-wrap">
              <MapCanvas graph={visible} merged={merged} focus={live?.slug ?? null} onFocus={setFocus} flyTo={flyTo} />
              {live && <FocusCard node={live} graph={data} byslug={byslug} hidden={hidden} onPick={select} onClose={() => setFocus(null)} onCenter={() => setFlyTo((f) => ({ slug: live.slug, seq: (f?.seq ?? 0) + 1 }))} />}
            </div>
          ) : (
            <EdgeTable graph={visible} byslug={byslug} query={query} />
          )}
        </>
      )}
    </div>
  );
}

/** The search box: a small combobox that flies the map to a node (or filters the list). */
function FindNode({ nodes, query, setQuery, onPick, listMode }: { nodes: GraphNode[]; query: string; setQuery: (q: string) => void; onPick: (slug: string) => void; listMode: boolean }) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const id = useId().replace(/[^\w-]/g, "");
  const matches = useMemo(() => (query.trim() ? fuzzyFilter(nodes, query, (n) => [n.title, n.slug, ...n.tags], 6) : []), [nodes, query]);
  const show = open && !listMode && matches.length > 0;
  const pick = (slug: string) => {
    onPick(slug);
    setQuery("");
    setOpen(false);
  };
  return (
    <div className="map-find">
      <label className="searchbox">
        <Icon name="search" size={18} />
        <span className="sr-only">{listMode ? "Filter ties" : "Find a node"}</span>
        <input
          className="input"
          type="search"
          role="combobox"
          aria-expanded={show}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={show ? `${id}-${active}` : undefined}
          value={query}
          placeholder={listMode ? "Filter ties…" : "Find a node…"}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (listMode) return;
            if (e.key === "ArrowDown" && matches.length) (e.preventDefault(), setOpen(true), setActive((a) => (a + 1) % matches.length));
            else if (e.key === "ArrowUp" && matches.length) (e.preventDefault(), setActive((a) => (a - 1 + matches.length) % matches.length));
            else if (e.key === "Enter" && matches.length) (e.preventDefault(), pick(matches[Math.min(active, matches.length - 1)]!.slug));
            else if (e.key === "Escape") setOpen(false);
          }}
        />
      </label>
      {show && (
        <ul className="map-find__list" role="listbox" id={`${id}-list`} aria-label="Matching nodes">
          {matches.map((n, i) => (
            <li key={n.slug} role="none">
              <button type="button" role="option" id={`${id}-${i}`} aria-selected={i === active} data-active={i === active ? "" : undefined} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(n.slug)} onMouseEnter={() => setActive(i)}>
                <TypeDot type={n.type} />
                <span>{n.title}</span>
                <span className="small muted push">{n.type}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function relText(m: MergedEdge, title: (slug: string) => string): string {
  const lines = [];
  if (m.forward.length) lines.push(`${title(m.source)} — ${m.forward.join(", ")} → ${title(m.target)}`);
  if (m.backward.length) lines.push(`${title(m.target)} — ${m.backward.join(", ")} → ${title(m.source)}`);
  return lines.join("\n");
}

function MapCanvas({ graph, merged, focus, onFocus, flyTo }: { graph: Graph; merged: MergedEdge[]; focus: string | null; onFocus: (slug: string | null) => void; flyTo: { slug: string; seq: number } | null }) {
  const uid = useId().replace(/[^\w-]/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [, setFrame] = useState(0);
  const bump = () => setFrame((n) => (n + 1) % 1_000_000);
  const [hover, setHover] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [interacted, setInteracted] = useState(false);

  const reduced = useMemo(reducedMotion, []);
  const coarse = useMemo(coarsePointer, []);
  const store = useRef(new Map<string, SimNode>());
  const simRef = useRef<MapSimulation | null>(null);
  const raf = useRef(0);
  // While true the camera keeps the whole map framed; any pan, zoom or drag hands it to the reader.
  const autoFit = useRef(true);
  const listRef = useRef<SimNode[]>([]);

  const nodes = useMemo(() => {
    const out = graph.nodes.map((n) => {
      const s = store.current.get(n.slug);
      if (s) return Object.assign(s, n, { r: nodeRadius(n.degree) });
      const fresh: SimNode = { ...n, r: nodeRadius(n.degree) };
      store.current.set(n.slug, fresh);
      return fresh;
    });
    // Newcomers (a kind shown again) start beside a neighbor instead of in the middle.
    out.forEach((n, i) => {
      if (n.x !== undefined) return;
      const nb = graph.edges.map((e) => (e.from === n.slug ? e.to : e.to === n.slug ? e.from : undefined)).map((s) => (s ? store.current.get(s) : undefined)).find((s) => s?.x !== undefined);
      if (nb) {
        n.x = nb.x! + Math.cos(i) * 40;
        n.y = nb.y! + Math.sin(i) * 40;
      }
    });
    listRef.current = out;
    return out;
  }, [graph]);
  const neighbors = useMemo(() => (focus ? neighborsOf(merged, focus) : new Set<string>()), [merged, focus]);
  const hoverNeighbors = useMemo(() => (hover && !focus ? neighborsOf(merged, hover) : new Set<string>()), [merged, hover, focus]);

  const fit = () => setView(fitView(listRef.current, sizeRef.current.w, sizeRef.current.h));

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next = { w: Math.round(r.width), h: Math.round(r.height) };
      if (next.w === sizeRef.current.w && next.h === sizeRef.current.h) return;
      sizeRef.current = next;
      setSize(next);
      if (autoFit.current) fit();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const loop = () => {
    const sim = simRef.current;
    if (!sim) return;
    sim.tick();
    sim.tick();
    if (autoFit.current) fit();
    bump();
    raf.current = sim.alpha() > sim.alphaMin() ? requestAnimationFrame(loop) : 0;
  };
  const kick = () => {
    if (reduced) return;
    if (!raf.current) raf.current = requestAnimationFrame(loop);
  };

  useEffect(() => {
    const first = !simRef.current;
    simRef.current?.stop();
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const sim = createSimulation(nodes, merged);
    simRef.current = sim;
    if (!first) sim.alpha(0.45);
    if (reduced) {
      // No motion: run the physics to rest off-screen and draw the final map once.
      settle(sim);
      if (autoFit.current) fit();
      bump();
    } else {
      // Most of the shuffling happens before the first paint; the rest eases in.
      if (first) for (let i = 0; i < 90; i++) sim.tick();
      if (autoFit.current) fit();
      bump();
      kick();
    }
    return () => {
      sim.stop();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [nodes, merged]);

  // Each fly request moves the camera once, as soon as its node has a position (it may be in a kind just shown again).
  const flown = useRef(0);
  useEffect(() => {
    if (!flyTo || flown.current === flyTo.seq) return;
    const n = store.current.get(flyTo.slug);
    if (!n || n.x === undefined || n.y === undefined) return;
    flown.current = flyTo.seq;
    autoFit.current = false;
    setView((v) => centerOn(v, n.x!, n.y!, sizeRef.current.w, sizeRef.current.h, Math.max(v.k, 1)));
  }, [flyTo, nodes]);

  // React's wheel listener is passive, so it can't stop the page from scrolling; attach our own.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const speed = e.deltaMode === 1 ? 0.05 : e.ctrlKey ? 0.01 : 0.0015;
      autoFit.current = false;
      setInteracted(true);
      setView((v) => zoomAt(v, Math.exp(-e.deltaY * speed), e.clientX - r.left, e.clientY - r.top));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // ── Pointer gestures: drag a node, pan with one pointer, pinch with two ────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pan = useRef<{ moved: boolean; sx: number; sy: number } | null>(null);
  const drag = useRef<{ slug: string; id: number; sx: number; sy: number; moved: boolean } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const takeOver = () => {
    autoFit.current = false;
    if (!interacted) setInteracted(true);
  };

  const onNodeDown = (e: React.PointerEvent, slug: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = local(e);
    drag.current = { slug, id: e.pointerId, sx: p.x, sy: p.y, moved: false };
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) pan.current = { moved: false, sx: p.x, sy: p.y };
    setPanning(true);
  };

  const onMove = (e: React.PointerEvent) => {
    const p = local(e);
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < 4) return;
      d.moved = true;
      takeOver();
      const n = store.current.get(d.slug);
      if (!n) return;
      const [wx, wy] = toWorld(viewRef.current, p.x, p.y);
      n.fx = wx;
      n.fy = wy;
      if (reduced) {
        n.x = wx;
        n.y = wy;
        bump();
      } else {
        simRef.current?.alphaTarget(0.25);
        kick();
      }
      return;
    }
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const before = new Map(pointers.current);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) {
      const pn = pan.current;
      if (pn && !pn.moved && Math.hypot(p.x - pn.sx, p.y - pn.sy) < 4) return;
      if (pn) pn.moved = true;
      takeOver();
      setView((v) => panBy(v, p.x - prev.x, p.y - prev.y));
    } else {
      const [a, b] = [...pointers.current.keys()];
      if (a === undefined || b === undefined) return;
      if (pan.current) pan.current.moved = true;
      takeOver();
      setView((v) => pinch(v, [before.get(a)!, before.get(b)!], [pointers.current.get(a)!, pointers.current.get(b)!]));
    }
  };

  const onUp = (e: React.PointerEvent, cancelled = false) => {
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      drag.current = null;
      const n = store.current.get(d.slug);
      if (!d.moved) {
        if (!cancelled) onFocus(d.slug);
      } else if (n) {
        n.fx = null;
        n.fy = null;
        if (!reduced) {
          simRef.current?.alphaTarget(0);
          kick();
        }
      }
      return;
    }
    if (!pointers.current.delete(e.pointerId)) return;
    if (!pointers.current.size) {
      setPanning(false);
      if (!cancelled && pan.current && !pan.current.moved) onFocus(null);
      pan.current = null;
    } else {
      // One finger lifted mid-pinch: keep panning from the other without a jump.
      const rest = [...pointers.current.values()][0]!;
      pan.current = { moved: true, sx: rest.x, sy: rest.y };
    }
  };

  const zoomBy = (f: number) => {
    takeOver();
    setView((v) => zoomAt(v, f, sizeRef.current.w / 2, sizeRef.current.h / 2));
  };

  const onKey = (e: React.KeyboardEvent) => {
    const step = 60;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => (takeOver(), setView((v) => panBy(v, step, 0))),
      ArrowRight: () => (takeOver(), setView((v) => panBy(v, -step, 0))),
      ArrowUp: () => (takeOver(), setView((v) => panBy(v, 0, step))),
      ArrowDown: () => (takeOver(), setView((v) => panBy(v, 0, -step))),
      "+": () => zoomBy(1.25),
      "=": () => zoomBy(1.25),
      "-": () => zoomBy(1 / 1.25),
      "0": () => ((autoFit.current = true), fit()),
      Escape: () => onFocus(null),
    };
    const fn = keys[e.key];
    if (fn && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      fn();
    }
  };

  const { w, h } = size;
  const total = nodes.length;
  const title = (slug: string) => store.current.get(slug)?.title ?? slug;
  const hot = (m: MergedEdge) => {
    const at = focus ?? hover;
    return at ? m.source === at || m.target === at : hoverEdge === m.key;
  };
  const hotEdges = merged.filter((m) => hot(m) || hoverEdge === m.key);

  return (
    <div className="map-stage" ref={wrapRef}>
      <svg
        ref={svgRef}
        className={`map-svg${panning ? " is-panning" : ""}`}
        width={w || undefined}
        height={h || undefined}
        viewBox={`0 0 ${Math.max(1, w)} ${Math.max(1, h)}`}
        tabIndex={0}
        role="group"
        aria-roledescription="relation map"
        aria-label="Relation map. Arrow keys pan, plus and minus zoom, 0 frames everything, Escape clears the focus. Tab through the nodes and press Enter to focus one."
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={(e) => onUp(e)}
        onPointerCancel={(e) => onUp(e, true)}
        onKeyDown={onKey}
      >
        <defs>
          <marker id={`${uid}-a`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0,1 L10,5 L0,9 z" className="map-arrow" />
          </marker>
          <marker id={`${uid}-h`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0,1 L10,5 L0,9 z" className="map-arrow map-arrow--hot" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          <g>
            {merged.map((m) => {
              const a = store.current.get(m.source);
              const b = store.current.get(m.target);
              if (!a || !b || a.x === undefined || b.x === undefined) return null;
              const isHot = hot(m);
              const dim = !!focus && !isHot;
              const [x1, y1, x2, y2] = trimSegment(a.x, a.y!, b.x, b.y!, a.r + 3, b.r + 3);
              const marker = `url(#${uid}-${isHot ? "h" : "a"})`;
              return (
                <g key={m.key} onPointerEnter={() => setHoverEdge(m.key)} onPointerLeave={() => setHoverEdge((k) => (k === m.key ? null : k))}>
                  <title>{relText(m, title)}</title>
                  <line className="map-edge-hit" x1={x1} y1={y1} x2={x2} y2={y2} />
                  <line className={`map-edge${isHot ? " is-hot" : ""}${dim ? " is-dim" : ""}`} x1={x1} y1={y1} x2={x2} y2={y2} markerEnd={m.forward.length ? marker : undefined} markerStart={m.backward.length ? marker : undefined} />
                </g>
              );
            })}
          </g>
          <g>
            {nodes.map((n) => {
              if (n.x === undefined || n.y === undefined) return null;
              const isFocus = n.slug === focus;
              const dim = !!focus && !isFocus && !neighbors.has(n.slug);
              return (
                <g
                  key={n.slug}
                  className={`map-node typed typed--${n.type}${isFocus ? " is-focus" : ""}${dim ? " is-dim" : ""}`}
                  data-status={n.status}
                  transform={`translate(${n.x},${n.y})`}
                  tabIndex={0}
                  role="button"
                  aria-pressed={isFocus}
                  aria-label={`${n.title}, ${n.type}, ${plural(n.degree, "tie")}`}
                  onPointerDown={(e) => onNodeDown(e, n.slug)}
                  onPointerEnter={() => setHover(n.slug)}
                  onPointerLeave={() => setHover((s) => (s === n.slug ? null : s))}
                  onFocus={() => setHover(n.slug)}
                  onBlur={() => setHover((s) => (s === n.slug ? null : s))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onFocus(n.slug);
                    }
                  }}
                >
                  <circle className="map-node__ring" r={n.r + 4} />
                  <circle className="map-node__dot" r={n.r} />
                </g>
              );
            })}
          </g>
        </g>
        {/* Labels live in screen space so they stay readable at any zoom. */}
        <g className="map-labels" aria-hidden>
          {hotEdges.map((m) => {
            const a = store.current.get(m.source);
            const b = store.current.get(m.target);
            if (!a || !b || a.x === undefined || b.x === undefined) return null;
            const [sx, sy] = toScreen(view, (a.x + b.x) / 2, (a.y! + b.y!) / 2);
            const rels = [...m.forward, ...m.backward].join(" · ");
            return (
              <text key={m.key} className="map-label map-label--rel" x={sx} y={sy - 4} textAnchor="middle">
                {short(rels, 32)}
              </text>
            );
          })}
          {nodes.map((n) => {
            if (n.x === undefined || n.y === undefined) return null;
            const isFocus = n.slug === focus;
            const near = neighbors.has(n.slug) || hoverNeighbors.has(n.slug);
            if (!isFocus && !near && n.slug !== hover && !showLabel(n.degree, view.k, total)) return null;
            const [sx, sy] = toScreen(view, n.x, n.y);
            if (sx < -120 || sx > w + 120 || sy < -40 || sy > h + 40) return null;
            const dim = !!focus && !isFocus && !neighbors.has(n.slug);
            return (
              <text key={n.slug} className={`map-label${isFocus ? " map-label--focus" : ""}${dim ? " is-dim" : ""}`} x={sx} y={sy + n.r * view.k + 16} textAnchor="middle">
                {short(n.title)}
              </text>
            );
          })}
        </g>
      </svg>
      <div className="map-controls" role="group" aria-label="Zoom">
        <button type="button" className="btn btn--ghost btn--icon" onClick={() => zoomBy(1.3)} aria-label="Zoom in" title="Zoom in (+)">
          <Icon name="plus" />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out" title="Zoom out (−)">
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={() => {
            autoFit.current = true;
            fit();
          }}
          aria-label="Frame the whole map"
          title="Frame everything (0)"
        >
          <Icon name="refresh" />
        </button>
      </div>
      {!interacted && !focus && <div className="map-hint">{coarse ? "Drag to pan · pinch to zoom · tap a node" : "Drag to pan · scroll to zoom · click a node"}</div>}
    </div>
  );
}

function FocusCard({ node, graph, byslug, hidden, onPick, onClose, onCenter }: { node: GraphNode; graph: Graph; byslug: Map<string, GraphNode>; hidden: Set<string>; onPick: (slug: string) => void; onClose: () => void; onCenter: () => void }) {
  const rels = useMemo(
    () =>
      graph.edges
        .filter((e) => e.from === node.slug || e.to === node.slug)
        .map((e) => ({ dir: e.from === node.slug ? ("out" as const) : ("in" as const), rel: e.rel, other: byslug.get(e.from === node.slug ? e.to : e.from) }))
        .filter((r): r is { dir: "out" | "in"; rel: string; other: GraphNode } => !!r.other)
        .sort((a, b) => (a.dir === b.dir ? a.rel.localeCompare(b.rel) || a.other.title.localeCompare(b.other.title) : a.dir === "out" ? -1 : 1)),
    [graph, node.slug, byslug],
  );
  return (
    <aside className={`panel map-card typed typed--${node.type}`} aria-label={`${node.title} on the map`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <TypeBadge type={node.type} />
        <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Clear focus" title="Clear focus (Esc)">
          <Icon name="close" />
        </button>
      </div>
      <h2>{node.title}</h2>
      <div className="small muted">
        {plural(node.degree, "tie")}
        {node.status ? ` · ${node.status}` : ""}
        {node.tags.length ? ` · ${node.tags.map((t) => `#${t}`).join(" ")}` : ""}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <a className="btn btn--sm btn--primary" href={href.entity(node.slug)}>
          Open the sheet <Icon name="chevron" size={16} />
        </a>
        <button type="button" className="btn btn--sm" onClick={onCenter}>
          <Icon name="eye" size={16} /> Center
        </button>
      </div>
      {rels.length > 0 ? (
        <ul className="map-card__rels">
          {rels.map((r, i) => (
            <li key={i}>
              <span className="ties__arrow" aria-hidden>
                {r.dir === "out" ? "→" : "←"}
              </span>
              <span className="map-card__rel">{r.rel}</span>
              <span className="sr-only">{r.dir === "out" ? "to" : "from"}</span>
              <button type="button" className="nodebtn" onClick={() => onPick(r.other.slug)} title={hidden.has(r.other.type) ? `${r.other.type} is hidden; picking it shows that kind again` : `Focus ${r.other.title}`}>
                <TypeDot type={r.other.type} />
                {r.other.title}
              </button>
              {hidden.has(r.other.type) && <span className="small muted">(hidden)</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted" style={{ marginTop: 12 }}>
          No ties: an island on the map.
        </p>
      )}
    </aside>
  );
}

/** The accessible view of the same graph: one row per tie. */
function EdgeTable({ graph, byslug, query }: { graph: Graph; byslug: Map<string, GraphNode>; query: string }) {
  const ref = (slug: string) => byslug.get(slug) ?? { slug, title: slug, type: "other" };
  const rows = useMemo(() => {
    const all = graph.edges.map((e) => ({ ...e, a: ref(e.from), b: ref(e.to) })).sort((x, y) => x.a.title.localeCompare(y.a.title) || x.rel.localeCompare(y.rel) || x.b.title.localeCompare(y.b.title));
    return query.trim() ? fuzzyFilter(all, query, (r) => [r.a.title, r.b.title, r.rel, r.from, r.to], all.length) : all;
  }, [graph, byslug, query]);
  const isolated = useMemo(() => {
    const linked = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
    return graph.nodes.filter((n) => !linked.has(n.slug)).sort((a, b) => a.title.localeCompare(b.title));
  }, [graph]);
  return (
    <div className="panel">
      {rows.length ? (
        <div className="table-wrap">
          <table className="table edge-table">
            <caption className="sr-only">Ties between entities{query.trim() ? `, filtered by “${query.trim()}”` : ""}</caption>
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">Tie</th>
                <th scope="col">To</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.from}|${r.rel}|${r.to}|${i}`}>
                  <td>
                    <EntityLink entity={r.a} />
                  </td>
                  <td>
                    {r.rel} <span aria-hidden>→</span>
                  </td>
                  <td>
                    <EntityLink entity={r.b} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="link" title={query.trim() ? "No tie matches" : "No ties among the shown kinds"} />
      )}
      {isolated.length > 0 && !query.trim() && (
        <p className="small muted" style={{ margin: "16px 0 0" }}>
          Unconnected:{" "}
          {isolated.map((n, i) => (
            <span key={n.slug}>
              {i > 0 && " · "}
              <EntityLink entity={n} />
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
