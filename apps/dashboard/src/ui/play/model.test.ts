import { describe, expect, it } from "vitest";
import type { EpisodeView, GoalCard, KindView, Overview } from "../../lib/types.ts";
import {
  agentIdProblem,
  byUrgency,
  changeLabel,
  confidenceLabel,
  countBy,
  editGoal,
  filterEpisodes,
  goalStateWord,
  groupGoals,
  initials,
  kindLabel,
  nextDue,
  objectiveProblem,
  progressProblem,
  roman,
  stateOf,
  statusOptions,
  unwrapRef,
  withGoal,
} from "./model.ts";

function goal(slug: string, over: Partial<GoalCard> = {}): GoalCard {
  return {
    slug,
    title: slug.replace(/-/g, " "),
    type: "goal",
    aliases: [],
    tags: [],
    summary: "",
    degree: 0,
    facts: { canon: 0, rumor: 0, disputed: 0, retconned: 0 },
    status: "active",
    state: "active",
    word: "active",
    objectives: [],
    clocks: [],
    ...over,
  };
}

function episode(id: string, over: Partial<EpisodeView> = {}): EpisodeView {
  return { id, agent: "home-finder", kind: "observation", at: "2026-10-01T10:00:00Z", path: `inbox/${id}.md`, text: "x", secret: false, about: [], waitedThroughSleep: false, ...over };
}

const TODAY = "2026-10-09";
/** A deal-like type's own words for the core states. */
const DEAL: Record<string, string> = { open: "active", stalled: "blocked", won: "done", lost: "failed" };

describe("editGoal", () => {
  const g = goal("residence-permit", {
    objectives: [
      { text: "Health insurance", done: true },
      { text: "Address proof", done: false },
    ],
    progress: { done: 3, total: 6 },
    due: "2026-10-19",
    nextDue: "2026-10-19",
    daysLeft: 10,
  });

  it("ticks, reopens and adds objectives, matching like core", () => {
    const ticked = editGoal(g, { complete: ["address proof"] }, TODAY);
    expect(ticked.objectives.map((o) => o.done)).toEqual([true, true]);
    expect(editGoal(ticked, { reopen: ["health insurance"] }, TODAY).objectives[0]!.done).toBe(false);
    const added = editGoal(g, { add: ["Biometric photos", "address  proof"] }, TODAY);
    expect(added.objectives.map((o) => o.text)).toEqual(["Health insurance", "Address proof", "Biometric photos"]);
    expect(g.objectives[1]!.done).toBe(false);
  });

  it("moves progress within 0…total, and starts tracking it", () => {
    expect(editGoal(g, { progress: { tick: 1 } }, TODAY).progress).toEqual({ done: 4, total: 6 });
    expect(editGoal(g, { progress: { done: 9 } }, TODAY).progress).toEqual({ done: 6, total: 6 });
    expect(editGoal(g, { progress: { tick: -9 } }, TODAY).progress).toEqual({ done: 0, total: 6 });
    // Shrinking the total never leaves it overfull.
    expect(editGoal(g, { progress: { total: 2 } }, TODAY).progress).toEqual({ done: 2, total: 2 });
    expect(editGoal(goal("x"), { progress: { total: 4, done: 0 } }, TODAY).progress).toEqual({ done: 0, total: 4 });
    // Without a total there's nothing to move.
    expect(editGoal(goal("x"), { progress: { tick: 1 } }, TODAY).progress).toBeUndefined();
  });

  it("sets and clears the due date", () => {
    const moved = editGoal(g, { due: "2026-10-12" }, TODAY);
    expect(moved).toMatchObject({ due: "2026-10-12", nextDue: "2026-10-12", daysLeft: 3 });
    const cleared = editGoal(g, { due: null }, TODAY);
    expect(cleared.due).toBeUndefined();
    expect(cleared.daysLeft).toBeUndefined();
  });

  it("reads status words through the type's vocabulary", () => {
    const deal = goal("big-deal", { type: "deal", word: "open" });
    expect(editGoal(deal, { status: "stalled" }, TODAY, DEAL)).toMatchObject({ word: "stalled", state: "blocked", status: "blocked" });
    expect(editGoal(deal, { status: "won" }, TODAY, DEAL)).toMatchObject({ word: "won", state: "done" });
    expect(editGoal(g, { status: "dormant" }, TODAY)).toMatchObject({ state: "dormant", word: "dormant" });
  });

  it("rolls a repeating goal over when it's done", () => {
    const rent = goal("pay-rent", { repeat: { every: "1m" }, due: "2026-10-01", nextDue: "2026-10-01", objectives: [{ text: "Transfer", done: true }], progress: { done: 2, total: 2 } });
    expect(editGoal(rent, { status: "done" }, TODAY)).toMatchObject({
      state: "active",
      word: "active",
      due: "2026-11-01",
      nextDue: "2026-11-01",
      lastDone: TODAY,
      objectives: [{ text: "Transfer", done: false }],
      progress: { done: 0, total: 2 },
    });
    // No due date: counted from today.
    expect(editGoal(goal("call-home", { repeat: { every: "1w" } }), { status: "done" }, TODAY).due).toBe("2026-10-16");
    // The type's own word for active.
    expect(editGoal(goal("retainer", { type: "deal", word: "open", repeat: { every: "1y" }, due: "2026-01-31" }), { status: "won" }, TODAY, DEAL)).toMatchObject({ word: "open", state: "active", due: "2027-01-31" });
    // Without a repeat, done is done.
    expect(editGoal(g, { status: "done" }, TODAY)).toMatchObject({ state: "done", due: "2026-10-19" });
    // Stopping the repeat in the same edit: done is done.
    expect(editGoal(rent, { status: "done", repeat: null }, TODAY)).toMatchObject({ state: "done", repeat: undefined });
  });
});

