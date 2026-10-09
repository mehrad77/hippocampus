import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { EntityDetail, Graph, Ref } from "./types.ts";

// Pure helpers for the relation map and the entity sheet's relations: graph shaping, the force
// layout (d3-force runs fine without a DOM), and pan/zoom math. Unit-tested in graph.test.ts.

export type GraphNode = Graph["nodes"][number];
export type GraphEdge = Graph["edges"][number];

/** Entity types in the order legends list them; types a vault adds sort after these. */
export const TYPE_ORDER = ["campaign", "quest", "party", "character", "faction", "location", "item", "lore"];

export function typeRank(type: string): number {
  const i = TYPE_ORDER.indexOf(type);
  return i < 0 ? TYPE_ORDER.length : i;
}

/** `[type, count]` pairs in legend order. */
export function typeCounts(nodes: Pick<GraphNode, "type">[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  return [...counts].sort((a, b) => typeRank(a[0]) - typeRank(b[0]) || a[0].localeCompare(b[0]));
}

/**
 * Every relation between the same two entities as one line: `forward` rels run source → target,
 * `backward` ones target → source. Self-loops and exact duplicates are dropped.
 */
export interface MergedEdge {
  key: string;
  source: string;
  target: string;
  forward: string[];
  backward: string[];
}

export function mergeEdges(edges: GraphEdge[]): MergedEdge[] {
  const byPair = new Map<string, MergedEdge>();
  for (const { from, rel, to } of edges) {
    if (from === to) continue;
    const key = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
    let m = byPair.get(key);
    if (!m) byPair.set(key, (m = { key, source: from, target: to, forward: [], backward: [] }));
    const list = m.source === from ? m.forward : m.backward;
    if (!list.includes(rel)) list.push(rel);
  }
  return [...byPair.values()];
}

/** The nodes whose type isn't hidden, and the edges between them. */
export function visibleGraph(graph: Graph, hidden: ReadonlySet<string>): Graph {
  const nodes = graph.nodes.filter((n) => !hidden.has(n.type));
  const keep = new Set(nodes.map((n) => n.slug));
  return { nodes, edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
}

export function neighborsOf(edges: Pick<MergedEdge, "source" | "target">[], slug: string): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.source === slug) out.add(e.target);
    else if (e.target === slug) out.add(e.source);
  }
  return out;
}

/** Hubs read bigger, but never swallow their neighbors. */
export function nodeRadius(degree: number): number {
  return Math.min(24, 7 + Math.sqrt(Math.max(0, degree)) * 3.2);
}

/** Labels for everyone on small maps; on big ones only hubs until you zoom in. */
export function showLabel(degree: number, k: number, total: number): boolean {
  if (total <= 45) return true;
  return k >= 1.35 || degree * k >= 5;
}

// ── Force layout ─────────────────────────────────────────────────────────────

export interface SimNode extends SimulationNodeDatum, GraphNode {
  r: number;
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  key: string;
}

export type MapSimulation = Simulation<SimNode, SimLink>;

/**
 * A stopped simulation around (0, 0); the caller ticks it (synchronously, or one frame at a time).
 * Positions already on the nodes are kept, so toggling a type doesn't reshuffle the whole map.
 */
export function createSimulation(nodes: SimNode[], edges: MergedEdge[]): MapSimulation {
  const links: SimLink[] = edges.map((e) => ({ key: e.key, source: e.source, target: e.target }));
  return forceSimulation<SimNode, SimLink>(nodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.slug)
        .distance((l) => 46 + (l.source as SimNode).r + (l.target as SimNode).r),
    )
    .force("charge", forceManyBody<SimNode>().strength(-240).distanceMax(520))
    .force("collide", forceCollide<SimNode>().radius((d) => d.r + 12))
    // Gentle pulls toward the middle keep islands (unconnected entities) on screen.
    .force("x", forceX<SimNode>(0).strength(0.06))
    .force("y", forceY<SimNode>(0).strength(0.06))
    .stop();
}

