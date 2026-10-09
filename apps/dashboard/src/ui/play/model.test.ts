import { describe, expect, it } from "vitest";
import type { EpisodeView, Overview, QuestCard } from "../../lib/types.ts";
import { agentIdProblem, byUrgency, clockProblem, confidenceLabel, countBy, editQuest, filterEpisodes, groupQuests, initials, nextDue, objectiveProblem, roman, unwrapRef, withQuest } from "./model.ts";

function quest(slug: string, over: Partial<QuestCard> = {}): QuestCard {
  return {
    slug,
    title: slug.replace(/-/g, " "),
    type: "quest",
    aliases: [],
    tags: [],
    summary: "",
    degree: 0,
    facts: { canon: 0, rumor: 0, disputed: 0, retconned: 0 },
    status: "active",
    objectives: [],
    clocks: [],
    ...over,
  };
}

function episode(id: string, over: Partial<EpisodeView> = {}): EpisodeView {
  return { id, agent: "home-finder", kind: "observation", at: "2026-10-01T10:00:00Z", path: `inbox/${id}.md`, text: "x", secret: false, about: [], waitedThroughSleep: false, ...over };
}

describe("editQuest", () => {
  const q = quest("residence-permit", {
    objectives: [
      { text: "Health insurance", done: true },
      { text: "Address proof", done: false },
    ],
    clocks: [{ name: "Paperwork", segments: 6, filled: 3 }],
  });

  it("ticks and unticks objectives by their exact text", () => {
    const ticked = editQuest(q, { complete: ["Address proof"] }, "2026-10-09");
    expect(ticked.objectives).toEqual([
      { text: "Health insurance", done: true },
      { text: "Address proof", done: true },
    ]);
    expect(editQuest(ticked, { reopen: ["health insurance"] }, "2026-10-09").objectives[0]!.done).toBe(false);
    // The original card is untouched: optimistic edits must be undoable.
    expect(q.objectives[1]!.done).toBe(false);
  });

  it("adds objectives once", () => {
    const added = editQuest(q, { add: ["Biometric photos", "address  proof"] }, "2026-10-09");
    expect(added.objectives.map((o) => o.text)).toEqual(["Health insurance", "Address proof", "Biometric photos"]);
  });

  it("sets, clamps and creates clocks", () => {
    expect(editQuest(q, { clock: { name: "paperwork", filled: 9 } }, "2026-10-09").clocks[0]).toMatchObject({ name: "Paperwork", filled: 6 });
    const added = editQuest(q, { clock: { name: "Landlord patience", segments: 4 } }, "2026-10-09");
    expect(added.clocks[1]).toEqual({ name: "Landlord patience", segments: 4, filled: 0, deadline: undefined, daysLeft: undefined });
  });

  it("sets status and deadline with a fresh countdown", () => {
    const e = editQuest(q, { status: "blocked", deadline: "2026-10-19" }, "2026-10-09");
    expect(e.status).toBe("blocked");
    expect(e.deadline).toBe("2026-10-19");
    expect(e.daysLeft).toBe(10);
  });
});

describe("withQuest", () => {
  it("replaces one card and recounts statuses", () => {
    const o = { quests: [quest("a"), quest("b")], counts: { quests: { active: 2 } } } as unknown as Overview;
    const next = withQuest(o, "b", (q) => ({ ...q, status: "done" }));
    expect(next.counts.quests).toEqual({ active: 1, done: 1 });
    expect(next.quests[1]!.status).toBe("done");
    expect(o.quests[1]!.status).toBe("active");
  });
});

describe("groupQuests", () => {
  it("puts urgent work first and splits the rest", () => {
    const qs = [
      quest("paid-work", { status: "dormant" }),
      quest("apartment-hunt", { daysLeft: 9 }),
      quest("university-enrollment", { status: "blocked" }),
      quest("residence-permit", { daysLeft: -2 }),
      quest("old-visa", { status: "done", updated: "2026-09-01" }),
      quest("lost-cause", { status: "failed", updated: "2026-10-01" }),
    ];
    const g = groupQuests(qs);
    expect(g.board.map((q) => q.slug)).toEqual(["residence-permit", "apartment-hunt", "university-enrollment"]);
    expect(g.dormant.map((q) => q.slug)).toEqual(["paid-work"]);
    expect(g.finished.map((q) => q.slug)).toEqual(["lost-cause", "old-visa"]);
  });

  it("orders active before blocked at the same deadline", () => {
    expect([quest("b", { status: "blocked" }), quest("a")].sort(byUrgency).map((q) => q.slug)).toEqual(["a", "b"]);
  });
});