describe("withGoal", () => {
  it("replaces one card without mutating, and recounts states", () => {
    const o = { goals: [goal("a"), goal("b")], quests: [], counts: { goals: { active: 2 }, quests: { active: 2 } } } as unknown as Overview;
    const next = withGoal(o, "b", (g) => ({ ...g, status: "done", state: "done" }));
    expect(next.counts.goals).toEqual({ active: 1, done: 1 });
    expect(next.counts.quests).toEqual({ active: 1, done: 1 });
    expect(next.goals![1]!.state).toBe("done");
    expect(next.quests[1]!.state).toBe("done");
    expect(o.goals![1]!.state).toBe("active");
  });
});

describe("groupGoals", () => {
  it("groups by core state, whatever word the type uses, most urgent first", () => {
    const gs = [
      goal("university-enrollment", { state: "blocked", status: "blocked", daysLeft: 3 }),
      goal("apartment-hunt", { daysLeft: 3 }),
      goal("residence-permit", { daysLeft: -2 }),
      goal("paid-work", { state: "dormant", status: "dormant" }),
      goal("old-visa", { state: "done", status: "done", updated: "2026-09-01" }),
      goal("lost-cause", { type: "deal", word: "lost", state: "failed", status: "failed", updated: "2026-09-20" }),
    ];
    const g = groupGoals(gs);
    expect(g.board.map((x) => x.slug)).toEqual(["residence-permit", "apartment-hunt", "university-enrollment"]);
    expect(g.dormant.map((x) => x.slug)).toEqual(["paid-work"]);
    expect(g.finished.map((x) => x.slug)).toEqual(["lost-cause", "old-visa"]);
    expect(byUrgency(gs[1]!, gs[0]!)).toBeLessThan(0);
  });
});

describe("nextDue", () => {
  it("picks the soonest date still ahead, a repeat's next occurrence included", () => {
    const gs = [goal("residence-permit", { daysLeft: -2 }), goal("pay-rent", { repeat: { every: "1m" }, nextDue: "2026-10-18", daysLeft: 9 }), goal("apartment-hunt", { daysLeft: 12 })];
    expect(nextDue(gs)).toEqual({ what: "pay rent", slug: "pay-rent", daysLeft: 9 });
    expect(nextDue([goal("paid-work")])).toBeUndefined();
  });
});

describe("statuses", () => {
  it("maps words to core states like core does", () => {
    expect(stateOf("won", DEAL)).toBe("done");
    expect(stateOf("WON", DEAL)).toBe("done");
    expect(stateOf("dormant", DEAL)).toBe("dormant");
    expect(stateOf("whatever")).toBe("active");
    expect(stateOf(undefined)).toBe("active");
  });

  it("offers the type's words, else the core states", () => {
    expect(statusOptions(DEAL).map((o) => [o.word, o.state])).toEqual([
      ["open", "active"],
      ["stalled", "blocked"],
      ["won", "done"],
      ["lost", "failed"],
    ]);
    expect(statusOptions(undefined).map((o) => o.label)).toEqual(["Active", "Blocked", "On hold", "Done", "Failed"]);
    expect(statusOptions(undefined, "codex").map((o) => o.label)).toEqual(["active", "blocked", "dormant", "done", "failed"]);
  });
});

