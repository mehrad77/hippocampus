import { describe, expect, it } from "vitest";
import { managedStore } from "./__fixtures__/managed.ts";
import { GOAL_TYPE_NOTE, MIGRATED_QUEST, V2_CONFIG, fixtureStore } from "./__fixtures__/vault.ts";
import { auditChanges, overlayStore, type Actor } from "./audit.ts";
import { createIntroduction, renderIntroduction } from "./introduction.ts";
import { applyGoalUpdate } from "./goal.ts";
import { applyFact, applyRulings } from "./ops.ts";
import { generateKeyPair } from "./secrets.ts";
import type { Change } from "./store.ts";
import { Vault } from "./vault.ts";

const now = () => new Date("2026-09-27T21:00:00.000Z");
const curator: Actor = { kind: "curator" };
const agent = (id: string, scopes?: string[]): Actor => ({ kind: "agent", id, scopes });

const EPISODE = "inbox/residency-agent/2026-09-27T100000-agency.md";
const store = () =>
  fixtureStore({
    [EPISODE]: "---\nid: ep-agency\nagent: residency-agent\nat: 2026-09-27T10:00:00Z\n---\nAgency appointment booked for 2026-10-14.\n",
    "inbox/player/2026-09-27T110000-rent.md": "---\nid: ep-rent\nagent: player\nat: 2026-09-27T11:00:00Z\n---\nRent went up to 1300 EUR.\n",
    "locations/alfama-flat.md": "---\ntype: location\ntitle: Alfama flat\ntags: [housing]\nfacts:\n  rent: 1200 EUR\n---\n\n## Notes\nThe view is worth it.\n",
    "chronicle/2026/09/2026-09-20.md": "---\ntype: chronicle\ndate: 2026-09-20\n---\n# 2026-09-20\n\n> [!episode] 10:00 · [[campus-agent]] · fact\n> Enrolment opens.\n\n^ep-old\n",
  });
const note = (fm: string, body = "") => `---\n${fm}\n---\n${body}`;
const audit = async (changes: Change[], actor: Actor, forbidden?: string[], s = store()) => auditChanges({ before: s, changes, actor, forbidden });

describe("overlayStore", () => {
  it("reads and lists the store as it will be, and refuses writes", async () => {
    const s = store();
    const view = overlayStore(s, [{ path: "lore/visa.md", content: "x" }, { path: EPISODE, remove: true }, { path: "lore/visa.md", content: "y" }]);
    expect(await view.read("lore/visa.md")).toBe("y");
    expect(await view.read(EPISODE)).toBeUndefined();
    expect(await view.read("factions/migration-agency.md")).toBe(await s.read("factions/migration-agency.md"));
    expect(await view.list("inbox")).toEqual(["inbox/player/2026-09-27T110000-rent.md"]);
    expect(await view.list("lore")).toEqual(["lore/visa.md"]);
    await expect(view.write("x.md", "x")).rejects.toThrow(/read-only/);
    expect(await s.read("lore/visa.md")).toBeUndefined();
  });
});