describe("nextDue", () => {
  it("counts clock deadlines and skips overdue ones", () => {
    const qs = [
      quest("residence-permit", { daysLeft: 45, clocks: [{ name: "Paperwork", segments: 6, filled: 3, daysLeft: 18 }] }),
      quest("apartment-hunt", { daysLeft: -1, clocks: [{ name: "Lease signing", segments: 4, filled: 2, daysLeft: 9 }] }),
    ];
    expect(nextDue(qs)).toEqual({ what: "apartment hunt: Lease signing clock", slug: "apartment-hunt", daysLeft: 9 });
    expect(nextDue([quest("paid-work")])).toBeUndefined();
  });
});

describe("validation", () => {
  const q = quest("apartment-hunt", { objectives: [{ text: "Shortlist listings", done: true }], clocks: [{ name: "Lease signing", segments: 4, filled: 1 }] });

  it("checks new clocks", () => {
    expect(clockProblem(q, "", 4)).toMatch(/Name/);
    expect(clockProblem(q, "lease signing", 4)).toMatch(/already/);
    expect(clockProblem(q, "Deposit", 1)).toMatch(/2 to 12/);
    expect(clockProblem(q, "Deposit", 13)).toMatch(/2 to 12/);
    expect(clockProblem(q, "Deposit", 6)).toBeUndefined();
  });

  it("checks new objectives", () => {
    expect(objectiveProblem(q, "  ")).toBeDefined();
    expect(objectiveProblem(q, "shortlist listings")).toMatch(/already/);
    expect(objectiveProblem(q, "Sign the lease")).toBeUndefined();
  });

  it("checks agent ids like core does", () => {
    expect(agentIdProblem("home-finder", ["home-finder"])).toMatch(/already/);
    expect(agentIdProblem("player", [], "player")).toMatch(/human/);
    expect(agentIdProblem("Job Scout", [])).toMatch(/lowercase/);
    expect(agentIdProblem("-scout", [])).toMatch(/lowercase/);
    expect(agentIdProblem("a".repeat(64), [])).toMatch(/lowercase/);
    expect(agentIdProblem("job-scout", ["home-finder"])).toBeUndefined();
    expect(agentIdProblem("JOB-SCOUT", [])).toBeUndefined();
  });
});

describe("satchel helpers", () => {
  it("filters by agent and kind, newest first", () => {
    const eps = [episode("ep-1", { at: "2026-10-01T09:00:00Z" }), episode("ep-2", { agent: "job-scout", at: "2026-10-02T09:00:00Z" }), episode("ep-3", { kind: "fact", at: "2026-10-03T09:00:00Z" })];
    expect(filterEpisodes(eps, {}).map((e) => e.id)).toEqual(["ep-3", "ep-2", "ep-1"]);
    expect(filterEpisodes(eps, { agent: "home-finder" }).map((e) => e.id)).toEqual(["ep-3", "ep-1"]);
    expect(filterEpisodes(eps, { agent: "home-finder", kind: "fact" }).map((e) => e.id)).toEqual(["ep-3"]);
    expect(countBy(eps, (e) => e.agent)).toEqual([
      ["home-finder", 2],
      ["job-scout", 1],
    ]);
  });

  it("reads links and confidence", () => {
    expect(unwrapRef("[[migration-agency]]")).toBe("migration-agency");
    expect(unwrapRef("[[Harbor University|the uni]]")).toBe("Harbor University");
    expect(unwrapRef("[[lisbon#Rent]]")).toBe("lisbon");
    expect(unwrapRef("lisbon")).toBe("lisbon");
    expect(confidenceLabel(0.8)).toBe("80% sure");
    expect(confidenceLabel(undefined)).toBeUndefined();
  });
});

describe("flourishes", () => {
  it("numbers claims and draws sigils", () => {
    expect([1, 2, 3, 4, 9, 14].map(roman)).toEqual(["I", "II", "III", "IV", "IX", "XIV"]);
    expect(initials("Residency Agent")).toBe("RA");
    expect(initials("archivist")).toBe("AR");
  });
});
