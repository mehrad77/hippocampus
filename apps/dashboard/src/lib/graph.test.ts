import { describe, expect, it } from "vitest";
import {
  MAX_K,
  MIN_K,
  centerOn,
  createSimulation,
  fitView,
  groupRelations,
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
  type SimNode,
} from "./graph.ts";
import type { Graph } from "./types.ts";

const node = (slug: string, type: string, degree = 0) => ({ slug, title: slug, type, tags: [], degree });

const GRAPH: Graph = {
  nodes: [node("residency-agent", "party", 2), node("residence-permit", "quest", 3), node("migration-agency", "faction", 2), node("lisbon", "location", 1), node("player", "character", 0)],
  edges: [
    { from: "residency-agent", rel: "owns", to: "residence-permit" },
    { from: "residence-permit", rel: "involves", to: "migration-agency" },
    { from: "migration-agency", rel: "located_in", to: "lisbon" },
    { from: "residence-permit", rel: "owned_by", to: "residency-agent" },
    { from: "residency-agent", rel: "owns", to: "residence-permit" },
    { from: "lisbon", rel: "near", to: "lisbon" },
  ],
};

describe("graph shaping", () => {
  it("merges relations between the same pair, keeping direction and dropping duplicates and loops", () => {
    const merged = mergeEdges(GRAPH.edges);
    expect(merged).toHaveLength(3);
    const pair = merged.find((m) => m.source === "residency-agent")!;
    expect(pair).toMatchObject({ target: "residence-permit", forward: ["owns"], backward: ["owned_by"] });
  });

  it("hides types and the edges that touch them", () => {
    const g = visibleGraph(GRAPH, new Set(["faction"]));
    expect(g.nodes.map((n) => n.slug)).not.toContain("migration-agency");
    expect(g.edges.some((e) => e.from === "migration-agency" || e.to === "migration-agency")).toBe(false);
    expect(g.edges.some((e) => e.rel === "owns")).toBe(true);
  });

  it("finds neighbors in either direction", () => {
    const n = neighborsOf(mergeEdges(GRAPH.edges), "residence-permit");
    expect([...n].sort()).toEqual(["migration-agency", "residency-agent"]);
  });

  it("counts types in legend order", () => {
    expect(typeCounts([...GRAPH.nodes, node("archivist", "party"), node("x", "zeta")])).toEqual([
      ["quest", 1],
      ["party", 2],
      ["character", 1],
      ["faction", 1],
      ["location", 1],
      ["zeta", 1],
    ]);
  });

  it("sizes hubs bigger but capped", () => {
    expect(nodeRadius(0)).toBe(7);
    expect(nodeRadius(4)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(1000)).toBe(24);
  });

  it("labels everything on small maps and hubs on big ones", () => {
    expect(showLabel(0, 0.5, 10)).toBe(true);
    expect(showLabel(0, 0.5, 200)).toBe(false);
    expect(showLabel(12, 0.5, 200)).toBe(true);
    expect(showLabel(0, 2, 200)).toBe(true);
  });
});

describe("force layout", () => {
  it("settles deterministically, without overlapping nodes", () => {
    const run = () => {
      const nodes: SimNode[] = GRAPH.nodes.map((n) => ({ ...n, r: nodeRadius(n.degree) }));
      const sim = createSimulation(nodes, mergeEdges(GRAPH.edges));
      const ticks = settle(sim);
      return { nodes, ticks, alpha: sim.alpha(), min: sim.alphaMin() };
    };
    const a = run();
    const b = run();
    expect(a.ticks).toBeGreaterThan(0);
    expect(a.alpha).toBeLessThanOrEqual(a.min);
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
    for (const p of a.nodes)
      for (const q of a.nodes) if (p !== q) expect(Math.hypot(p.x! - q.x!, p.y! - q.y!)).toBeGreaterThan(p.r + q.r);
  });

  it("keeps existing positions when rebuilt", () => {
    const nodes: SimNode[] = GRAPH.nodes.map((n, i) => ({ ...n, r: 8, x: i * 100, y: 0 }));
    const sim = createSimulation(nodes, []);
    expect(nodes[3]!.x).toBe(300);
    sim.tick();
    expect(Math.abs(nodes[3]!.x! - 300)).toBeLessThan(50);
  });
});