describe("auditChanges", () => {
  it("lets the human and bootstrap change anything, except to write a forbidden value", async () => {
    const changes: Change[] = [
      { path: "_hippo/config.yaml", content: "campaign: lisbon-arc\n" },
      { path: "party/residency-agent.md", remove: true },
      { path: EPISODE, remove: true },
    ];
    expect(await audit(changes, { kind: "human" })).toEqual([]);
    expect(await audit(changes, { kind: "bootstrap" })).toEqual([]);
    expect(await audit([{ path: "lore/visa.md", content: "Permit U12345678" }], { kind: "human" }, ["U12345678", "ab"])).toEqual([{ path: "lore/visa.md", rule: "contains a secret value" }]);
  });

  it("counts only new occurrences of a forbidden value, and short ones only as whole tokens", async () => {
    const s = store();
    const review = "_hippo/review.md";
    await s.write(review, "Old reference U12345678.\n");
    expect(await audit([{ path: review, content: "Old reference U12345678.\nMore.\n" }], curator, ["U12345678"], s)).toEqual([]);
    // A CVV of 026 must not trip on every date in 2026, but does on its own.
    expect(await audit([{ path: review, content: "Due 2026-10-14.\n" }], curator, ["026"], s)).toEqual([]);
    expect(await audit([{ path: review, content: "CVV 026.\n" }], curator, ["026"], s)).toEqual([{ path: review, rule: "contains a secret value" }]);
    expect(await audit([{ path: "items/u12345678.md", content: note("type: item") }], curator, ["U12345678"])).toEqual([{ path: "items/u12345678.md", rule: "path contains a secret value" }]);
  });

  describe("agents", () => {
    const ep = (fm = "agent: residency-agent") => note(fm, "Biometric photos taken.\n");
    const NEW = "inbox/residency-agent/2026-09-28T090000-photos.md";

    it("may only add episodes to their own inbox folder, under their own name", async () => {
      expect(await audit([{ path: NEW, content: ep() }], agent("residency-agent"))).toEqual([]);
      expect(await audit([{ path: NEW, content: ep("kind: fact") }], agent("residency-agent"))).toEqual([]);
      expect(await audit([{ path: NEW, content: ep("agent: player") }], agent("residency-agent"))).toEqual([{ path: NEW, rule: "episode filed under another agent" }]);
      expect(await audit([{ path: "inbox/campus-agent/x.md", content: ep() }], agent("residency-agent"))).toEqual([{ path: "inbox/campus-agent/x.md", rule: "agents only add episodes to their own inbox folder" }]);
      expect(await audit([{ path: "inbox/residency-agent/sub/x.md", content: ep() }], agent("residency-agent"))).toHaveLength(1);
      expect(await audit([{ path: EPISODE, content: ep() }], agent("residency-agent"))).toEqual([{ path: EPISODE, rule: "agents may not modify this file" }]);
      expect(await audit([{ path: EPISODE, remove: true }], agent("residency-agent"))).toContainEqual({ path: EPISODE, rule: "agents may not remove this file" });
      expect(await audit([{ path: "lore/visa.md", content: note("type: lore") }], agent("residency-agent"))).toEqual([{ path: "lore/visa.md", rule: "agents only add episodes to their own inbox folder" }]);
      expect(await audit([{ path: NEW, content: ep() }], agent("residency-agent", ["read"]))).toHaveLength(1);
    });

    it("may replace their own introduction, and nobody else's", async () => {
      const OLD = "inbox/job-scout/_introduction-01aaa.md";
      const s = fixtureStore({ [OLD]: renderIntroduction({ agent: "job-scout", path: OLD, title: "Job Scout", at: "2026-09-26T10:00:00.000Z" }) });
      const v = await Vault.load(s, { now });
      v.addIntroduction(createIntroduction("inbox", "job-scout", { title: "Job Scout", lane: "Part-time work" }, now()));
      const changes = v.changes();
      expect(changes).toEqual([expect.objectContaining({ path: expect.stringMatching(/^inbox\/job-scout\/_introduction-/) }), { path: OLD, remove: true }]);
      expect(await auditChanges({ before: s, changes, actor: agent("job-scout") })).toEqual([]);
      expect(await auditChanges({ before: s, changes, actor: agent("job-scout", ["read"]) })).toHaveLength(2);
      expect(await audit([{ path: OLD, remove: true }], agent("campus-agent"), [], s)).toEqual([{ path: OLD, rule: "agents may not remove this file" }]);
      expect(await audit([{ path: OLD, remove: true }], curator, [], s)).toEqual([{ path: OLD, rule: "introductions are the human's to settle" }]);
      expect(await audit([{ path: OLD, remove: true }], { kind: "human" }, [], s)).toEqual([]);
    });

    it("are never the human or a reserved name", async () => {
      for (const id of ["player", "human", "curator", "Residency Agent"]) {
        expect(await audit([{ path: `inbox/${id}/x.md`, content: ep(`agent: ${id}`) }], agent(id))).toEqual([{ path: `inbox/${id}/x.md`, rule: "not an agent id" }]);
      }
    });

    it("edit quest notes and the handbook only with the quest scope", async () => {
      const s = store();
      const quest = (await s.read("quests/residence-permit.md"))!.replace("- [ ] Get health insurance", "- [x] Get health insurance");
      const changes: Change[] = [{ path: "quests/residence-permit.md", content: quest }, { path: "HANDBOOK.md", content: "# Handbook\n" }];
      expect(await audit(changes, agent("residency-agent", ["quest"]), [], s)).toEqual([]);
      expect(await audit(changes, agent("residency-agent"), [], s)).toEqual([]);
      expect(await audit(changes, agent("residency-agent", ["read", "remember"]), [], s)).toHaveLength(2);
      // A note in the quests folder that isn't a quest stays off limits.
      await s.write("quests/stray.md", note("type: lore"));
      expect(await audit([{ path: "quests/stray.md", content: note("type: lore\ntags: [residency]") }], agent("residency-agent", ["quest"]), [], s)).toEqual([
        { path: "quests/stray.md", rule: "agents may only edit goal notes" },
      ]);
    });
  });

  describe("the curator", () => {
    it("passes a real consolidation: canon, chronicle, secret, review, handbook, inbox cleanup", async () => {
      const { recipient } = await generateKeyPair();
      const s = store();
      await s.write("_hippo/config.yaml", `${(await s.read("_hippo/config.yaml"))!}secrets:\n  recipient: ${recipient}\n`);
      await s.write("items/passport.md", note("type: item\ntitle: Passport"));
      const v = await Vault.load(s, { now });
      const agency = v.resolve("migration-agency")!;
      const ep = v.episodes.find((e) => e.id === "ep-agency")!;
      await applyFact(v, agency, "appointment_date", "2026-10-14", { by: "residency-agent", at: ep.at, src: [ep.id] });
      await applyFact(v, v.resolve("passport")!, "number", "U12345678", { by: "residency-agent", at: ep.at, src: [ep.id] });
      await v.appendChronicle(ep, ["migration-agency"]);
      v.archiveEpisode(ep);
      v.writeFile("_hippo/review.md", "# Review\n");
      v.writeFile("HANDBOOK.md", "# Handbook\n");
      expect(await auditChanges({ before: s, changes: v.changes(), actor: curator, forbidden: ["U12345678"] })).toEqual([]);
    });

    it("stays out of config, house rules, CI, agent instructions, party notes and anywhere else", async () => {
      const paths = ["_hippo/config.yaml", "_hippo/curator.md", ".github/workflows/validate.yml", "AGENTS.md", "CLAUDE.md", "_hippo/schema/types/lore.md", "_hippo/schema/kinds/beat.md"];
      for (const path of paths) expect(await audit([{ path, content: "x" }], curator)).toEqual([{ path, rule: "protected file" }]);
      expect(await audit([{ path: "party/residency-agent.md", content: note("type: party\ntitle: Residency Agent") }], curator)).toContainEqual({ path: "party/residency-agent.md", rule: "party note" });
      expect(await audit([{ path: "notes/todo.md", content: "x" }], curator)).toEqual([{ path: "notes/todo.md", rule: "outside the curator's folders" }]);
      expect(await audit([{ path: "secrets/passport/number.txt", content: "x" }], curator)).toEqual([{ path: "secrets/passport/number.txt", rule: "outside the curator's folders" }]);
      expect(await audit([{ path: "chronicle/../_hippo/config.yaml", content: "x" }], curator)).toEqual([{ path: "chronicle/../_hippo/config.yaml", rule: "path not normalized" }]);
      expect(await audit([{ path: "inbox/residency-agent/new.md", content: "x" }], curator)).toEqual([{ path: "inbox/residency-agent/new.md", rule: "outside the curator's folders" }]);
    });

    it("never removes a note, only inbox episodes", async () => {
      expect(await audit([{ path: "locations/alfama-flat.md", remove: true }], curator)).toEqual([{ path: "locations/alfama-flat.md", rule: "entity note removed" }]);
      expect(await audit([{ path: "HANDBOOK.md", remove: true }], curator, [], fixtureStore({ "HANDBOOK.md": "x" }))).toEqual([{ path: "HANDBOOK.md", rule: "curator may only remove inbox files" }]);
    });

    it("never loses a memory: a removed episode must be cited in the chronicle", async () => {
      const day = "chronicle/2026/09/2026-09-27.md";
      expect(await audit([{ path: EPISODE, remove: true }], curator)).toEqual([{ path: EPISODE, rule: "removed episode not in the chronicle" }]);
      expect(await audit([{ path: EPISODE, remove: true }, { path: day, content: "# 2026-09-27\n\n> text\n\n^ep-agency\n" }], curator)).toEqual([]);
      expect(await audit([{ path: EPISODE, remove: true }, { path: day, content: "# 2026-09-27\n\n^ep-agency-2\n" }], curator)).toHaveLength(1);
      // Already chronicled by an earlier run that couldn't clean up.
      const s = store();
      await s.write(EPISODE, (await s.read(EPISODE))!.replace("ep-agency", "ep-old"));
      expect(await audit([{ path: EPISODE, remove: true }], curator, [], s)).toEqual([]);
    });

    it("keeps human prose, and the note's type and id", async () => {
      const s = store();
      const raw = (await s.read("locations/alfama-flat.md"))!;
      const ok = raw.replace("---\n\n## Notes", "---\n%% hippo:begin summary %%\nA flat in Alfama.\n%% hippo:end summary %%\n\n\n## Notes");
      expect(await audit([{ path: "locations/alfama-flat.md", content: ok }], curator, [], s)).toEqual([]);
      const rule = async (content: string) => (await audit([{ path: "locations/alfama-flat.md", content }], curator, [], s)).map((v) => v.rule);
      expect(await rule(raw.replace("The view is worth it.", "The view is fine."))).toEqual(["human prose changed"]);
      expect(await rule(raw.replace("type: location", "type: faction"))).toEqual(["entity type changed"]);
      expect(await rule(raw.replace("type: location", "type: location\nid: flat-1"))).toEqual(["entity id changed"]);
    });

    it("keeps the human's facts unless the human ruled or said otherwise", async () => {
      const s = store();
      const raw = (await s.read("locations/alfama-flat.md"))!;
      const rent = (fact: string) => raw.replace("  rent: 1200 EUR", fact);
      const rules = async (changes: Change[]) => (await audit(changes, curator, [], s)).map((v) => `${v.path}: ${v.rule}`);
      const flat = (fact: string): Change => ({ path: "locations/alfama-flat.md", content: rent(fact) });

      expect(await rules([flat("  rent:\n    value: 1400 EUR\n    status: canon\n    by: home-finder")])).toEqual(["locations/alfama-flat.md: human fact changed: rent"]);
      expect(await rules([flat("  other: x")])).toEqual(["locations/alfama-flat.md: human fact changed: rent"]);
      // An agent disagreeing only opens a dispute: same value, status disputed.
      expect(await rules([flat("  rent:\n    value: 1200 EUR\n    status: disputed")])).toEqual([]);
      // The human's own episode, consolidated in the same change set.
      const fromHuman = flat("  rent:\n    value: 1300 EUR\n    status: canon\n    by: player\n    src: [ep-rent]");
      const chronicled: Change = { path: "chronicle/2026/09/2026-09-27.md", content: "^ep-rent\n" };
      expect(await rules([fromHuman, { path: "inbox/player/2026-09-27T110000-rent.md", remove: true }, chronicled])).toEqual([]);
      expect(await rules([fromHuman])).toEqual(["locations/alfama-flat.md: human fact changed: rent"]);
    });

    it("accepts a human ruling applied in the same change set, and only that", async () => {
      const s = store();
      await s.write(
        "disputes/dispute-alfama-flat-rent.md",
        note("type: dispute\nentity: \"[[alfama-flat]]\"\nfield: rent\nstatus: open\nruling: 1250 EUR\nclaims:\n  - value: 1200 EUR\n  - value: 1250 EUR\n    by: home-finder"),
      );
      const v = await Vault.load(s, { now });
      expect(applyRulings(v)).toEqual(["alfama-flat.rent = 1250 EUR"]);
      const changes = v.changes();
      expect(await auditChanges({ before: s, changes, actor: curator })).toEqual([]);
      // Without the ruling written by the human, resolving the dispute doesn't license the change.
      await s.write("disputes/dispute-alfama-flat-rent.md", (await s.read("disputes/dispute-alfama-flat-rent.md"))!.replace("ruling: 1250 EUR\n", ""));
      expect(await auditChanges({ before: s, changes, actor: curator })).toEqual([{ path: "locations/alfama-flat.md", rule: "human fact changed: rent" }]);
    });

    it("keeps the ciphertext of a human-held secret unless the human's own episode says otherwise", async () => {
      const age = (body: string) => ({ path: "secrets/passport/number.age", content: `-----BEGIN AGE ENCRYPTED FILE-----\n${body}\n-----END AGE ENCRYPTED FILE-----\n` });
      const held = (by: string, src = "[]") => note(`type: item\ntitle: Passport\nfacts:\n  number:\n    value: secret://passport/number\n    by: ${by}\n    src: ${src}`);
      const s = fixtureStore({ "items/passport.md": held("player"), [age("old").path]: age("old").content });
      const changed = { path: "items/passport.md", content: held("player", "[ep-new]") };
      // The note's ref is unchanged, so only the ciphertext change reveals the overwrite.
      expect(await audit([age("new")], curator, [], s)).toEqual([{ path: age("new").path, rule: "human secret changed: number" }]);
      expect(await audit([age("new"), { ...changed, content: held("residency-agent", "[ep-new]") }], curator, [], s)).toContainEqual({ path: age("new").path, rule: "human secret changed: number" });
      // An agent's own secret can be replaced by the curator as before.
      const agents = fixtureStore({ "items/passport.md": held("residency-agent"), [age("old").path]: age("old").content });
      expect(await audit([age("new")], curator, [], agents)).toEqual([]);
    });

    it("writes secret fields only as secret:// refs backed by age files", async () => {
      const passport = (fact: string) => ({ path: "items/passport.md", content: note(`type: item\ntitle: Passport\nfacts:\n${fact}`) });
      const ref = "  number:\n    value: secret://passport/number\n    by: residency-agent";
      const age = { path: "secrets/passport/number.age", content: "-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n" };
      expect(await audit([passport("  number: U12345678")], curator)).toEqual([{ path: "items/passport.md", rule: "plaintext secret: number" }]);
      expect(await audit([passport(ref)], curator)).toEqual([{ path: "items/passport.md", rule: "missing secret file: number" }]);
      expect(await audit([passport(ref), age], curator)).toEqual([]);
      expect(await audit([{ ...age, content: "U12345678" }], curator)).toEqual([{ path: age.path, rule: "secret file is not age ciphertext" }]);
      // A field that already holds a ref stays secret even without secret_fields.
      const s = fixtureStore({ "lore/visa.md": note("type: lore\nfacts:\n  pin:\n    value: secret://visa/pin\n    by: residency-agent") });
      expect(await audit([{ path: "lore/visa.md", content: note("type: lore\nfacts:\n  pin: 4321") }], curator, [], s)).toEqual([{ path: "lore/visa.md", rule: "plaintext secret: pin" }]);
    });
  });
});

