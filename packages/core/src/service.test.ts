import { describe, expect, it } from "vitest";
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
    expect(await store.read("quests/residence-permit.md")).not.toContain("- [x]");
    await svc.updateQuest("residency-agent", "residence-permit", { complete: ["health insurance"] }, { asHuman: true });
    expect(await store.read("quests/residence-permit.md")).toContain("updated_by: player");
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
      ["quest(residence-permit): ✓ Get health insurance", "Hippo-Actor: agent:residency-agent"],
      ["quest(residence-permit): ○ Get health insurance", "Hippo-Actor: human"],
      ["introduce(job-scout): Job Scout", "Hippo-Actor: agent:job-scout"],
      ["party(player): approve job-scout", "Hippo-Actor: human"],
      ["party(player): add archivist", "Hippo-Actor: human"],
    ]);
  });

  it("update_quest ticks objectives and clocks", async () => {
    const store = fixtureStore();
    const svc = new HippoService(store, { now });
    const r = await svc.updateQuest("residency-agent", "Residence permit 2026", { complete: ["health insurance"], add: ["Pay card fee"], clock: { name: "Paperwork", segments: 4, tick: 1 } });
    expect(r.changes).toEqual(["✓ Get health insurance", "+ Pay card fee", "clock Paperwork 1/4"]);
    const quest = await svc.get("residence-permit");
    expect(quest.objectives).toEqual([
      { text: "Get health insurance", done: true },
      { text: "Book agency appointment", done: false },
      { text: "Pay card fee", done: false },
    ]);
    expect(await store.read("quests/residence-permit.md")).toContain("⏱ **Paperwork** ■□□□ 1/4");
    expect(await store.read("HANDBOOK.md")).toContain("1/3 objectives");
  });

  it("briefing lists upcoming dates", async () => {
    const svc = new HippoService(fixtureStore(), { now });
    const b = await svc.briefing({ horizonDays: 90 });
    expect(b.upcoming).toEqual([{ what: "deadline", date: "2026-11-30", ref: "[[residence-permit]]" }]);
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
