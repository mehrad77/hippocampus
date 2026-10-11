import { describe, expect, it } from "vitest";
import { managedStore } from "./__fixtures__/managed.ts";
import { getHumanGuidelines, parseEntity, renderEntity } from "./entity.ts";
import { addGuideline, answerQuestions, applyStats, logDecision, openQuestion, rebuildStats } from "./reducers.ts";
import { Vault } from "./vault.ts";
import { parseChronicleDay } from "./views.ts";

const now = () => new Date("2026-09-27T12:00:00.000Z");
const load = (extra: Record<string, string> = {}) => Vault.load(managedStore(extra), { now });
const prov = (by: string, at = "2026-09-20T10:00:00.000Z", src = ["ep-1"]) => ({ by, at, src });

describe("applyStats", () => {
  it("counts per kind and channel on data.with targets, with first met, last per kind and last contact", async () => {
    const v = await load();
    const rollup = v.schema.kind("rollup").def;
    const landlord = v.resolve("landlord")!;
    const agency = v.resolve("migration-agency")!;
    const call = { at: "2026-09-20T10:00:00.000Z", about: ["migration-agency"], data: { with: ["[[landlord]]"], channel: "call" } };
    expect(applyStats(v, call, rollup, [agency])).toEqual(["landlord"]);
    applyStats(v, { at: "2026-09-25T10:00:00.000Z", about: [], data: { with: ["[[landlord]]"], channel: "email" } }, rollup, []);
    applyStats(v, { at: "2026-08-01T10:00:00.000Z", about: [], data: { with: ["[[landlord]]"], channel: "visit" } }, rollup, []);
    expect(landlord.fm.stats).toEqual({
      first_met: "2026-08-01",
      last_contact: "2026-09-20",
      last: { rollup: "2026-09-25", "rollup/call": "2026-09-20", "rollup/email": "2026-09-25", "rollup/visit": "2026-08-01" },
      counts: { rollup: 3, "rollup/call": 1, "rollup/email": 1, "rollup/visit": 1 },
    });
    expect(agency.fm.stats).toBeUndefined();
  });

  it("falls back to about, then to touched entities, never agents or humans", async () => {
    const v = await load();
    const obs = v.schema.kind("observation").def;
    expect(applyStats(v, { at: "2026-09-20T10:00:00.000Z", about: ["Agência de Migração"] }, obs, [])).toEqual(["migration-agency"]);
    const touched = ["residency-agent", "player", "lisbon-x", "landlord"].map((s) => v.resolve(s)).filter((e) => !!e);
    expect(applyStats(v, { at: "2026-09-20T10:00:00.000Z", about: [] }, obs, touched)).toEqual(["landlord"]);
    // An observation isn't contact.
    expect(v.resolve("landlord")!.fm.stats).toMatchObject({ first_met: "2026-09-20", counts: { observation: 1 } });
    expect(v.resolve("landlord")!.fm.stats?.last_contact).toBeUndefined();
  });

  it("rebuilds stats from the chronicle", async () => {
    const day = `---\ntype: chronicle\n---\n# 2026-09-20\n\n> [!episode] 09:15 · [[home-finder]] · rollup/call\n> call with [[landlord]]\n\n^ep-a\n\n> [!episode] 10:00 · [[home-finder]] · observation\n> The landlord fixed the boiler.\n>\n> ↳ [[landlord]] · [[residency-agent]]\n\n^ep-b\n`;
    const v = await load({ "characters/landlord.md": "---\ntype: character\ntitle: The landlord\nstats: { first_met: 2020-01-01, counts: { rollup: 40 } }\n---\n" });
    const updated = rebuildStats(v, parseChronicleDay("2026-09-20", day));
    expect(updated).toEqual(["landlord"]);
    expect(v.resolve("landlord")!.fm.stats).toEqual({
      first_met: "2026-09-20",
      last_contact: "2026-09-20",
      last: { rollup: "2026-09-20", "rollup/call": "2026-09-20", observation: "2026-09-20" },
      counts: { rollup: 1, "rollup/call": 1, observation: 1 },
    });
  });
});

