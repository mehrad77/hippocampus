import { describe, expect, it } from "vitest";
import { managedStore } from "./__fixtures__/managed.ts";
import { fixtureStore } from "./__fixtures__/vault.ts";
import { applyFact, applyRulings } from "./ops.ts";
import { parseDoc } from "./markdown.ts";
import { HippoService } from "./service.ts";
import { Vault, VaultError } from "./vault.ts";
import { decryptSecret, generateKeyPair } from "./secrets.ts";
import type { MemoryStore, VaultStore } from "./store.ts";

const now = () => new Date("2026-09-27T12:00:00.000Z");

/** `store` with an atomic `apply` that records each commit message. */
function recording(store: MemoryStore): { store: VaultStore; messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    store: {
      list: (prefix) => store.list(prefix),
      read: (path) => store.read(path),
      write: (path, content) => store.write(path, content),
      remove: (path) => store.remove(path),
      async apply(changes, meta) {
        messages.push(meta.message);
        for (const c of changes) await ("remove" in c ? store.remove(c.path) : store.write(c.path, c.content));
      },
    },
  };
}

describe("Vault", () => {
  it("resolves by slug, link, title and folded alias", async () => {
    const v = await Vault.load(fixtureStore(), { now });
    expect(v.resolve("[[migration-agency]]")?.slug).toBe("migration-agency");
    expect(v.resolve("Agência de Migração")?.slug).toBe("migration-agency");
    expect(v.resolve("lisbon migration")?.slug).toBe("migration-agency");
    expect(v.resolve("campus")?.slug).toBe("campus-agent");
    expect(v.warnings).toEqual([]);
  });

  it("computes lane authority from entity tags", async () => {
    const v = await Vault.load(fixtureStore(), { now });
    const agency = v.resolve("migration-agency")!;
    expect(v.authorityOf("residency-agent", agency)).toBe("authority");
    expect(v.authorityOf("campus-agent", agency)).toBe("none");
    expect(v.authorityOf("player", agency)).toBe("human");
  });

  it("grants authority to an agent's exact slug only, never its title or alias", async () => {
    const v = await Vault.load(fixtureStore({ "lore/enrolment.md": "---\ntype: lore\ntitle: Enrolment\ntags: [university]\n---\n" }), { now });
    const enrolment = v.resolve("enrolment")!;
    expect(v.authorityOf("campus-agent", enrolment)).toBe("authority");
    expect(v.authorityOf("campus", enrolment)).toBe("none");
    expect(v.authorityOf("Campus Agent", enrolment)).toBe("none");
    expect(v.partyMember("campus-agent")?.slug).toBe("campus-agent");
    expect(v.partyMember("campus")).toBeUndefined();
    expect(v.partyMember("migration-agency")).toBeUndefined();
  });

  it("loads introductions apart from episodes, and warns about broken ones", async () => {
    const intro = (agent: string) => `---\ntype: introduction\nagent: ${agent}\ntitle: Job Scout\nat: 2026-09-26T10:00:00.000Z\n---\nI watch job boards.\n`;
    const v = await Vault.load(
      fixtureStore({
        "inbox/job-scout/_introduction-01aaa.md": intro("job-scout"),
        "inbox/job-scout/_introduction-01bbb.md": "---\ntype: introduction\nagent: job-scout\n---\n",
        "inbox/archivist/_introduction-01ccc.md": intro("job-scout"),
        "inbox/archivist/_notes.md": "---\nagent: archivist\n---\nScratch.\n",
      }),
      { now },
    );
    expect(v.episodes).toEqual([]);
    expect(v.introductions).toEqual([{ agent: "job-scout", path: "inbox/job-scout/_introduction-01aaa.md", title: "Job Scout", at: "2026-09-26T10:00:00.000Z", about: "I watch job boards." }]);
    expect(v.introductionOf("job-scout")?.path).toBe("inbox/job-scout/_introduction-01aaa.md");
    expect(v.warnings).toEqual([
      expect.stringMatching(/^skipped introduction inbox\/archivist\/_introduction-01ccc\.md: agent "job-scout" doesn't match its folder/),
      expect.stringMatching(/^skipped introduction inbox\/job-scout\/_introduction-01bbb\.md: /),
    ]);
  });

  it("restores a snapshot, so a failed step leaves nothing behind", async () => {
    const store = fixtureStore({ "inbox/campus-agent/2026-09-27T100000-enrol.md": "---\nagent: campus-agent\n---\nEnrolment opens 2026-10-01.\n" });
    const v = await Vault.load(store, { now });
    const snap = v.snapshot();
    const agency = v.resolve("migration-agency")!;
    v.addAliases(agency, ["Harbor Desk"]);
    await applyFact(v, agency, "phone", "+351 900 000 002", { by: "residency-agent", at: "2026-09-10T00:00:00Z", src: ["ep-a"] });
    v.createEntity({ type: "location", title: "Harbor University Annex", by: "campus-agent" });
    v.warnings.push("something went wrong");
    v.archiveEpisode(v.episodes[0]!);

    v.restore(snap);
    expect(v.hasChanges()).toBe(false);
    expect(v.warnings).toEqual([]);
    expect(v.episodes).toHaveLength(1);
    expect(v.resolve("Harbor Desk")).toBeUndefined();
    expect(v.resolve("harbor-university-annex")).toBeUndefined();
    expect(v.resolve("migration-agency")!.fm.facts).toEqual({});
    // The snapshot is still intact for another rollback, and the restored state is live, not shared.
    v.resolve("migration-agency")!.fm.aliases.push("Mutated");
    v.restore(snap);
    expect(v.resolve("migration-agency")!.fm.aliases).toEqual(["Lisbon Migration", "LMA"]);
    await v.flush();
    expect(await store.list("locations")).toEqual([]);
    expect(await store.list("inbox")).toHaveLength(1);
  });

  it("writes facts without touching human prose and opens disputes", async () => {
    const store = fixtureStore();
    const v = await Vault.load(store, { now });
    const agency = v.resolve("migration-agency")!;
    await applyFact(v, agency, "office address", "Alfama", { by: "campus-agent", at: "2026-09-10T00:00:00Z", src: ["ep-a"] });
    await applyFact(v, agency, "office_address", "Belém", { by: "home-finder", at: "2026-09-11T00:00:00Z", src: ["ep-b"] });
    await v.flush();

    const raw = (await store.read("factions/migration-agency.md"))!;
    expect(raw).toContain("## Notes\nHuman prose that must survive.\n");
    const fm = parseDoc(raw).data as { facts: Record<string, { status: string }> };
    expect(fm.facts.office_address?.status).toBe("disputed");
    const dispute = (await store.read("disputes/dispute-migration-agency-office-address.md"))!;
    expect(dispute).toContain("status: open");

    // Human ruling in the dispute note becomes canon on the next pass.
    await store.write("disputes/dispute-migration-agency-office-address.md", dispute.replace("status: open", "status: open\nruling: Alfama"));
    const v2 = await Vault.load(store, { now });
    expect(applyRulings(v2)).toEqual(["migration-agency.office_address = Alfama"]);
    await v2.flush();
    const fm2 = parseDoc((await store.read("factions/migration-agency.md"))!).data as { facts: Record<string, { status: string; value: string; by: string }> };
    expect(fm2.facts.office_address).toMatchObject({ value: "Alfama", status: "canon", by: "player" });
    expect(await store.read("disputes/dispute-migration-agency-office-address.md")).toContain("status: resolved");
  });

  it("encrypts secret fields with only the public recipient", async () => {
    const { identity, recipient } = await generateKeyPair();
    const store = fixtureStore({ "items/passport.md": "---\ntype: item\ntitle: Passport\ntags: [residency]\n---\n" });
    await store.write("_hippo/config.yaml", `${(await store.read("_hippo/config.yaml"))!}secrets:\n  recipient: ${recipient}\n`);
    const v = await Vault.load(store, { now });
    const passport = v.resolve("passport")!;
    await applyFact(v, passport, "number", "U12345678", { by: "residency-agent", at: "2026-09-10T00:00:00Z", src: ["ep-a"] });
    await v.flush();
    const note = (await store.read("items/passport.md"))!;
    expect(note).not.toContain("U12345678");
    expect(note).toContain("secret://passport/number");
    expect(await decryptSecret(identity, (await store.read("secrets/passport/number.age"))!)).toBe("U12345678");
  });
});

describe("secret facts and authority", () => {
  it("never lets a lower-ranked source replace a higher-ranked one's secret", async () => {
    const { identity, recipient } = await generateKeyPair();
    const store = fixtureStore({ "items/passport.md": "---\ntype: item\ntitle: Passport\ntags: [residency]\n---\n" });
    await store.write("_hippo/config.yaml", `${(await store.read("_hippo/config.yaml"))!}secrets:\n  recipient: ${recipient}\n`);
    const v = await Vault.load(store, { now });
    const passport = v.resolve("passport")!;
    // The human's value first, then an agent without authority over the passport's tags.
    await applyFact(v, passport, "number", "U12345678", { by: "player", at: "2026-09-10T00:00:00Z", src: ["ep-a"] });
    const r = await applyFact(v, passport, "number", "X99999999", { by: "campus-agent", at: "2026-09-11T00:00:00Z", src: ["ep-b"] });
    await v.flush();
    expect(r.decision).toBe("keep");
    expect(v.warnings.join(" ")).toContain("not replaced");
    expect(await decryptSecret(identity, (await store.read("secrets/passport/number.age"))!)).toBe("U12345678");
    // An equal-ranked source still replaces it (last writer wins among equals).
    await applyFact(v, passport, "number", "U87654321", { by: "player", at: "2026-09-12T00:00:00Z", src: ["ep-c"] });
    await v.flush();
    expect(await decryptSecret(identity, (await store.read("secrets/passport/number.age"))!)).toBe("U87654321");
  });
});

describe("HippoService", () => {
  it("remember → recall shows pending episodes (read-your-writes)", async () => {
    const svc = new HippoService(fixtureStore(), { now });
    const { path } = await svc.remember("residency-agent", { text: "agency appointment booked for 2026-10-14 at Alfama", kind: "fact", about: ["[[migration-agency]]"] });
    expect(path).toMatch(/^inbox\/residency-agent\/2026-09-27T120000-\w{6}\.md$/);
    const r = await svc.recall("agency appointment");
    expect(r.entities[0]?.ref).toBe("[[migration-agency]]");
    expect(r.pending[0]?.text).toContain("2026-10-14");
  });

  it("files episodes under an agent's exact id, never the human's or a reserved one", async () => {
    const store = fixtureStore();
    const svc = new HippoService(store, { now });
    for (const agent of ["player", "Player", "human", "curator", "unknown", "hippocampus", "Residency Agent", "../player", ""]) {
      await expect(svc.remember(agent, { text: "The agency moved to Alfama." }), agent).rejects.toThrow(VaultError);
    }
    expect(await store.list("inbox")).toEqual([]);
    // An agent outside the party may still file (its word counts as rumor).
    expect((await svc.remember(" Job-Scout ", { text: "Harbor Cafe is hiring." })).path).toMatch(/^inbox\/job-scout\//);
    // The human's own memories come through `asHuman`, whatever id the caller passed.
    expect((await svc.remember("", { text: "I prefer morning appointments." }, { asHuman: true })).path).toMatch(/^inbox\/player\//);
  });

  it("caps a memory at 8 KB of UTF-8", async () => {
    const svc = new HippoService(fixtureStore(), { now });
    await expect(svc.remember("residency-agent", { text: "ã".repeat(4097) })).rejects.toThrow(/8194 bytes.*8192/);
    expect((await svc.remember("residency-agent", { text: "a".repeat(8192) })).id).toMatch(/^ep-/);
  });

  it("updates quests as an agent or, with asHuman, as the human", async () => {
    const store = fixtureStore();
    const svc = new HippoService(store, { now });
    await expect(svc.updateQuest("Player", "residence-permit", { complete: ["health insurance"] })).rejects.toThrow(/is the human/);
    expect(await store.read("goals/residence-permit.md")).not.toContain("- [x]");
    await svc.updateQuest("residency-agent", "residence-permit", { complete: ["health insurance"] }, { asHuman: true });
    expect(await store.read("goals/residence-permit.md")).toContain("updated_by: player");
  });

  it("refuses reserved ids as party members", async () => {
    const svc = new HippoService(fixtureStore(), { now });
    await expect(svc.addPartyMember({ id: "curator", title: "Curator" })).rejects.toThrow(/reserved/);
    await expect(svc.addPartyMember({ id: "Player", title: "Me" })).rejects.toThrow(/is the human/);
  });

  it("onboard includes lane and owned quests", async () => {
    const text = await new HippoService(fixtureStore(), { now }).onboard("residency-agent");
    expect(text).toContain("You are Residency Agent");
    expect(text).toContain("[[residence-permit]]");
    expect(text).toContain("inbox/<agent-id>/");
  });

  it("onboard tells an outsider how to introduce itself, and the human it isn't an agent", async () => {
    const svc = new HippoService(fixtureStore(), { now });
    const stranger = await svc.onboard("job-scout");
    expect(stranger).toContain("# Unknown agent `job-scout`");
    expect(stranger).toContain('introduce({ agent: "job-scout", title: "Job Scout", lane: ');
    // Party membership is the exact id: an alias is an outsider.
    expect(await svc.onboard("campus")).toContain("# Unknown agent `campus`");
    expect(await svc.onboard("player")).toContain('"player" is the human, not an agent');
  });

  it("introduce files one pending introduction per agent; approving seats it with the human's choices", async () => {
    const store = fixtureStore();
    const svc = new HippoService(store, { now });
    const first = await svc.introduce("Job-Scout", { title: "Job Scout", lane: "Finds part-time work", model: "local-model" });
    expect(first).toMatchObject({ status: "pending", agent: "job-scout", path: expect.stringMatching(/^inbox\/job-scout\/_introduction-\w+\.md$/) });
    const second = await svc.introduce("job-scout", { title: "Job  Scout\n", lane: "Finds part-time work in Lisbon", host: "Claude Desktop", about: "I watch job boards.\nI never apply on my own." });
    expect(await store.list("inbox/job-scout")).toEqual([second.path]);
    expect(await svc.onboard("job-scout")).toContain("Your introduction is waiting for player's approval");
    const v = await svc.vault();
    expect(v.episodes).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect((await svc.overview()).attention.introductions).toEqual([
      { agent: "job-scout", title: "Job Scout", lane: "Finds part-time work in Lisbon", host: "Claude Desktop", at: "2026-09-27T12:00:00.000Z", about: "I watch job boards.\nI never apply on my own." },
    ]);

    expect(await svc.approveIntroduction("job-scout", { authority: ["career"], title: "Scout" })).toEqual({ slug: "job-scout", path: "party/job-scout.md" });
    expect(parseDoc((await store.read("party/job-scout.md"))!).data).toMatchObject({ type: "party", title: "Scout", lane: "Finds part-time work in Lisbon", authority: ["career"], host: "Claude Desktop", updated_by: "player" });
    expect(await store.list("inbox/job-scout")).toEqual([]);
    expect(await store.read("HANDBOOK.md")).toContain("| `job-scout` | Scout | Finds part-time work in Lisbon | career |");
    expect((await svc.overview()).attention.introductions).toEqual([]);
    expect(await svc.introduce("job-scout", { title: "Again" })).toMatchObject({ status: "member", path: "party/job-scout.md", message: "already in the party as Scout (party/job-scout.md)" });
    expect(await store.list("inbox/job-scout")).toEqual([]);
  });

  it("dismisses introductions and refuses bad ones", async () => {
    const store = fixtureStore();
    const svc = new HippoService(store, { now });
    await expect(svc.introduce("player", { title: "Me" })).rejects.toThrow(/is the human/);
    await expect(svc.introduce("curator", { title: "Curator" })).rejects.toThrow(/reserved/);
    await expect(svc.introduce("job-scout", { title: " " })).rejects.toThrow(/title is required/);
    await expect(svc.introduce("job-scout", { title: "x".repeat(121) })).rejects.toThrow(/title can be at most 120/);
    await expect(svc.approveIntroduction("job-scout")).rejects.toThrow(/no pending introduction from "job-scout"/);
    await svc.introduce("job-scout", { title: "Job Scout" });
    await expect(svc.approveIntroduction("job-scout", { authority: ["magic"] })).rejects.toThrow(/unknown domain magic/);
    expect(await svc.dismissIntroduction("job-scout")).toEqual({ agent: "job-scout", removed: [expect.stringMatching(/^inbox\/job-scout\/_introduction-/)] });
    expect(await store.list("inbox")).toEqual([]);
    await expect(svc.dismissIntroduction("job-scout")).rejects.toThrow(/no pending introduction/);
    // Adding the agent by hand settles its introduction too.
    await svc.introduce("job-scout", { title: "Job Scout" });
    await svc.addPartyMember({ id: "job-scout", title: "Job Scout" });
    expect(await store.list("inbox")).toEqual([]);
  });

  it("signs every commit with its actor, after the message", async () => {
    const { store, messages } = recording(fixtureStore());
    const svc = new HippoService(store, { now });
    await svc.remember("residency-agent", { text: "Biometric photos taken." });
    await svc.remember("", { text: "I prefer morning appointments." }, { asHuman: true });
    await svc.updateQuest("residency-agent", "residence-permit", { complete: ["health insurance"] });
    await svc.updateQuest("residency-agent", "residence-permit", { reopen: ["health insurance"] }, { asHuman: true });
    await svc.introduce("job-scout", { title: "Job Scout" });
    await svc.approveIntroduction("job-scout");
    await svc.addPartyMember({ id: "archivist", title: "Archivist" });
    expect(messages.map((m) => m.split("\n\n"))).toEqual([
      [expect.stringMatching(/^remember\(residency-agent\): ep-\w+$/), "Hippo-Actor: agent:residency-agent"],
      [expect.stringMatching(/^remember\(player\): ep-\w+$/), "Hippo-Actor: human"],
      ["goal(residence-permit): ✓ Get health insurance", "Hippo-Actor: agent:residency-agent"],
      ["goal(residence-permit): ○ Get health insurance", "Hippo-Actor: human"],
      ["introduce(job-scout): Job Scout", "Hippo-Actor: agent:job-scout"],
      ["party(player): approve job-scout", "Hippo-Actor: human"],
      ["party(player): add archivist", "Hippo-Actor: human"],
    ]);
  });

  it("update_quest ticks objectives, and its clock moves the goal's progress", async () => {
    const store = fixtureStore();
    const svc = new HippoService(store, { now });
    const r = await svc.updateQuest("residency-agent", "Residence permit 2026", { complete: ["health insurance"], add: ["Pay card fee"], clock: { name: "Paperwork", segments: 4, tick: 1 } });
    expect(r.changes).toEqual(["✓ Get health insurance", "+ Pay card fee", "progress 1/4"]);
    const quest = await svc.get("residence-permit");
    expect(quest.objectives).toEqual([
      { text: "Get health insurance", done: true },
      { text: "Book agency appointment", done: false },
      { text: "Pay card fee", done: false },
    ]);
    expect(await store.read("goals/residence-permit.md")).toContain("▰▱▱▱ 1/4 · due 2026-11-30");
    expect(await store.read("HANDBOOK.md")).toContain("1/3 objectives");
  });

  it("update_goal records progress, due date and repeat; get and the goal card show them", async () => {
    const store = fixtureStore();
    const svc = new HippoService(store, { now });
    const r = await svc.updateGoal("residency-agent", "residence-permit", { progress: { total: 3, tick: 1 }, due: "2026-12-01", repeat: { every: "1y" }, counterparty: "LMA" });
    expect(r).toEqual({ goal: "[[residence-permit]]", changes: ["due 2026-12-01", "counterparty [[migration-agency]]", "repeat every 1y", "progress 1/3"] });
    expect(await svc.get("residence-permit")).toMatchObject({
      status: "active",
      state: "active",
      due: "2026-12-01",
      next_due: "2026-12-01",
      deadline: "2026-12-01",
      progress: { done: 1, total: 3 },
      repeat: { every: "1y" },
      counterparty: "[[migration-agency]]",
    });
    const card = (await svc.overview()).quests[0]!;
    expect(card).toMatchObject({ state: "active", word: "active", due: "2026-12-01", nextDue: "2026-12-01", daysLeft: 65, progress: { done: 1, total: 3 }, counterparty: { slug: "migration-agency" } });
    expect(card.clocks).toEqual([{ name: "Progress", segments: 3, filled: 1, deadline: undefined, daysLeft: undefined }]);
    expect(await store.read("goals/residence-permit.md")).toContain("▰▱▱ 1/3 · due 2026-12-01 · repeats every 1y");
    await expect(svc.updateGoal("residency-agent", "migration-agency", { status: "done" })).rejects.toThrow(/no goal "migration-agency"/);
  });

  it("briefing lists upcoming dates", async () => {
    const svc = new HippoService(fixtureStore(), { now });
    const b = await svc.briefing({ horizonDays: 90 });
    expect(b.upcoming).toEqual([{ what: "due", date: "2026-11-30", ref: "[[residence-permit]]" }]);
  });

  it("briefing counts days in the vault's timezone, not UTC", async () => {
    const store = fixtureStore();
    await store.write("_hippo/config.yaml", ((await store.read("_hippo/config.yaml")) ?? "") + "\ntimezone: Pacific/Auckland\n");
    // 12:00 UTC on 29 Nov is already 30 Nov in Auckland, so the deadline is today, not tomorrow.
    const svc = new HippoService(store, { now: () => new Date("2026-11-29T12:00:00.000Z") });
    const b = await svc.briefing({ horizonDays: 0 });
    expect(b.upcoming).toEqual([{ what: "due", date: "2026-11-30", ref: "[[residence-permit]]" }]);
  });

  it("neighbors walks typed edges both directions", async () => {
    const store = fixtureStore();
    const v = await Vault.load(store, { now });
    const { addRelation } = await import("./ops.ts");
    addRelation(v, v.resolve("migration-agency")!, "handles", v.resolve("residence-permit")!, { by: "residency-agent", at: "", src: [] });
    await v.flush();
    const n = await new HippoService(store, { now }).neighbors("residence-permit");
    expect(n.edges).toEqual([{ from: "migration-agency", rel: "handles", to: "residence-permit" }]);
    expect(await store.read("factions/migration-agency.md")).toContain("- handles:: [[residence-permit]]");
  });
});

describe("HippoService: people", () => {
  const note = (fm: string, body = "") => `---\n${fm}\n---\n${body}`;
  const COLLEAGUE = note("type: archetype\ncadence: 1m\nguidelines:\n  - { rule: Keep it about work, status: canon }");
  const LANDLORD = note(
    [
      "type: character",
      "title: The landlord",
      "tags: [colleague]",
      "facts:",
      "  email: { value: landlord@lisbon.example, status: canon }",
      '  greeting@lang:pt: { value: "Olá", status: canon, by: home-finder, valid_from: 2026-01-01, confidence: 0.8 }',
      "guidelines:",
      '  - { rule: Write in Portuguese, scope: "lang:pt", status: canon }',
      "decisions:",
      "  - { id: dec-1, what: Renew the lease, by: player, at: 2026-09-01T10:00:00.000Z }",
      "questions:",
      '  - { id: q-1, q: "Is the deposit refundable?", by: home-finder, at: 2026-09-02T10:00:00.000Z }',
      "stats: { first_met: 2026-01-10, last_contact: 2026-08-01 }",
    ].join("\n"),
    "\n## Notes\nMet at the Harbor University open day.\n\n## Guidelines\nBe brief.\n",
  );
  const PROPOSAL = note(
    'type: dispute\nkind: proposal\nentity: "[[landlord]]"\nfield: stakes\nstatus: open\nstate: pending\nclaims:\n  - { value: low, by: residency-agent, src: [ep-1] }\n  - { value: high, by: home-finder, src: [ep-2] }',
  );
  const people = (extra: Record<string, string> = {}) =>
    managedStore({ "archetypes/colleague.md": COLLEAGUE, "characters/landlord.md": LANDLORD, "disputes/proposal-landlord-stakes.md": PROPOSAL, ...extra });

  it("get shows qualifiers, guidelines (own, inherited, the human's), stats, decisions, questions, inheritance and cadence", async () => {
    const svc = new HippoService(people(), { now });
    const v = await svc.get("landlord");
    expect(v.facts).toEqual([
      { field: "email", value: "◐ confidential", status: "canon", by: "player", confidential: true },
      { field: "greeting@lang:pt", value: "Olá", status: "canon", by: "home-finder", scope: "lang:pt", valid_from: "2026-01-01", confidence: 0.8 },
    ]);
    expect(v.guidelines).toEqual({
      human: "Be brief.",
      items: [{ rule: "Write in Portuguese", scope: "lang:pt", status: "canon", src: [] }],
      inherited: [{ rule: "Keep it about work", status: "canon", src: [], source: "colleague" }],
    });
    expect(v.stats).toEqual({ first_met: "2026-01-10", last_contact: "2026-08-01", last: {}, counts: {} });
    expect(v.decisions).toEqual([{ id: "dec-1", what: "Renew the lease", alternatives: [], by: "player", at: "2026-09-01T10:00:00.000Z" }]);
    expect(v.questions).toMatchObject([{ id: "q-1", q: "Is the deposit refundable?", status: "open" }]);
    expect(v.inherits).toEqual(["[[colleague]]"]);
    expect(v.cadence).toEqual({ every: "1m", due: "2026-09-01", overdueDays: 26 });
    expect(v.disputes).toEqual(["[[proposal-landlord-stakes]] (stakes)"]);

    const agent = await svc.get("residency-agent");
    expect(agent).toMatchObject({ lane: "student residence permit end-to-end", authority: ["residency"] });
    expect(agent.guidelines).toBeUndefined();
  });

  it("shows a confidential value only to a caller with authority over it", async () => {
    const svc = new HippoService(people(), { now });
    const email = async (caller?: string) => (await svc.get("landlord", { caller })).facts.find((f) => f.field === "email")!.value;
    expect(await email()).toBe("◐ confidential");
    expect(await email("home-finder")).toBe("◐ confidential");
    // A bound key naming a human isn't the human: only the dashboard's own read (`human`) reveals.
    expect(await email("player")).toBe("◐ confidential");
    expect(await email("human")).toBe("◐ confidential");
    expect((await svc.get("landlord", { human: true })).facts.find((f) => f.field === "email")!.value).toBe("landlord@lisbon.example");
    const svc2 = new HippoService(people({ "characters/landlord.md": LANDLORD.replace("tags: [colleague]", "tags: [colleague, housing]") }), { now });
    expect((await svc2.get("landlord", { caller: "home-finder" })).facts[0]!.value).toBe("landlord@lisbon.example");
    expect((await svc2.askCanon("landlord email", { caller: "home-finder" })).facts.map((f) => f.value)).toContain("landlord@lisbon.example");
    expect((await svc2.askCanon("landlord email")).facts.map((f) => f.value)).not.toContain("landlord@lisbon.example");
    expect(JSON.stringify(await svc2.recall("landlord"))).not.toContain("landlord@lisbon.example");
    expect(JSON.stringify(await svc2.recall("landlord", { caller: "home-finder" }))).toContain("landlord@lisbon.example");
  });

  it("personBrief: canon facts, guidelines, the last three interactions in 90 days, goals with them, open proposals, cadence", async () => {
    const entry = (time: string, agent: string, kind: string, text: string, id: string, touched?: string) =>
      `> [!episode] ${time} · [[${agent}]] · ${kind}\n> ${text}${touched ? `\n>\n> ↳ [[${touched}]]` : ""}\n\n^${id}\n`;
    const day = (date: string, ...entries: string[]) => `---\ntype: chronicle\ndate: ${date}\n---\n# ${date}\n\n${entries.join("\n")}`;
    const store = people({
      "chronicle/2026/06/2026-06-01.md": day("2026-06-01", entry("10:00", "home-finder", "interaction", "Viewing with [[landlord]]", "ep-old")),
      "chronicle/2026/09/2026-09-01.md": day("2026-09-01", entry("10:00", "home-finder", "interaction", "Coffee with [[The landlord]]", "ep-a")),
      "chronicle/2026/09/2026-09-10.md": day("2026-09-10", entry("09:00", "home-finder", "rollup/call", "call with [[landlord]]", "ep-b")),
      "chronicle/2026/09/2026-09-15.md": day("2026-09-15", entry("09:00", "home-finder", "observation", "[[landlord]] repainted the hall", "ep-obs")),
      "chronicle/2026/09/2026-09-20.md": day(
        "2026-09-20",
        entry("08:00", "home-finder", "interaction", "Agreed on the rent", "ep-c", "landlord"),
        entry("09:00", "campus-agent", "interaction", "Met the registrar at [[harbor-university]]", "ep-other"),
      ),
      "goals/renew-lease.md": note('type: goal\ntitle: Renew the lease\nstatus: active\nowner: "[[home-finder]]"\ncounterparty: "[[landlord]]"\ndue: 2026-10-31'),
      "goals/old-lease.md": note('type: goal\ntitle: Old lease\nstatus: done\ncounterparty: "[[landlord]]"'),
    });
    const b = await new HippoService(store, { now }).personBrief("The landlord");
    expect(b.ref).toBe("[[landlord]]");
    expect(b.facts.map((f) => f.field)).toEqual(["email", "greeting@lang:pt"]);
    expect(b.facts[0]!.value).toBe("◐ confidential");
    expect(b.guidelines.human).toBe("Be brief.");
    expect(b.guidelines.inherited.map((g) => g.rule)).toEqual(["Keep it about work"]);
    expect(b.interactions.map((i) => [i.id, i.kind])).toEqual([
      ["ep-c", "interaction"],
      ["ep-b", "rollup/call"],
      ["ep-a", "interaction"],
    ]);
    expect(b.goals).toEqual([{ ref: "[[renew-lease]]", title: "Renew the lease", role: "counterparty", state: "active", next_due: "2026-10-31" }]);
    expect(b.disputes).toEqual([{ ref: "[[proposal-landlord-stakes]]", kind: "proposal", field: "stakes", state: "pending" }]);
    expect(b.cadence).toEqual({ every: "1m", due: "2026-09-01", overdueDays: 26 });
    await expect(new HippoService(store, { now }).personBrief("nobody-here")).rejects.toThrow(/no entity "nobody-here"/);
  });

  it("briefing lists overdue contacts, most overdue first, spread across groups and capped per day", async () => {
    const person = (title: string, cadence: string, last: string, group?: string) =>
      note(`type: character\ntitle: ${title}\ncadence: ${cadence}\nstats: { last_contact: ${last} }${group ? `\nrelations:\n  - { rel: member_of, target: "[[${group}]]" }` : ""}`);
    const extra = {
      "groups/family.md": note("type: group\ntitle: Family"),
      "groups/work.md": note("type: group\ntitle: Work"),
      "characters/flatmate.md": person("Flatmate", "1w", "2026-09-01", "family"),
      "characters/cousin.md": person("Cousin", "1w", "2026-09-02", "family"),
      "characters/aunt.md": person("Aunt", "1w", "2026-09-03", "family"),
      "characters/tutor.md": person("Tutor", "1w", "2026-09-15", "work"),
      "characters/neighbour.md": person("Neighbour", "2w", "2026-09-05"),
      "characters/classmate.md": person("Classmate", "1m", "2026-09-20"),
      "characters/stranger-x.md": person("Stranger", "none", "2026-01-01"),
    };
    const b = await new HippoService(people(extra), { now }).briefing();
    // Three a day: the family's second and third most overdue wait behind the other groups' first.
    expect(b.overdue.map((o) => [o.ref, o.days_overdue, o.group])).toEqual([
      ["[[landlord]]", 26, undefined],
      ["[[flatmate]]", 19, "[[family]]"],
      ["[[neighbour]]", 8, undefined],
    ]);
    expect(b.overdue[0]).toEqual({ ref: "[[landlord]]", title: "The landlord", last_contact: "2026-08-01", cadence: "1m", due: "2026-09-01", days_overdue: 26 });

    const store = people(extra);
    await store.write("_hippo/config.yaml", ((await store.read("_hippo/config.yaml")) ?? "") + "briefing: { overdue_per_day: 5 }\n");
    const more = await new HippoService(store, { now }).briefing();
    expect(more.overdue.map((o) => o.ref)).toEqual(["[[landlord]]", "[[flatmate]]", "[[cousin]]", "[[neighbour]]", "[[tutor]]"]);
  });

  it("decideProposal: accept applies a claim (or a typed value) as the human's; decline closes it unchanged", async () => {
    const store = people();
    const svc = new HippoService(store, { now });
    expect(await svc.decideProposal("[[proposal-landlord-stakes]]", { decision: "accept" })).toEqual({
      proposal: "proposal-landlord-stakes",
      decision: "accepted",
      entity: "landlord",
      field: "stakes",
      value: "high",
      secret: false,
    });
    const v = await svc.vault();
    expect(v.resolve("landlord")!.fm.facts.stakes).toMatchObject({ value: "high", status: "canon", by: "player", src: ["ep-1", "ep-2"] });
    expect(v.disputes.get("proposal-landlord-stakes")!.fm).toMatchObject({ status: "resolved", state: "applied", ruling: "high" });
    await expect(svc.decideProposal("proposal-landlord-stakes", { decision: "decline" })).rejects.toThrow(/no open proposal/);

    const again = new HippoService(people(), { now });
    expect(await again.decideProposal("proposal-landlord-stakes", { decision: "accept", claim: 0 })).toMatchObject({ value: "low" });
    const typed = new HippoService(people(), { now });
    expect(await typed.decideProposal("proposal-landlord-stakes", { decision: "accept", value: " medium " })).toMatchObject({ value: "medium" });

    const declined = people();
    const d = new HippoService(declined, { now });
    expect(await d.decideProposal("proposal-landlord-stakes", { decision: "decline" })).toEqual({ proposal: "proposal-landlord-stakes", decision: "declined", entity: "landlord", field: "stakes" });
    const after = await d.vault();
    expect(after.disputes.get("proposal-landlord-stakes")!.fm).toMatchObject({ status: "resolved", state: "declined" });
    expect(after.resolve("landlord")!.fm.facts.stakes).toBeUndefined();
    expect((await d.overview()).attention.disputes).toEqual([]);
  });

  it("decideProposal refuses conflicts, and merges can only be declined", async () => {
    const conflict = note('type: dispute\nentity: "[[landlord]]"\nfield: rent\nstatus: open\nclaims:\n  - { value: 900, by: home-finder }\n  - { value: 950, by: residency-agent }');
    const merge = note('type: dispute\nkind: merge\nentity: "[[landlord]]"\nfield: email\nstatus: open\nstate: pending\ntargets: ["[[landlord]]", "[[player]]"]\nevidence: Same email');
    const store = people({ "disputes/dispute-landlord-rent.md": conflict, "disputes/merge-landlord-player.md": merge });
    const svc = new HippoService(store, { now });
    await expect(svc.decideProposal("dispute-landlord-rent", { decision: "accept" })).rejects.toThrow(/no open proposal/);
    await expect(svc.decideProposal("merge-landlord-player", { decision: "accept" })).rejects.toThrow(/merge the notes by hand/);
    const views = (await svc.overview()).attention.disputes.sort((a, b) => a.slug.localeCompare(b.slug));
    expect(views.map((x) => [x.slug, x.kind, x.state])).toEqual([
      ["dispute-landlord-rent", "conflict", undefined],
      ["merge-landlord-player", "merge", "pending"],
      ["proposal-landlord-stakes", "proposal", "pending"],
    ]);
    expect(views[1]).toMatchObject({ evidence: "Same email", targets: [{ slug: "landlord" }, { slug: "player" }] });
    expect(await svc.decideProposal("merge-landlord-player", { decision: "decline" })).toMatchObject({ decision: "declined" });
  });
});
