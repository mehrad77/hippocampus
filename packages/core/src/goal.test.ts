import { describe, expect, it } from "vitest";
import { CONFIG, fixtureStore } from "./__fixtures__/vault.ts";
import { addDuration, applyGoalUpdate, getObjectives, goalProps, goalState, goalStateOf, nextDue, parseAfterLast, renderProgress } from "./goal.ts";
import { parseDoc } from "./markdown.ts";
import { applyQuestUpdate } from "./ops.ts";
import { Vault } from "./vault.ts";
import { upcomingDates } from "./views.ts";

const now = () => new Date("2026-10-11T12:00:00.000Z");

/** The fixture vault plus a `deal` goal type with its own status words and a template, and dated character fields. */
const GOAL_CONFIG = CONFIG.replace(
  "character: { folder: characters, description: People }",
  "character: { folder: characters, description: People, fields: { birthday: { kind: date, recurs: yearly }, start: { kind: date }, nickname: text } }",
).replace(
  "party: { folder: party, description: Agents }\n",
  "party: { folder: party, description: Agents }\n  deal: { folder: deals, description: Agreements, capabilities: [goal], statuses: { open: active, stalled: blocked, won: done, lost: failed }, template: _hippo/templates/deal.md }\n",
);

const DEAL_TEMPLATE = "---\ntype: deal\ntitle: \"{{title}}\"\ntags: [sales]\nstatus: open\nowner: \"\"\n---\n\n%% hippo:begin objectives %%\n- [ ] Send the offer\n%% hippo:end objectives %%\n\n## Notes\nWhat {{title}} is about.\n";

const store = (extra: Record<string, string> = {}) =>
  fixtureStore({
    "_hippo/config.yaml": GOAL_CONFIG,
    "_hippo/templates/deal.md": DEAL_TEMPLATE,
    "characters/landlord.md": "---\ntype: character\ntitle: The landlord\nstats:\n  last: { interaction: 2026-10-05 }\n---\n",
    "deals/lease-renewal.md": "---\ntype: deal\ntitle: Lease renewal\nstatus: open\ncounterparty: \"[[landlord]]\"\n---\n%% hippo:begin objectives %%\n- [x] Read the contract\n- [ ] Sign it\n%% hippo:end objectives %%\n",
    ...extra,
  });
const load = (extra?: Record<string, string>) => Vault.load(store(extra), { now });