describe("auditChanges: goal edits by agents", () => {
  const QUEST = "quests/residence-permit.md";
  const edit = async (fn: (raw: string) => string, scopes = ["read", "goal"]) => {
    const s = store();
    return audit([{ path: QUEST, content: fn((await s.read(QUEST))!) }], agent("residency-agent", scopes), [], s);
  };

  it("may change goal props, objectives and the progress line, with the goal or quest scope", async () => {
    const s = store();
    const v = await Vault.load(s, { now });
    applyGoalUpdate(v, v.resolve("residence-permit")!, { status: "blocked", complete: ["insurance"], progress: { total: 3, tick: 1 }, due: "2026-12-01", counterparty: "migration-agency", repeat: { every: "1y" } }, "residency-agent");
    const changes = v.changes();
    expect(changes.map((c) => c.path)).toEqual([QUEST]);
    expect(await audit(changes, agent("residency-agent", ["read", "goal"]), [], s)).toEqual([]);
    expect(await audit(changes, agent("residency-agent", ["read", "quest"]), [], s)).toEqual([]);
    expect(await audit(changes, agent("residency-agent", ["read", "remember"]), [], s)).toEqual([{ path: QUEST, rule: "agents may not modify this file" }]);
  });

  it("may not touch a goal's facts, relations, names, tags or summary", async () => {
    const rules = async (fn: (raw: string) => string) => (await edit(fn)).map((v) => v.rule);
    expect(await rules((r) => r.replace("tags: [residency]", "tags: [residency]\nfacts:\n  fee: 80 EUR"))).toEqual(["agents may only change goal props: facts"]);
    expect(await rules((r) => r.replace("tags: [residency]", "tags: [residency]\nrelations:\n  - { rel: requires, target: \"[[migration-agency]]\" }"))).toEqual([
      "agents may only change goal props: relations",
    ]);
    expect(await rules((r) => r.replace("title: Residence permit 2026", "title: Permit"))).toEqual(["agents may only change goal props: title"]);
    expect(await rules((r) => r.replace("tags: [residency]", "tags: [residency, housing]"))).toEqual(["agents may only change goal props: tags"]);
    expect(await rules((r) => r.replace("deadline: 2026-11-30", "deadline: 2026-11-30\ncadence: 2w"))).toEqual(["agents may only change goal props: cadence"]);
    expect(await rules((r) => `${r}\n%% hippo:begin summary %%\nThe permit.\n%% hippo:end summary %%\n`)).toEqual(["agents may only change goal props: summary"]);
    expect(await rules((r) => `${r}\nMy own words.\n`)).toEqual(["human prose changed"]);
    expect(await rules((r) => r.replace("deadline: 2026-11-30", "due: 2026-12-01\nprogress: { done: 1, total: 2 }\nupdated_by: residency-agent"))).toEqual([]);
  });
});