/** Tick until the simulation comes to rest (or `max` ticks). Returns how many ran. */
export function settle(sim: Pick<MapSimulation, "alpha" | "alphaMin" | "tick">, max = 400): number {
  let n = 0;
  while (sim.alpha() > sim.alphaMin() && n < max) {
    sim.tick();
    n++;
  }
  return n;
}

// ── Pan and zoom ─────────────────────────────────────────────────────────────

/** screen = world × k + (x, y) */
export interface View {
  x: number;
  y: number;
  k: number;
}

export const MIN_K = 0.15;
export const MAX_K = 4;

export function clampK(k: number): number {
  return Math.min(MAX_K, Math.max(MIN_K, k));
}

export function toWorld(v: View, px: number, py: number): [number, number] {
  return [(px - v.x) / v.k, (py - v.y) / v.k];
}

export function toScreen(v: View, wx: number, wy: number): [number, number] {
  return [wx * v.k + v.x, wy * v.k + v.y];
}

/** Zoom by `factor`, keeping the world point under the screen point (px, py) still. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const k = clampK(v.k * factor);
  const f = k / v.k;
  return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { k: v.k, x: v.x + dx, y: v.y + dy };
}

/** Put the world point (wx, wy) in the middle of a `width`×`height` screen. */
export function centerOn(v: View, wx: number, wy: number, width: number, height: number, k = v.k): View {
  const kk = clampK(k);
  return { k: kk, x: width / 2 - wx * kk, y: height / 2 - wy * kk };
}

/** Frame every node (with its radius) in the screen, never zooming in past 1.6×. */
export function fitView(points: { x?: number; y?: number; r?: number }[], width: number, height: number, pad = 48): View {
  const ps = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!ps.length || width <= 0 || height <= 0) return { k: 1, x: width / 2, y: height / 2 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of ps) {
    const r = p.r ?? 0;
    x0 = Math.min(x0, p.x! - r);
    y0 = Math.min(y0, p.y! - r);
    x1 = Math.max(x1, p.x! + r);
    y1 = Math.max(y1, p.y! + r);
  }
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const k = clampK(Math.min(1.6, (width - 2 * pad) / w, (height - 2 * pad) / h));
  return centerOn({ x: 0, y: 0, k }, (x0 + x1) / 2, (y0 + y1) / 2, width, height, k);
}

type Pt = { x: number; y: number };

/** Two-finger gesture: zoom by the change in finger spread about the old midpoint, then follow the midpoint. */
export function pinch(v: View, before: [Pt, Pt], after: [Pt, Pt]): View {
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const d0 = dist(...before);
  const d1 = dist(...after);
  const m0 = mid(...before);
  const m1 = mid(...after);
  const zoomed = d0 > 0 ? zoomAt(v, d1 / d0, m0.x, m0.y) : v;
  return panBy(zoomed, m1.x - m0.x, m1.y - m0.y);
}

/** A segment between two circles, trimmed so it starts and ends at their rims (arrowheads land on the edge). */
export function trimSegment(x1: number, y1: number, x2: number, y2: number, r1: number, r2: number): [number, number, number, number] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  if (d <= r1 + r2 || d === 0) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    return [mx, my, mx, my];
  }
  const ux = dx / d;
  const uy = dy / d;
  return [x1 + ux * r1, y1 + uy * r1, x2 - ux * r2, y2 - uy * r2];
}

// ── Entity sheet relations ───────────────────────────────────────────────────

export interface RelationGroup {
  rel: string;
  items: { dir: "out" | "in"; ref: Ref }[];
}

/** Relations grouped by name (alphabetical), outgoing before incoming, then by title. */
export function groupRelations(relations: EntityDetail["relations"]): RelationGroup[] {
  const groups = new Map<string, RelationGroup>();
  for (const r of relations) {
    let g = groups.get(r.rel);
    if (!g) groups.set(r.rel, (g = { rel: r.rel, items: [] }));
    if (!g.items.some((x) => x.dir === r.dir && x.ref.slug === r.ref.slug)) g.items.push({ dir: r.dir, ref: r.ref });
  }
  for (const g of groups.values()) g.items.sort((a, b) => (a.dir === b.dir ? a.ref.title.localeCompare(b.ref.title) : a.dir === "out" ? -1 : 1));
  return [...groups.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}
