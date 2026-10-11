import { describe, expect, it } from "vitest";
import { around, layoutReferrals, referralGraph, topInviters } from "./referrals.ts";

const people = [
  { user: "u1", login: "player", status: "approved" as const, canInvite: true },
  { user: "u2", login: "game-master", status: "approved" as const, invitedBy: "u1", canInvite: true },
  { user: "u3", login: "job-scout", status: "approved" as const, invitedBy: "u1", canInvite: false },
  { user: "u4", login: "harbor-student", status: "approved" as const, invitedBy: "u2", canInvite: true },
  { user: "u5", login: "campus-visitor", status: "waitlisted" as const, canInvite: true },
];
const edges = [
  { from: "u1", to: "u2", at: "2026-10-01T00:00:00Z", vault: "player/vault" },
  { from: "u1", to: "u3", at: "2026-10-02T00:00:00Z" },
  { from: "u2", to: "u4", at: "2026-10-03T00:00:00Z" },
  // Accepted a second invite from the same person: still one edge.
  { from: "u1", to: "u2", at: "2026-10-04T00:00:00Z" },
];

describe("the referral graph", () => {
  it("keeps the people invites connect, one edge per pair, and counts who brought whom", () => {
    const g = referralGraph({ people, edges });
    expect(g.nodes.map((n) => [n.login, n.invited])).toEqual([
      ["player", 2],
      ["game-master", 1],
      ["job-scout", 0],
      ["harbor-student", 0],
    ]);
    expect(g.edges.map((e) => e.key)).toEqual(["u1>u2", "u1>u3", "u2>u4"]);
    expect(referralGraph({ people, edges }, { all: true }).nodes).toHaveLength(5);
    expect(topInviters(g).map((n) => n.login)).toEqual(["player", "game-master"]);
  });

  it("says who invited someone and whom they invited", () => {
    const g = referralGraph({ people, edges });
    const gm = around(g, "u2");
    expect(gm.by?.login).toBe("player");
    expect(gm.brought.map((b) => b.person.login)).toEqual(["harbor-student"]);
    expect(around(g, "u1").by).toBeUndefined();
  });

  it("lays everyone out in the frame, inviters bigger", () => {
    const { people: placed, view } = layoutReferrals(referralGraph({ people, edges }), 600, 400);
    expect(placed).toHaveLength(4);
    for (const p of placed) {
      const sx = p.x * view.k + view.x;
      const sy = p.y * view.k + view.y;
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThanOrEqual(600);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThanOrEqual(400);
    }
    const r = new Map(placed.map((p) => [p.login, p.r]));
    expect(r.get("player")!).toBeGreaterThan(r.get("job-scout")!);
  });
});