describe("auditChanges: confidential values", () => {
  const LANDLORD = "characters/landlord.md";
  const EMAIL = "landlord@lisbon.example";
  const DAY = "chronicle/2026/09/2026-09-27.md";
  const withSummary = (raw: string, text: string) => raw.replace("---\n\n## Notes", `---\n%% hippo:begin summary %%\n${text}\n%% hippo:end summary %%\n\n## Notes`);

  it("stay out of summaries, titles, aliases and the chronicle", async () => {
    const s = managedStore();
    const raw = (await s.read(LANDLORD))!;
    const rules = async (changes: Change[]) => (await audit(changes, curator, [], s)).map((v) => `${v.path}: ${v.rule}`);
    expect(await rules([{ path: LANDLORD, content: withSummary(raw, "The landlord of the Alfama flat.") }])).toEqual([]);
    expect(await rules([{ path: LANDLORD, content: withSummary(raw, `Reach the landlord at ${EMAIL}.`) }])).toEqual([`${LANDLORD}: confidential value in a summary`]);
    expect(await rules([{ path: LANDLORD, content: raw.replace("tags: [colleague]", `tags: [colleague]\naliases: [${EMAIL}]`) }])).toEqual([
      `${LANDLORD}: confidential value in a title or alias`,
    ]);
    const touched: Change = { path: LANDLORD, content: raw.replace("tags: [colleague]", "tags: [colleague, housing]") };
    expect(await rules([touched, { path: DAY, content: `# 2026-09-27\n\n> Wrote to ${EMAIL}.\n\n^ep-x\n` }])).toEqual([`${DAY}: confidential value in the chronicle`]);
    expect(await rules([touched, { path: DAY, content: "# 2026-09-27\n\n> Wrote to the landlord.\n\n^ep-x\n" }])).toEqual([]);
  });

  it("count a fact marked confidential, and only new occurrences", async () => {
    const note = "---\ntype: character\ntitle: Ana\nfacts:\n  salary: { value: 4200 EUR, status: canon, confidential: true }\n---\n%% hippo:begin summary %%\nEarns 4200 EUR.\n%% hippo:end summary %%\n\n## Notes\n";
    const s = managedStore({ "characters/ana.md": note });
    expect(await audit([{ path: "characters/ana.md", content: note.replace("Earns 4200 EUR.", "Earns 4200 EUR, works at Harbor University.") }], curator, [], s)).toEqual([]);
    expect(await audit([{ path: "characters/ana.md", content: note.replace("Earns 4200 EUR.", "Earns 4200 EUR; 4200 EUR a month.") }], curator, [], s)).toEqual([
      { path: "characters/ana.md", rule: "confidential value in a summary" },
    ]);
  });

  it("keep a confidential episode's text out of the chronicle", async () => {
    const EP = "inbox/home-finder/2026-09-27T100000-offer.md";
    const s = managedStore({ [EP]: "---\nid: ep-offer\nagent: home-finder\nat: 2026-09-27T10:00:00Z\nconfidential: true\n---\nThe owner would drop the rent to 900 EUR for a two-year lease.\n" });
    const day = (text: string): Change => ({ path: DAY, content: `# 2026-09-27\n\n> [!episode] 10:00 · [[home-finder]] · observation\n> ${text}\n\n^ep-offer\n` });
    expect(await audit([{ path: EP, remove: true }, day("(confidential)")], curator, [], s)).toEqual([]);
    expect(await audit([{ path: EP, remove: true }, day("The owner would drop the rent to 900 EUR for a two-year lease.")], curator, [], s)).toEqual([
      { path: DAY, rule: "confidential episode in the chronicle" },
    ]);
  });
});

