import { HippoService, MemoryStore, buildVaultFiles, parseDoc } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { PRESETS, TEMPLATE } from "../../template/src/index.ts";
import { now } from "./__fixtures__/night.ts";
import { ScriptedLLM } from "./llm.ts";
import { sleep } from "./sleep.ts";

// One night per preset, on a vault built the way `hippo init --preset` builds it: each asserts what
// the preset is for, with the preset's own notes doing the work (no code knows their names).

const AGENT = "---\ntype: party\ntitle: Home Finder\nlane: housing and errands\nauthority: [housing]\n---\n";

async function vault(preset: string, notes: Record<string, string>): Promise<MemoryStore> {
  const files = await buildVaultFiles(TEMPLATE, { human: "player", timezone: "Europe/Lisbon", presets: [preset], presetFiles: PRESETS, now: now() });
  return new MemoryStore({ ...files, "party/home-finder.md": AGENT, ...notes });
}

/** An inbox episode by home-finder, with extra frontmatter lines. */
const episode = (at: string, kind: string, text: string, extra = "") => [`inbox/home-finder/${at.replace(/[-:]/g, "").slice(0, 15)}-${kind}.md`, `---\nagent: home-finder\nkind: ${kind}\nat: ${at}\n${extra}---\n${text}${text ? "\n" : ""}`] as const;

const fm = async (store: MemoryStore, path: string) => parseDoc((await store.read(path))!).data as Record<string, any>;
const noClaims = { facts: [], relations: [] };
const nothing = { entities: [] };
const summaries = (llm: ScriptedLLM) => llm.respond("summary", () => ({ summary: "A note." }));

describe("people preset", () => {
  const notes = {
    "characters/ana-souza.md": '---\ntype: character\ntitle: Ana Souza\nextends: "[[colleague]]"\nstats:\n  last_contact: 2026-08-01\n---\n\n## Notes\n',
    "characters/joao-silva.md": '---\ntype: character\ntitle: João Silva\nextends: "[[landlord]]"\n---\n\n## Notes\n',
  };

  it("counts a rollup without the model, briefs overdue contacts by archetype cadence, and proposes stakes", async () => {
    const store = await vault("people", notes);
    const rollup = episode("2026-09-27T10:00:00Z", "rollup", "", 'data:\n  with: "[[joao-silva]]"\n  channel: whatsapp\n  lang: pt\n  messages_in: 4\n  messages_out: 3\n  started_by: them\n');
    await store.write(...rollup);
    const quiet = new ScriptedLLM();
    const first = await sleep({ store, llm: quiet, now });

    // A rollup carries data only: stats, no model, nothing anyone said.
    expect(first.failed).toEqual([]);
    expect(quiet.calls).toEqual([]);
    expect((await fm(store, "characters/joao-silva.md")).stats).toMatchObject({ last_contact: "2026-09-27", counts: { rollup: 1, "rollup/whatsapp": 1 } });
    expect(await store.read("chronicle/2026/09/2026-09-27.md")).toContain("> whatsapp with [[joao-silva]] · pt · 4 · 3 · them");

    // Ana is a colleague: the archetype's 1m cadence (over the stranger's none) makes her overdue.
    // João is a landlord (cadence none): never overdue, however long it's been.
    const service = new HippoService(store, { now });
    const { overdue } = await service.briefing();
    expect(overdue.map((o) => [o.ref, o.cadence])).toEqual([["[[ana-souza]]", "1m"]]);
    const brief = await service.personBrief("ana-souza");
    expect(brief.guidelines.inherited.map((g) => g.source)).toEqual(["colleague", "colleague", "stranger", "stranger"]);

    // Stakes are the human's: an agent's suggestion becomes a proposal. A guideline can hold for one language.
    await store.write(...episode("2026-09-27T11:00:00Z", "observation", "For recruiters, the real stake is the relocation package.", "about: [recruiter]\n"));
    await store.write(...episode("2026-09-27T12:00:00Z", "moment", "Ana switched to Persian; she writes Finglish, casual and short.", 'about: [ana-souza]\ndata:\n  with: "[[ana-souza]]"\n  trigger: tone_shift\n'));
    const llm = summaries(
      new ScriptedLLM()
        .push("mentions", nothing, nothing)
        .push(
          "claims",
          { ...noClaims, facts: [{ entity: "recruiter", field: "stakes", value: "The relocation package", secret: false }] },
          { ...noClaims, guidelines: [{ entity: "ana-souza", rule: "Write in Finglish, casual and short", scope: "lang:fa" }] },
        ),
    );
    const second = await sleep({ store, llm, now });
    expect(second.failed).toEqual([]);
    expect(second.consolidated[0]!.proposals).toEqual(["recruiter.stakes"]);
    expect((await fm(store, "archetypes/recruiter.md")).facts.stakes.value).toBe("A job offer; salary and start date are the human's call.");
    expect(await fm(store, "disputes/proposal-recruiter-stakes.md")).toMatchObject({ kind: "proposal", state: "pending", field: "stakes" });
    const ana = await fm(store, "characters/ana-souza.md");
    expect(ana.guidelines).toEqual([expect.objectContaining({ rule: "Write in Finglish, casual and short", scope: "lang:fa", status: "rumor" })]);
    // The moment counts as contact, so Ana isn't overdue any more.
    expect(ana.stats).toMatchObject({ last_contact: "2026-09-27", counts: { moment: 1 } });
    expect((await new HippoService(store, { now }).briefing()).overdue).toEqual([]);
  });
});