describe("goal props", () => {
  it("read a v1 deadline as due and the first v1 clock as progress, unless the new keys are there", async () => {
    const v = await load({
      "quests/old.md": "---\ntype: quest\ntitle: Old\ndeadline: 2026-12-01\nclocks:\n  - { name: Paperwork, segments: 4, filled: 9 }\n  - { name: Patience, segments: 6 }\n---\n",
      "quests/new.md": "---\ntype: quest\ntitle: New\ndue: 2026-11-01\ndeadline: 2026-12-01\nprogress: { done: 1, total: 3 }\nclocks: [{ name: Paperwork, segments: 4, filled: 2 }]\n---\n",
    });
    expect(goalProps(v.resolve("old")!)).toMatchObject({ due: "2026-12-01", progress: { done: 4, total: 4 } });
    expect(goalProps(v.resolve("new")!)).toMatchObject({ due: "2026-11-01", progress: { done: 1, total: 3 } });
    expect(goalProps({ fm: { type: "quest", aliases: [], tags: [], relations: [], facts: {}, progress: { done: 7, total: 3 } } }).progress).toEqual({ done: 3, total: 3 });
    expect(goalProps(v.resolve("residence-permit")!)).toMatchObject({ status: "active", owner: "[[residency-agent]]", due: "2026-11-30" });
    expect(goalProps({ fm: { type: "quest", aliases: [], tags: [], relations: [], facts: {}, repeat: "1m" } }).repeat).toEqual({ every: "1m" });
  });

  it("map a type's status words onto core states", async () => {
    const v = await load();
    const vocab = v.schema.type("deal")!.statuses;
    expect(goalState("won", vocab)).toBe("done");
    expect(goalState("Stalled", vocab)).toBe("blocked");
    expect(goalState("blocked", vocab)).toBe("blocked");
    expect(goalState("whatever", vocab)).toBe("active");
    expect(goalState(undefined)).toBe("active");
    expect(goalStateOf(v, v.resolve("lease-renewal")!)).toBe("active");
  });

  it("add calendar months and years, and parse after_last", () => {
    expect(addDuration("2026-01-31", "1m")).toBe("2026-02-28");
    expect(addDuration("2026-10-11", "2w")).toBe("2026-10-25");
    expect(addDuration("2024-02-29", "1y")).toBe("2025-02-28");
    expect(addDuration("2026-10-11", "3 days")).toBe("2026-10-14");
    expect(addDuration("2026-10-11", "soon")).toBeUndefined();
    expect(parseAfterLast("interaction")).toEqual({ kind: "interaction" });
    expect(parseAfterLast("interaction(with=[[landlord]])")).toEqual({ kind: "interaction", with: "[[landlord]]" });
    expect(parseAfterLast("rollup/call ( with = landlord )")).toEqual({ kind: "rollup/call", with: "landlord" });
  });

  it("render as one progress line", () => {
    expect(renderProgress({ progress: { done: 1, total: 4 }, due: "2026-11-30", repeat: { every: "1m" } })).toBe("▰▱▱▱ 1/4 · due 2026-11-30 · repeats every 1m");
    expect(renderProgress({ progress: { done: 50, total: 100 }, repeat: { every: "2w", after_last: "interaction" }, last_done: "2026-10-01" })).toBe(
      "▰▰▰▰▰▱▱▱▱▱ 50/100 · repeats 2w after the last interaction · last done 2026-10-01",
    );
    expect(renderProgress({})).toBe("");
  });
});