describe("auditChanges: a migration", () => {
  const migration: Actor = { kind: "migration" };
  /** The v1 fixture moved to v2: config, a goal type note, the quest under goals/, scaffolding. */
  const migrated = (): Change[] => [
    { path: "_hippo/config.yaml", content: V2_CONFIG },
    { path: "_hippo/schema/types/goal.md", content: GOAL_TYPE_NOTE },
    { path: "_hippo/templates/goal.md", content: "---\ntype: goal\ntitle: \"{{title}}\"\n---\n" },
    { path: "_hippo/dashboards/goal-board.md", content: "# Goals\n" },
    { path: "HANDBOOK.md", content: "# Handbook\n" },
    { path: "goals/.gitkeep", content: "" },
    { path: "quests/residence-permit.md", remove: true },
    { path: "goals/residence-permit.md", content: MIGRATED_QUEST },
  ];
  const rules = async (changes: Change[], s = store()) => (await audit(changes, migration, [], s)).map((v) => `${v.path}: ${v.rule}`);

  it("may reshape config, schema, scaffolding and notes, keeping their memory", async () => {
    expect(await rules(migrated())).toEqual([]);
    // Rewritten in place (a type change without a move) is fine too.
    expect(await rules([{ path: "quests/residence-permit.md", content: MIGRATED_QUEST }])).toEqual([]);
  });

  it("never touches the inbox, chronicle, disputes, secrets, CI or guardrails", async () => {
    const s = store();
    await s.write("disputes/dispute-x.md", "x");
    await s.write("secrets/passport/number.age", "x");
    await s.write("_hippo/curator.md", "x");
    for (const path of [EPISODE, "chronicle/2026/09/2026-09-20.md", "disputes/dispute-x.md", "secrets/passport/number.age", ".github/workflows/validate.yml", "AGENTS.md", "CLAUDE.md", "_hippo/curator.md", "notes.md"]) {
      expect(await rules([{ path, content: "changed" }], s)).toEqual([`${path}: a migration may not change this file`]);
    }
    expect(await rules([{ path: EPISODE, remove: true }], s)).toEqual([`${EPISODE}: a migration may not change this file`]);
    const tpl = fixtureStore({ "_hippo/templates/quest.md": "x" });
    expect(await rules([{ path: "_hippo/templates/quest.md", remove: true }], tpl)).toEqual(["_hippo/templates/quest.md: a migration may not remove this file"]);
  });

  it("moves notes under the same name, never drops or invents one", async () => {
    const without = migrated().filter((c) => c.path !== "goals/residence-permit.md");
    expect(await rules(without)).toEqual(["quests/residence-permit.md: note removed by a migration"]);
    expect(await rules([...migrated(), { path: "goals/new-goal.md", content: MIGRATED_QUEST }])).toEqual(["goals/new-goal.md: note added by a migration"]);
    expect(await rules([...migrated().filter((c) => c.path !== "goals/residence-permit.md"), { path: "goals/permit.md", content: MIGRATED_QUEST }])).toEqual([
      "quests/residence-permit.md: note removed by a migration",
      "goals/permit.md: note added by a migration",
    ]);
  });

  it("keeps each note's prose, facts, relations, id, names and summary", async () => {
    const moved = (content: string) => [...migrated().filter((c) => c.path !== "goals/residence-permit.md"), { path: "goals/residence-permit.md", content }];
    const tweak = async (from: string, to: string) => rules(moved(MIGRATED_QUEST.replace(from, to)));
    expect(await tweak("%% hippo:end progress %%\n", "%% hippo:end progress %%\n\nNew prose.\n")).toEqual(["goals/residence-permit.md: human prose changed"]);
    expect(await tweak("tags: [residency]", "tags: [residency]\nfacts:\n  fee: 80 EUR")).toEqual(["goals/residence-permit.md: facts changed"]);
    expect(await tweak("tags: [residency]", "tags: [residency]\nrelations:\n  - { rel: requires, target: \"[[lisbon]]\" }")).toEqual(["goals/residence-permit.md: relations changed"]);
    expect(await tweak("type: goal", "type: goal\nid: permit-1")).toEqual(["goals/residence-permit.md: entity id changed"]);
    expect(await tweak("title: Residence permit 2026", "title: Permit")).toEqual(["goals/residence-permit.md: frontmatter changed: title"]);
    expect(await tweak("%% hippo:end progress %%\n", "%% hippo:end progress %%\n\n%% hippo:begin summary %%\nNew.\n%% hippo:end summary %%\n")).toEqual([
      "goals/residence-permit.md: summary changed",
    ]);
    // Goal props are the migration's to convert.
    expect(await tweak("status: active", "status: active\nprogress: { done: 0, total: 2 }")).toEqual([]);
    // Facts compare by meaning, not by how they're written.
    const s = store();
    await s.write("locations/alfama-flat.md", "---\ntype: location\ntitle: Alfama flat\nfacts:\n  rent: 1200 EUR\n---\n");
    expect(await rules([{ path: "locations/alfama-flat.md", content: "---\ntype: location\ntitle: Alfama flat\nfacts:\n  rent:\n    value: 1200 EUR\n    status: canon\n---\n" }], s)).toEqual([]);
  });

  it("is an actor of its own: the curator may not do what a migration does", async () => {
    expect(await audit(migrated(), curator)).toContainEqual({ path: "_hippo/config.yaml", rule: "protected file" });
  });
});