describe("decisions and questions", () => {
  it("logs decisions once by their words, keeping the newest past the cap", async () => {
    const v = await load();
    const quest = v.resolve("residence-permit")!;
    logDecision(v, quest, { what: "Apply in Lisbon", why: "closest office", alternatives: ["Porto"] }, prov("residency-agent", "2026-09-01T10:00:00.000Z"));
    logDecision(v, quest, { what: "apply in lisbon.", why: "still closest" }, prov("residency-agent", "2026-09-02T10:00:00.000Z"));
    expect(quest.fm.decisions).toHaveLength(1);
    expect(quest.fm.decisions![0]).toMatchObject({ what: "apply in lisbon.", why: "still closest" });
    logDecision(v, quest, { what: "Book the earliest slot" }, prov("residency-agent", "2026-09-03T10:00:00.000Z"));
    logDecision(v, quest, { what: "Bring biometric photos" }, prov("residency-agent", "2026-09-04T10:00:00.000Z"));
    expect(quest.fm.decisions!.map((d) => d.what)).toEqual(["Book the earliest slot", "Bring biometric photos"]);
  });

  it("opens questions once, answers them, and drops closed ones first past the cap", async () => {
    const v = await load();
    const quest = v.resolve("residence-permit")!;
    const a = openQuestion(v, quest, "Which documents does the agency need?", prov("residency-agent"));
    const b = openQuestion(v, quest, "Is there a fee?", prov("residency-agent"));
    expect(openQuestion(v, quest, "which documents does the agency need", prov("campus-agent")).id).toBe(a.id);
    expect(answerQuestions(v, quest, [a.id, "q-unknown"], { agent: "residency-agent", at: "2026-09-21T10:00:00.000Z" })).toEqual([a.id]);
    expect(quest.fm.questions!.find((q) => q.id === a.id)).toMatchObject({ status: "answered", answered_by: "residency-agent" });
    openQuestion(v, quest, "When does the office open?", prov("residency-agent"));
    expect(quest.fm.questions!.map((q) => q.id)).toEqual([b.id, expect.stringMatching(/^q-/)]);
    openQuestion(v, quest, "Who signs the form?", prov("residency-agent"));
    expect(quest.fm.questions).toHaveLength(2);
    expect(v.warnings.some((w) => w.includes("open questions"))).toBe(true);
  });
});

describe("addGuideline", () => {
  it("starts an agent's guideline as a rumor and promotes it when a second source says it", async () => {
    const v = await load();
    const landlord = v.resolve("landlord")!;
    const g = addGuideline(v, landlord, { rule: "Write in Portuguese", scope: "Lang:PT" }, prov("home-finder"))!;
    expect(g).toMatchObject({ status: "rumor", scope: "lang:pt", seen_by: ["home-finder"] });
    addGuideline(v, landlord, { rule: "write in portuguese.", scope: "lang:pt" }, prov("home-finder"));
    expect(landlord.fm.guidelines![0]!.status).toBe("rumor");
    addGuideline(v, landlord, { rule: "Write in Portuguese", scope: "lang:pt" }, prov("job-scout", "2026-09-21T10:00:00.000Z", ["ep-2"]));
    expect(landlord.fm.guidelines).toHaveLength(1);
    expect(landlord.fm.guidelines![0]).toMatchObject({ status: "canon", src: ["ep-1", "ep-2"] });
    expect(landlord.fm.guidelines![0]!.seen_by).toBeUndefined();
    // Another scope is another guideline.
    addGuideline(v, landlord, { rule: "Write in Portuguese" }, prov("home-finder"));
    expect(landlord.fm.guidelines).toHaveLength(2);
  });

  it("makes the human's guideline canon at once, and drops the oldest rumor past the cap", async () => {
    const v = await load();
    const landlord = v.resolve("landlord")!;
    expect(addGuideline(v, landlord, { rule: "Never call before 10:00" }, prov("player"))).toMatchObject({ status: "canon", by: "player" });
    addGuideline(v, landlord, { rule: "Mention the boiler" }, prov("home-finder", "2026-09-10T10:00:00.000Z"));
    addGuideline(v, landlord, { rule: "Pay rent by transfer" }, prov("home-finder", "2026-09-12T10:00:00.000Z"));
    addGuideline(v, landlord, { rule: "Ask about the deposit" }, prov("home-finder", "2026-09-14T10:00:00.000Z"));
    expect(landlord.fm.guidelines!.map((g) => g.rule)).toEqual(["Never call before 10:00", "Pay rent by transfer", "Ask about the deposit"]);
    addGuideline(v, landlord, { rule: "Pay rent by transfer" }, prov("player"));
    addGuideline(v, landlord, { rule: "Ask about the deposit" }, prov("player"));
    expect(addGuideline(v, landlord, { rule: "Bring the keys" }, prov("player"))).toMatchObject({ status: "canon" });
    expect(landlord.fm.guidelines).toHaveLength(4);
    expect(v.warnings.some((w) => w.includes("guidelines_cap"))).toBe(true);
  });
});