describe("pan and zoom", () => {
  const v = { x: 10, y: 20, k: 2 };

  it("round-trips screen and world coordinates", () => {
    const [wx, wy] = toWorld(v, 110, 220);
    expect([wx, wy]).toEqual([50, 100]);
    expect(toScreen(v, wx, wy)).toEqual([110, 220]);
  });

  it("zooms about the pointer", () => {
    const z = zoomAt(v, 1.5, 200, 100);
    expect(z.k).toBe(3);
    expect(toWorld(z, 200, 100)).toEqual(toWorld(v, 200, 100));
  });

  it("clamps zoom", () => {
    expect(zoomAt(v, 100, 0, 0).k).toBe(MAX_K);
    expect(zoomAt(v, 0.0001, 0, 0).k).toBe(MIN_K);
  });

  it("pans", () => {
    expect(panBy(v, 5, -5)).toEqual({ x: 15, y: 15, k: 2 });
  });

  it("centers a world point", () => {
    const c = centerOn(v, 50, 50, 400, 300);
    expect(toScreen(c, 50, 50)).toEqual([200, 150]);
  });

  it("fits every node in the screen", () => {
    const pts = [
      { x: -500, y: -100, r: 10 },
      { x: 500, y: 100, r: 10 },
    ];
    const f = fitView(pts, 800, 600, 40);
    for (const p of pts) {
      const [sx, sy] = toScreen(f, p.x, p.y);
      expect(sx).toBeGreaterThanOrEqual(40);
      expect(sx).toBeLessThanOrEqual(760);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThanOrEqual(600);
    }
    expect(fitView([{ x: 0, y: 0 }], 800, 600).k).toBe(1.6);
    expect(fitView([], 800, 600)).toEqual({ k: 1, x: 400, y: 300 });
  });

  it("pinches: spreading fingers zooms in, moving them pans", () => {
    const p = pinch({ x: 0, y: 0, k: 1 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: -50, y: 0 }, { x: 150, y: 0 }]);
    expect(p.k).toBe(2);
    expect(toWorld(p, 50, 0)).toEqual([50, 0]);
    const moved = pinch({ x: 0, y: 0, k: 1 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 10, y: 20 }, { x: 110, y: 20 }]);
    expect(moved).toEqual({ x: 10, y: 20, k: 1 });
  });

  it("trims segments to the circles' rims", () => {
    expect(trimSegment(0, 0, 100, 0, 10, 20)).toEqual([10, 0, 80, 0]);
    expect(trimSegment(0, 0, 10, 0, 10, 20)).toEqual([5, 0, 5, 0]);
  });
});

describe("relation groups", () => {
  it("groups by rel, outgoing first, then by title", () => {
    const ref = (slug: string, title = slug) => ({ slug, title, type: "faction" });
    const groups = groupRelations([
      { rel: "involves", dir: "in", ref: ref("residence-permit", "Residence permit") },
      { rel: "located_in", dir: "out", ref: ref("lisbon", "Lisbon") },
      { rel: "involves", dir: "out", ref: ref("permit-portal", "Permit portal") },
      { rel: "involves", dir: "in", ref: ref("apartment-hunt", "Apartment hunt") },
      { rel: "involves", dir: "in", ref: ref("apartment-hunt", "Apartment hunt") },
    ]);
    expect(groups.map((g) => g.rel)).toEqual(["involves", "located_in"]);
    expect(groups[0]!.items.map((i) => `${i.dir}:${i.ref.slug}`)).toEqual(["out:permit-portal", "in:apartment-hunt", "in:residence-permit"]);
  });
});
