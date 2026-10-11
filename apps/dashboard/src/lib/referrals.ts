import type { AdminReferrals } from "@hippocampus/dashboard";
import { createSimulation, fitView, nodeRadius, settle, type MergedEdge, type SimNode, type View } from "./graph.ts";

// The admin's referral graph: who invited whom. Pure shaping and layout (the relation map's force
// layout), unit-tested in referrals.test.ts.

export type Person = AdminReferrals["people"][number];

export interface ReferralNode extends Person {
  /** How many people they brought in. */
  invited: number;
}

export interface ReferralGraph {
  nodes: ReferralNode[];
  /** `from` → `to`, one per accepted invite (the first one counts when someone accepted several from the same person). */
  edges: { key: string; from: string; to: string; at: string; vault?: string }[];
}

/** People connected by at least one accepted invite (everyone with `all`), and the invites between them. */
export function referralGraph(data: AdminReferrals, opts: { all?: boolean } = {}): ReferralGraph {
  const seen = new Set<string>();
  const edges = data.edges.filter((e) => {
    const key = `${e.from}>${e.to}`;
    if (seen.has(key) || e.from === e.to) return false;
    seen.add(key);
    return true;
  });
  const invited = new Map<string, number>();
  for (const e of edges) invited.set(e.from, (invited.get(e.from) ?? 0) + 1);
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const nodes = data.people.filter((p) => opts.all || linked.has(p.user)).map((p) => ({ ...p, invited: invited.get(p.user) ?? 0 }));
  const known = new Set(nodes.map((n) => n.user));
  return { nodes, edges: edges.filter((e) => known.has(e.from) && known.has(e.to)).map((e) => ({ key: `${e.from}>${e.to}`, ...e })) };
}

/** Inviters by how many people they brought in, most first; ties by login. */
export function topInviters(graph: ReferralGraph): ReferralNode[] {
  return graph.nodes.filter((n) => n.invited > 0).sort((a, b) => b.invited - a.invited || a.login.localeCompare(b.login));
}

/** Who invited `user`, and whom they invited, with when. */
export function around(graph: ReferralGraph, user: string): { by?: ReferralNode; at?: string; brought: { person: ReferralNode; at: string }[] } {
  const byUser = new Map(graph.nodes.map((n) => [n.user, n]));
  const inbound = graph.edges.find((e) => e.to === user);
  return {
    ...(inbound ? { by: byUser.get(inbound.from), at: inbound.at } : {}),
    brought: graph.edges.filter((e) => e.from === user).flatMap((e) => (byUser.has(e.to) ? [{ person: byUser.get(e.to)!, at: e.at }] : [])),
  };
}

export interface PlacedPerson extends ReferralNode {
  x: number;
  y: number;
  r: number;
}

/** A settled layout framed in `width` × `height`: inviters read bigger, as hubs do on the relation map. */
export function layoutReferrals(graph: ReferralGraph, width: number, height: number): { people: PlacedPerson[]; view: View } {
  const sim: SimNode[] = graph.nodes.map((n) => ({ slug: n.user, title: n.login, type: n.status, tags: [], degree: n.invited, r: nodeRadius(n.invited * 2) }));
  const edges: MergedEdge[] = graph.edges.map((e) => ({ key: e.key, source: e.from, target: e.to, forward: ["invited"], backward: [] }));
  settle(createSimulation(sim, edges));
  const byUser = new Map(graph.nodes.map((n) => [n.user, n]));
  const people = sim.map((s) => ({ ...byUser.get(s.slug)!, x: s.x ?? 0, y: s.y ?? 0, r: s.r }));
  return { people, view: fitView(people, width, height) };
}