describe("managed regions", () => {
  it("renders guidelines, decisions, questions and stats from frontmatter, and keeps human prose", async () => {
    const v = await load();
    const landlord = v.resolve("landlord")!;
    landlord.body += "\n## Guidelines\nBe brief.\nNo calls on Sundays.\n\n## Later\nnot a guideline\n";
    addGuideline(v, landlord, { rule: "Write in Portuguese", scope: "lang:pt" }, prov("player"));
    logDecision(v, landlord, { what: "Rent the Alfama flat", why: "near the agency", alternatives: ["Belém"] }, prov("home-finder"));
    const q = openQuestion(v, landlord, "Is the deposit refundable?", prov("home-finder"));
    applyStats(v, { at: "2026-09-20T10:00:00.000Z", about: [], data: { with: ["[[landlord]]"], channel: "call" } }, v.schema.kind("rollup").def, []);
    const raw = renderEntity(landlord);
    expect(raw).toContain("%% hippo:begin guidelines %%\n- Write in Portuguese _(lang:pt)_ · ✓ canon · [[player]]\n%% hippo:end guidelines %%");
    expect(raw).toContain("- **Rent the Alfama flat** — near the agency · [[home-finder]] · 2026-09-20\n  - instead of: Belém");
    expect(raw).toContain("- [ ] Is the deposit refundable? · [[home-finder]]");
    expect(raw).toContain("%% hippo:begin stats %%\n- first met 2026-09-20 · last contact 2026-09-20\n- rollup ×1 (last 2026-09-20)\n- rollup/call ×1 (last 2026-09-20)\n%% hippo:end stats %%");
    expect(raw).toContain("Met at the Harbor University open day.");
    expect(getHumanGuidelines(landlord)).toBe("Be brief.\nNo calls on Sundays.");

    const back = parseEntity(landlord.path, raw);
    expect(back.fm.guidelines).toEqual(landlord.fm.guidelines);
    expect(back.fm.decisions).toEqual(landlord.fm.decisions);
    expect(back.fm.questions).toEqual(landlord.fm.questions);
    expect(back.fm.stats).toEqual(landlord.fm.stats);

    answerQuestions(v, landlord, [q.id], { agent: "home-finder", at: "2026-09-22T10:00:00.000Z" });
    expect(renderEntity(landlord)).toContain("- [x] Is the deposit refundable? · [[home-finder]] — answered by [[home-finder]] 2026-09-22");
    landlord.fm.guidelines = [];
    landlord.fm.decisions = undefined;
    landlord.fm.questions = [];
    landlord.fm.stats = undefined;
    const bare = renderEntity(landlord);
    for (const region of ["guidelines", "decisions", "questions", "stats"]) expect(bare).not.toContain(`hippo:begin ${region}`);
    expect(bare).toContain("## Guidelines\nBe brief.");
  });

  it("reads a hand-written guideline as a bare string", () => {
    const e = parseEntity("characters/landlord.md", "---\ntype: character\nguidelines:\n  - Keep it short\n---\n");
    expect(e.fm.guidelines).toEqual([{ rule: "Keep it short", status: "canon", src: [] }]);
    expect(getHumanGuidelines(e)).toBe("");
  });
});