describe("developer preset", () => {
  it("logs a decision on the repo it shapes, and stores used_by as its forward depends_on", async () => {
    const store = await vault("developer", {
      "repos/course-planner.md": "---\ntype: repo\ntitle: Course planner\n---\n\n## Notes\n",
      "services/enrollment-api.md": "---\ntype: service\ntitle: Enrollment API\n---\n\n## Notes\n",
      "services/export-job.md": "---\ntype: service\ntitle: Export job\n---\n\n## Notes\n",
    });
    const decision = "Use Postgres for the course planner instead of SQLite: several writers.";
    await store.write(...episode("2026-09-27T10:00:00Z", "decision", decision, "about: [course-planner]\ndata:\n  why: several services write at once\n  alternatives: [SQLite, MySQL]\n  revisit: 2027-03-01\n"));
    await store.write(...episode("2026-09-27T11:00:00Z", "incident", "The export job failed for an hour because the enrollment API was down.", 'about: [export-job, enrollment-api]\ndata:\n  service: "[[enrollment-api]]"\n  severity: high\n'));
    const llm = summaries(
      new ScriptedLLM()
        .push("mentions", nothing, nothing)
        .push("claims", noClaims, { facts: [], relations: [{ from: "enrollment-api", rel: "used_by", to: "export-job" }] }),
    );
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    const { decisions } = await fm(store, "repos/course-planner.md");
    expect(decisions).toEqual([expect.objectContaining({ what: decision, why: "several services write at once", alternatives: ["SQLite", "MySQL"], revisit: "2027-03-01", by: "home-finder" })]);
    expect(await store.read("repos/course-planner.md")).toContain("%% hippo:begin decisions %%");
    expect((await fm(store, "services/export-job.md")).relations).toEqual([expect.objectContaining({ rel: "depends_on", target: "[[enrollment-api]]" })]);
  });
});

describe("business preset", () => {
  it("turns a commitment into a deal with its client as counterparty and its due date, without the model", async () => {
    const store = await vault("business", { "clients/lisbon-shop.md": "---\ntype: client\ntitle: Lisbon shop\n---\n\n## Notes\n" });
    await store.write(...episode("2026-09-27T10:00:00Z", "commitment", "", 'data:\n  title: Send the website quote\n  counterparty: "[[lisbon-shop]]"\n  due: 2026-10-20\n'));
    const llm = new ScriptedLLM();
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(llm.calls).toEqual([]);
    expect(report.consolidated[0]!.created).toEqual(["send-the-website-quote"]);
    expect(await fm(store, "deals/send-the-website-quote.md")).toMatchObject({ type: "deal", status: "lead", counterparty: "[[lisbon-shop]]", due: "2026-10-20" });
    // A deal is a goal: the briefing and the client's brief see it.
    const brief = await new HippoService(store, { now }).personBrief("lisbon-shop");
    expect(brief.goals).toEqual([expect.objectContaining({ ref: "[[send-the-website-quote]]", role: "counterparty", state: "active", next_due: "2026-10-20" })]);
  });
});

describe("student preset", () => {
  it("rolls a weekly assignment over to next week once it's submitted", async () => {
    const store = await vault("student", {
      "courses/econ-101.md": "---\ntype: course\ntitle: Introduction to Economics\nfacts:\n  code: HU-ECO-101\n  credits: 6\n---\n\n## Notes\n",
      "assignments/econ-problem-set.md":
        '---\ntype: assignment\ntitle: Econ problem set\nstatus: assigned\ncounterparty: "[[econ-101]]"\ndue: 2026-09-28\nrepeat: { every: 1w }\n---\n%% hippo:begin objectives %%\n- [x] Read chapter 2\n%% hippo:end objectives %%\n\n## Notes\n',
    });
    await store.write(...episode("2026-09-27T10:00:00Z", "observation", "Submitted this week's Econ problem set.", "about: [econ-problem-set]\n"));
    const llm = summaries(new ScriptedLLM().push("mentions", nothing).push("claims", { ...noClaims, goals: [{ goal: "econ-problem-set", status: "submitted", completed: [], added: [] }] }));
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(await fm(store, "assignments/econ-problem-set.md")).toMatchObject({ status: "assigned", due: "2026-10-05", last_done: "2026-09-27" });
    expect(await store.read("assignments/econ-problem-set.md")).toContain("- [ ] Read chapter 2");
  });
});

describe("household preset", () => {
  it("brings a paid bill back with next month's due date", async () => {
    const store = await vault("household", {
      "bills/rent.md": "---\ntype: bill\ntitle: Rent\nstatus: unpaid\ndue: 2026-10-01\nrepeat: { every: 1m }\nfacts:\n  amount: 1200\n---\n\n## Notes\n",
    });
    await store.write(...episode("2026-09-27T10:00:00Z", "fact", "Paid October's rent.", "about: [rent]\n"));
    const llm = summaries(new ScriptedLLM().push("mentions", nothing).push("claims", { ...noClaims, goals: [{ goal: "rent", status: "paid", completed: [], added: [] }] }));
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(report.consolidated[0]!.goals[0]).toMatch(/^rent: status paid, last_done 2026-09-27, due 2026-11-01, status unpaid$/);
    expect(await fm(store, "bills/rent.md")).toMatchObject({ status: "unpaid", due: "2026-11-01" });
    const { upcoming } = await new HippoService(store, { now }).briefing({ horizonDays: 40 });
    expect(upcoming).toEqual(expect.arrayContaining([expect.objectContaining({ ref: "[[rent]]", date: "2026-11-01" })]));
  });
});