describe("applyGoalUpdate", () => {
  it("takes the type's status words or core states, and refuses others", async () => {
    const v = await load();
    const deal = v.resolve("lease-renewal")!;
    expect(applyGoalUpdate(v, deal, { status: "Stalled" }, "home-finder")).toEqual(["status stalled"]);
    expect(applyGoalUpdate(v, deal, { status: "dormant" }, "home-finder")).toEqual(["status dormant"]);
    expect(applyGoalUpdate(v, deal, { status: "dormant" }, "home-finder")).toEqual([]);
    expect(() => applyGoalUpdate(v, deal, { status: "maybe" }, "home-finder")).toThrow(/unknown status "maybe".*open, stalled, won, lost, active/);
    expect(applyGoalUpdate(v, deal, { status: "won" }, "home-finder")).toEqual(["status won"]);
    expect(goalStateOf(v, deal)).toBe("done");
    expect(deal.fm.updated_by).toBe("home-finder");
  });

  it("clamps progress, ticks it, and needs a total to start one", async () => {
    const v = await load();
    const deal = v.resolve("lease-renewal")!;
    expect(() => applyGoalUpdate(v, deal, { progress: { tick: 1 } }, "home-finder")).toThrow(/needs a total/);
    expect(applyGoalUpdate(v, deal, { progress: { total: 3, tick: 1 } }, "home-finder")).toEqual(["progress 1/3"]);
    expect(applyGoalUpdate(v, deal, { progress: { tick: 5 } }, "home-finder")).toEqual(["progress 3/3"]);
    expect(applyGoalUpdate(v, deal, { progress: { tick: 1 } }, "home-finder")).toEqual([]);
    expect(applyGoalUpdate(v, deal, { progress: { done: -2 } }, "home-finder")).toEqual(["progress 0/3"]);
    expect(applyGoalUpdate(v, deal, { progress: { done: 2, total: 5 } }, "home-finder")).toEqual(["progress 2/5"]);
    expect(applyGoalUpdate(v, deal, { progress: { total: 1 } }, "home-finder")).toEqual(["progress 1/1"]);
    expect(deal.fm.progress).toEqual({ done: 1, total: 1 });
  });

  it("sets due (replacing a v1 deadline), owner and counterparty as links", async () => {
    const v = await load();
    const quest = v.resolve("residence-permit")!;
    expect(applyGoalUpdate(v, quest, { due: "2026-12-15", owner: "Home Finder", counterparty: "Agência de Migração" }, "player")).toEqual([
      "due 2026-12-15",
      "owner [[home-finder]]",
      "counterparty [[migration-agency]]",
    ]);
    expect(quest.fm).toMatchObject({ due: "2026-12-15", owner: "[[home-finder]]", counterparty: "[[migration-agency]]" });
    expect(quest.fm).not.toHaveProperty("deadline");
    expect(() => applyGoalUpdate(v, quest, { due: "next friday" }, "player")).toThrow(/ISO date/);
    expect(applyGoalUpdate(v, quest, { due: null }, "player")).toEqual(["due none"]);
    expect(goalProps(quest).due).toBeUndefined();
    expect(() => applyGoalUpdate(v, quest, { repeat: { every: "often" } }, "player")).toThrow(/interval/);
  });

  it("rolls a repeating goal on to its next due date when it's done: objectives unticked, active again", async () => {
    const v = await load({
      "quests/rent.md": "---\ntype: quest\ntitle: Pay rent\nstatus: active\ndue: 2026-10-01\nrepeat: { every: 1m }\nprogress: { done: 2, total: 2 }\n---\n%% hippo:begin objectives %%\n- [x] Transfer\n- [ ] Keep the receipt\n%% hippo:end objectives %%\n",
    });
    const rent = v.resolve("rent")!;
    expect(applyGoalUpdate(v, rent, { status: "done", complete: ["receipt"] }, "player")).toEqual([
      "status done",
      "✓ Keep the receipt",
      "last_done 2026-10-11",
      "due 2026-11-01",
      "○ Transfer",
      "○ Keep the receipt",
      "progress 0/2",
      "status active",
    ]);
    expect(rent.fm).toMatchObject({ status: "active", due: "2026-11-01", last_done: "2026-10-11", progress: { done: 0, total: 2 } });
    expect(getObjectives(rent).every((o) => !o.done)).toBe(true);
    // A repeat without a due date counts from the day it was done.
    applyGoalUpdate(v, rent, { due: null }, "player");
    expect(applyGoalUpdate(v, rent, { status: "done" }, "player")).toContain("due 2026-11-11");
  });

  it("counts a repeat after the last contact from the counterparty's stats, in the type's own words", async () => {
    const v = await load();
    const deal = v.resolve("lease-renewal")!;
    expect(applyGoalUpdate(v, deal, { repeat: { every: "2w", after_last: "interaction" } }, "home-finder")).toEqual(["repeat every 2w after interaction"]);
    // The landlord's last interaction was 2026-10-05.
    expect(nextDue(deal, v)).toBe("2026-10-19");
    const changes = applyGoalUpdate(v, deal, { status: "won" }, "home-finder");
    // Done today (2026-10-11), later than the last contact: two weeks from today, and back to the type's word for active.
    expect(changes).toEqual(["status won", "last_done 2026-10-11", "due 2026-10-25", "○ Read the contract", "status open"]);
    expect(nextDue(deal, v)).toBe("2026-10-25");
    // A newer contact moves it.
    v.resolve("landlord")!.fm.stats = { last: { interaction: "2026-10-20" }, counts: {} };
    expect(nextDue(deal, v)).toBe("2026-11-03");
    // `with=` names someone else than the counterparty.
    applyGoalUpdate(v, deal, { repeat: { every: "1m", after_last: "interaction(with=[[player]])" } }, "home-finder");
    expect(nextDue(deal, v)).toBe("2026-11-11");
  });

  it("draws the progress region in the note, and leaves a v1 clocks region alone", async () => {
    const s = store({
      "quests/old.md": "---\ntype: quest\ntitle: Old\nclocks: [{ name: Paperwork, segments: 4, filled: 1 }]\n---\n%% hippo:begin clocks %%\n- ⏱ **Paperwork** ■□□□ 1/4\n%% hippo:end clocks %%\n\n## Notes\nKeep this.\n",
    });
    const v = await Vault.load(s, { now });
    applyQuestUpdate(v, v.resolve("old")!, { clock: { name: "Paperwork", tick: 1 }, deadline: "2026-11-30" }, "residency-agent");
    applyGoalUpdate(v, v.resolve("lease-renewal")!, { progress: { total: 2, done: 1 } }, "home-finder");
    await v.flush();
    const old = (await s.read("quests/old.md"))!;
    expect(old).toContain("%% hippo:begin progress %%\n▰▰▱▱ 2/4 · due 2026-11-30\n%% hippo:end progress %%");
    expect(old).toContain("- ⏱ **Paperwork** ■□□□ 1/4");
    expect(old).toContain("Keep this.");
    expect(parseDoc(old).data).toMatchObject({ due: "2026-11-30", progress: { done: 2, total: 4 }, clocks: [{ name: "Paperwork", segments: 4, filled: 1 }] });
    expect(await s.read("deals/lease-renewal.md")).toContain("▰▱ 1/2");
  });
});