describe("validation", () => {
  const g = goal("apartment-hunt", { objectives: [{ text: "Shortlist listings", done: true }], progress: { done: 1, total: 4 } });

  it("checks progress totals", () => {
    expect(progressProblem(4)).toBeUndefined();
    expect(progressProblem(1)).toBeUndefined();
    expect(progressProblem(1000)).toBeUndefined();
    expect(progressProblem(0)).toMatch(/1 to 1000/);
    expect(progressProblem(1001)).toMatch(/1 to 1000/);
    expect(progressProblem(2.5)).toMatch(/whole/);
    expect(progressProblem(Number.NaN)).toBeDefined();
  });

  it("says it in the reader's words", () => {
    expect(objectiveProblem(g, "shortlist listings")).toBe("That step is already on the list.");
    expect(objectiveProblem(g, "shortlist listings", "codex")).toBe("That objective is already on the list.");
    expect(agentIdProblem("home-finder", ["home-finder"])).toBe('"home-finder" is already an agent.');
    expect(agentIdProblem("home-finder", ["home-finder"], undefined, "codex")).toBe('"home-finder" is already in the party.');
    expect(goalStateWord("dormant")).toBe("On hold");
    expect(goalStateWord("dormant", "codex")).toBe("dormant");
  });

  it("rewords core's goal change notes for the plain look", () => {
    expect(changeLabel("clock Lease signing 3/4")).toBe("Lease signing 3/4");
    expect(changeLabel("status → dormant")).toBe("status → On hold");
    expect(changeLabel("status dormant")).toBe("status → On hold");
    expect(changeLabel("status won")).toBe("status → won");
    expect(changeLabel("due none")).toBe("no due date");
    expect(changeLabel("progress 3/4")).toBe("progress 3/4");
    expect(changeLabel("✓ Shortlist listings")).toBe("✓ Shortlist listings");
    expect(changeLabel("clock Lease signing 3/4", "codex")).toBe("clock Lease signing 3/4");
    expect(changeLabel("status → dormant", "codex")).toBe("status → dormant");
  });

  it("checks new objectives", () => {
    expect(objectiveProblem(g, "  ")).toBeDefined();
    expect(objectiveProblem(g, "shortlist listings")).toMatch(/already/);
    expect(objectiveProblem(g, "Sign the lease")).toBeUndefined();
  });

  it("checks agent ids like core does", () => {
    expect(agentIdProblem("home-finder", ["home-finder"])).toMatch(/already/);
    expect(agentIdProblem("player", [], "player")).toMatch(/one of this vault's people/);
    expect(agentIdProblem("player", [], "player", "codex")).toMatch(/players/);
    // Every human is refused, not just the first.
    expect(agentIdProblem("Partner", [], ["player", "partner"])).toMatch(/people/);
    expect(agentIdProblem("Job Scout", [])).toMatch(/lowercase/);
    expect(agentIdProblem("-scout", [])).toMatch(/lowercase/);
    expect(agentIdProblem("a".repeat(64), [])).toMatch(/lowercase/);
    expect(agentIdProblem("job-scout", ["home-finder"])).toBeUndefined();
    expect(agentIdProblem("JOB-SCOUT", [])).toBeUndefined();
  });
});

describe("kindLabel", () => {
  const kinds: Pick<KindView, "name">[] = [{ name: "fact" }, { name: "observation" }, { name: "interaction" }, { name: "beat" }, { name: "moment" }];

  it("labels the vault's kinds from its registry", () => {
    expect(kindLabel("beat", kinds)).toBe("Milestone");
    expect(kindLabel("beat", kinds, "codex")).toBe("Story beat");
    expect(kindLabel("fact", kinds, "codex")).toBe("Fact");
    // A kind the vault added reads as its name.
    expect(kindLabel("moment", kinds)).toBe("Moment");
    expect(kindLabel("site_visit")).toBe("Site visit");
  });

  it("names an interaction's channel, and flags kinds the registry doesn't know", () => {
    expect(kindLabel("interaction/call", kinds)).toBe("Contact · call");
    expect(kindLabel("rumination", kinds)).toBe("Rumination (as observation)");
    // Before the registry loads, nothing is flagged.
    expect(kindLabel("rumination")).toBe("Rumination");
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