describe("createEntity", () => {
  it("starts from the type's template: frontmatter defaults, {{title}} filled in", async () => {
    const v = await load();
    const deal = v.createEntity({ type: "deal", title: "Studio sublet", tags: ["housing"], by: "home-finder" });
    expect(deal.path).toBe("deals/studio-sublet.md");
    expect(deal.fm).toMatchObject({ type: "deal", title: "Studio sublet", status: "open", tags: ["housing", "sales"] });
    expect(deal.fm.owner).toBeUndefined();
    expect(deal.body).toContain("What Studio sublet is about.");
    expect(getObjectives(deal)).toEqual([{ text: "Send the offer", done: false }]);
    // Without a template, a blank note.
    expect(v.createEntity({ type: "lore", title: "Visa rules" }).body).toBe("\n## Notes\n");
  });

  it("warns about a missing template and starts blank", async () => {
    const s = store();
    await s.remove("_hippo/templates/deal.md");
    const v = await Vault.load(s, { now });
    expect(v.warnings).toContain('type "deal": template _hippo/templates/deal.md not found; new notes start blank');
    expect(v.createEntity({ type: "deal", title: "Bike" }).body).toBe("\n## Notes\n");
  });
});

describe("upcomingDates", () => {
  it("lists open goals' next due dates, declared date fields (yearly ones at their next occurrence) and date-like undeclared fields", async () => {
    const v = await load({
      "characters/joao-silva.md":
        "---\ntype: character\ntitle: João Silva\nfacts:\n  birthday: 1990-10-20\n  start: 2026-10-15\n  nickname: 2026-10-16\n  appointment_date: 2026-10-17\n  notes_date: { value: 2026-10-18, status: retconned }\n---\n",
      "quests/finished.md": "---\ntype: quest\ntitle: Finished\nstatus: done\ndue: 2026-10-12\n---\n",
    });
    applyGoalUpdate(v, v.resolve("lease-renewal")!, { repeat: { every: "2w", after_last: "interaction" } }, "home-finder");
    expect(upcomingDates(v, "2026-10-11", "2026-12-31")).toEqual([
      { what: "start (canon)", date: "2026-10-15", slug: "joao-silva" },
      { what: "appointment_date (canon)", date: "2026-10-17", slug: "joao-silva" },
      { what: "due", date: "2026-10-19", slug: "lease-renewal" },
      { what: "birthday (canon)", date: "2026-10-20", slug: "joao-silva" },
      { what: "due", date: "2026-11-30", slug: "residence-permit" },
    ]);
  });
});
