import { describe, expect, it } from "vitest";
import { fixtureStore } from "./__fixtures__/vault.ts";
import { parseDoc } from "./markdown.ts";
import { applyQuestUpdate } from "./ops.ts";
import { HippoService, parseChronicle } from "./service.ts";
import { Vault } from "./vault.ts";
import { parseChronicleDay } from "./views.ts";

const now = () => new Date("2026-09-27T12:00:00.000Z");

const CHRONICLE = `---
type: chronicle
date: 2026-09-25
---
# 2026-09-25

> [!episode] 09:15 · [[residency-agent]] · fact
> The agency moved the appointment to 2026-10-14.
> Bring two photos.
>
> ↳ [[migration-agency]] · [[residence-permit]]

^ep-01AAA

> [!episode] 18:40 · [[job-scout]] · observation
> Saw a listing near Alfama.

^ep-01BBB
`;

/** A vault with every kind of thing a human looks at: disputes, rumors, stale canon, secrets, inbox, chronicle. */
function richStore() {
  return fixtureStore({
    "factions/migration-agency.md": `---
type: faction
title: Agência de Migração
aliases: [Lisbon Migration, LMA]
tags: [residency]
relations: [{ rel: handles, target: "[[residence-permit]]" }]
facts:
  office_address: { value: Alfama, status: disputed, by: campus-agent, at: "2026-09-10T00:00:00Z", src: [ep-a] }
  phone: { value: "+351 000", status: canon, by: residency-agent, at: "2026-05-01T00:00:00Z", src: [ep-old] }
  hours: { value: "9-16", status: rumor, by: home-finder, at: "2026-09-20T00:00:00Z", src: [ep-h], seen_by: [home-finder] }
---

## Notes
Human prose that must survive.
`,
    "items/passport.md": `---
type: item
title: Passport
tags: [residency]
facts:
  number: { value: "secret://passport/number", status: canon, by: residency-agent, at: "2026-09-10T00:00:00Z", src: [ep-s], was: [{ value: "secret://passport/number", by: residency-agent }] }
---
`,
    "locations/harbor-cafe.md": `---\ntype: location\ntitle: Harbor Cafe\n---\n`,
    "disputes/dispute-migration-agency-office-address.md": `---
type: dispute
entity: "[[migration-agency]]"
field: office_address
status: open
claims:
  - { value: Alfama, by: campus-agent, at: "2026-09-10T00:00:00Z", src: [ep-a] }
  - { value: Belém, by: home-finder, at: "2026-09-11T00:00:00Z", src: [ep-b] }
opened: "2026-09-11T00:00:00Z"
---
`,
    "chronicle/2026/09/2026-09-25.md": CHRONICLE,
    "inbox/residency-agent/2026-09-26T100000-aaaaaa.md": `---\nid: ep-in1\nagent: residency-agent\nkind: fact\nat: "2026-09-26T10:00:00Z"\nabout: ["[[migration-agency]]"]\n---\nAgency opens at 9.\n`,
    "inbox/residency-agent/2026-09-26T110000-bbbbbb.md": `---\nid: ep-in2\nagent: residency-agent\nkind: fact\nat: "2026-09-20T11:00:00Z"\nabout: ["[[passport]]"]\nsecret: true\n---\nPassport number is U12345678.\n`,
    "inbox/job-scout/2026-09-26T120000-cccccc.md": `---\nid: ep-in3\nagent: job-scout\nkind: observation\nat: "2026-09-26T12:00:00Z"\n---\nA cafe is hiring.\n`,
    "_hippo/review.md": `---\ntype: review\ngenerated: "2026-09-25T03:30:00.000Z"\n---\n# 🌙 Morning review\n`,
  });
}

describe("dashboard views", () => {
  it("overview counts, attention, quests, party and activity", async () => {
    const o = await new HippoService(richStore(), { now }).overview();
    expect(o).toMatchObject({ campaign: "lisbon-arc", human: "player", today: "2026-09-27", lastSleep: "2026-09-25T03:30:00.000Z" });
    expect(o.counts.facts).toEqual({ rumor: 1, canon: 2, disputed: 1, retconned: 0 });
    expect(o.counts).toMatchObject({ inbox: 3, disputes: 1, quests: { active: 1 } });
    expect(o.attention.disputes.map((d) => [d.slug, d.claims.map((c) => c.value)])).toEqual([["dispute-migration-agency-office-address", ["Alfama", "Belém"]]]);
    expect(o.attention.rumors.map((r) => `${r.ref.slug}.${r.field}`)).toEqual(["migration-agency.hours"]);
    expect(o.attention.stale.map((r) => `${r.ref.slug}.${r.field}`)).toEqual(["migration-agency.phone"]);
    expect(o.attention.orphans.map((r) => r.slug)).toEqual(["harbor-cafe", "passport"]);
    expect(o.attention.waiting.map((e) => e.id)).toEqual(["ep-in2"]);
    expect(o.attention.unknownAgents).toEqual(["job-scout"]);
    expect(o.attention.introductions).toEqual([]);
    const quest = o.quests[0]!;
    expect(quest).toMatchObject({ slug: "residence-permit", owner: { slug: "residency-agent", type: "party" }, deadline: "2026-11-30", daysLeft: 64, degree: 1 });
    expect(quest.objectives).toHaveLength(2);
    expect(o.upcoming).toEqual([{ what: "deadline", date: "2026-11-30", daysLeft: 64, ref: { slug: "residence-permit", title: "Residence permit 2026", type: "quest" } }]);
    const agent = o.party.find((p) => p.slug === "residency-agent")!;
    expect(agent).toMatchObject({ pending: 2, chronicled30d: 1, lastSeen: "2026-09-26T10:00:00.000Z", owns: [{ slug: "residence-permit" }] });
    expect(o.chronicle.map((c) => c.id)).toEqual(["ep-01AAA", "ep-01BBB"]);
    expect(o.activity).toHaveLength(30);
    expect(o.activity.find((d) => d.date === "2026-09-25")).toMatchObject({ chronicled: 2, byAgent: { "residency-agent": 1, "job-scout": 1 } });
    expect(o.inbox[0]?.id).toBe("ep-in3");
  });

  it("lists introductions in place of unknown agents, and drops members' leftovers", async () => {
    const store = richStore();
    await store.write("inbox/job-scout/_introduction-01aaa.md", "---\ntype: introduction\nagent: job-scout\ntitle: Job Scout\nlane: Part-time work\nat: 2026-09-26T13:00:00.000Z\n---\n");
    await store.write("inbox/residency-agent/_introduction-01bbb.md", "---\ntype: introduction\nagent: residency-agent\ntitle: Residency Agent\nat: 2026-09-20T13:00:00.000Z\n---\n");
    const o = await new HippoService(store, { now }).overview();
    expect(o.attention.unknownAgents).toEqual([]);
    expect(o.attention.introductions).toEqual([{ agent: "job-scout", title: "Job Scout", lane: "Part-time work", at: "2026-09-26T13:00:00.000Z" }]);
    expect(o.counts.inbox).toBe(3);
  });

  it("never shows secret values or secret episodes", async () => {
    const svc = new HippoService(richStore(), { now });
    const everything = JSON.stringify([await svc.overview(), await svc.catalog(), await svc.entityDetail("passport"), await svc.graph(), await svc.search("passport")]);
    expect(everything).not.toContain("U12345678");
    expect(everything).not.toContain("secret://");
    const passport = await svc.entityDetail("passport");
    expect(passport.facts[0]).toMatchObject({ field: "number", value: null, secret: true, was: [{ value: null, secret: true }] });
    expect(passport.pending).toEqual([expect.objectContaining({ id: "ep-in2", text: null, secret: true, about: [] })]);
  });

  it("entity detail has provenance, relations, disputes, mentions and pending episodes", async () => {
    const d = await new HippoService(richStore(), { now }).entityDetail("Lisbon Migration");
    expect(d.card).toMatchObject({ slug: "migration-agency", degree: 1, facts: { canon: 1, rumor: 1, disputed: 1 } });
    expect(d.notes).toBe("Human prose that must survive.");
    const address = d.facts.find((f) => f.field === "office_address")!;
    expect(address).toMatchObject({ value: "Alfama", status: "disputed", by: "campus-agent", authority: "none", dispute: "dispute-migration-agency-office-address" });
    expect(d.facts.find((f) => f.field === "phone")).toMatchObject({ stale: true, authority: "authority" });
    expect(d.facts.find((f) => f.field === "hours")).toMatchObject({ seenBy: ["home-finder"] });
    expect(d.relations).toEqual([{ rel: "handles", dir: "out", ref: { slug: "residence-permit", title: "Residence permit 2026", type: "quest" } }]);
    expect(d.disputes[0]).toMatchObject({ status: "open", secretField: false, current: { value: "Alfama" } });
    expect(d.mentions.map((m) => m.id)).toEqual(["ep-01AAA"]);
    expect(d.pending.map((e) => e.id)).toEqual(["ep-in1"]);
  });

  it("graph, catalog and chronicle pages", async () => {
    const svc = new HippoService(richStore(), { now });
    expect((await svc.graph()).edges).toEqual([
      { from: "migration-agency", rel: "handles", to: "residence-permit" },
      { from: "residency-agent", rel: "leads", to: "residence-permit" },
    ]);
    const c = await svc.catalog();
    expect(c.types.find((t) => t.name === "party")?.count).toBe(3);
    expect(c.entities.map((e) => e.slug)).toContain("harbor-cafe");
    const page = await svc.chronicle();
    expect(page).toMatchObject({ month: "2026-09", months: ["2026-09"] });
    expect(page.days[0]?.entries[0]).toMatchObject({ time: "09:15", text: "The agency moved the appointment to 2026-10-14.\nBring two photos.", touched: ["migration-agency", "residence-permit"] });
    expect((await svc.chronicle("2026-08")).days).toEqual([]);
  });

  it("parseChronicle keeps the agent-facing shape", () => {
    expect(parseChronicle("2026-09-25", CHRONICLE)[0]).toEqual({
      id: "ep-01AAA",
      agent: "residency-agent",
      kind: "fact",
      at: "2026-09-25T09:15",
      text: "The agency moved the appointment to 2026-10-14. Bring two photos.",
    });
    expect(parseChronicleDay("2026-09-25", CHRONICLE)[1]?.touched).toEqual([]);
  });
});

describe("human actions", () => {
  it("rule by claim makes it canon by the human and closes the dispute", async () => {
    const store = richStore();
    const svc = new HippoService(store, { now });
    const r = await svc.rule("[[dispute-migration-agency-office-address]]", { claim: 1 }, { via: "@player" });
    expect(r).toEqual({ dispute: "dispute-migration-agency-office-address", entity: "migration-agency", field: "office_address", value: "Belém", secret: false });
    const fm = parseDoc((await store.read("factions/migration-agency.md"))!).data as { facts: Record<string, Record<string, unknown>>; updated_by: string };
    expect(fm.facts.office_address).toMatchObject({ value: "Belém", status: "canon", by: "player", src: ["ep-a", "ep-b"], was: [{ value: "Alfama", by: "campus-agent" }] });
    expect(fm.updated_by).toBe("player");
    const dispute = parseDoc((await store.read("disputes/dispute-migration-agency-office-address.md"))!).data;
    expect(dispute).toMatchObject({ status: "resolved", ruling: "Belém" });
    expect(await store.read("HANDBOOK.md")).toContain("## ⚖ Open disputes\n\n- (none)");
    await expect(svc.rule("dispute-migration-agency-office-address", { claim: 0 })).rejects.toThrow(/no open dispute/);
  });

  it("rule with a typed value, a pending ruling, or nothing", async () => {
    const store = richStore();
    const svc = new HippoService(store, { now });
    await expect(svc.rule("dispute-migration-agency-office-address", {})).rejects.toThrow(/pick a claim/);
    await expect(svc.rule("dispute-migration-agency-office-address", { pending: true })).rejects.toThrow(/no ruling written/);
    expect((await svc.rule("dispute-migration-agency-office-address", { value: " Baixa " })).value).toBe("Baixa");
  });

  it("refuses typed rulings on secret fields", async () => {
    const store = richStore();
    await store.write(
      "disputes/dispute-passport-number.md",
      `---\ntype: dispute\nentity: "[[passport]]"\nfield: number\nstatus: open\nclaims: [{ value: A1, by: campus-agent }, { value: B2, by: home-finder }]\n---\n`,
    );
    const svc = new HippoService(store, { now });
    expect((await svc.overview()).attention.disputes.find((d) => d.slug === "dispute-passport-number")?.secretField).toBe(true);
    await expect(svc.rule("dispute-passport-number", { value: "U999" })).rejects.toThrow(/secret/);
  });

  it("adds party members with validated ids and domains", async () => {
    const store = richStore();
    const svc = new HippoService(store, { now });
    expect(await svc.addPartyMember({ id: "job-scout", title: "Job Scout", lane: "career", authority: ["Career"], host: "claude" })).toEqual({ slug: "job-scout", path: "party/job-scout.md" });
    const fm = parseDoc((await store.read("party/job-scout.md"))!).data;
    expect(fm).toMatchObject({ type: "party", title: "Job Scout", lane: "career", authority: ["career"], host: "claude", updated_by: "player" });
    expect(await store.read("HANDBOOK.md")).toContain("| `job-scout` | Job Scout | career | career |");
    expect((await svc.overview()).attention.unknownAgents).toEqual([]);
    await expect(svc.addPartyMember({ id: "job-scout", title: "x" })).rejects.toThrow(/already exists/);
    await expect(svc.addPartyMember({ id: "Bad Id", title: "x" })).rejects.toThrow(/lowercase/);
    await expect(svc.addPartyMember({ id: "player", title: "x" })).rejects.toThrow(/human/);
    await expect(svc.addPartyMember({ id: "archivist", title: "x", authority: ["magic"] })).rejects.toThrow(/unknown domain magic/);
  });

  it("reopens objectives and keeps clocks within their segments", async () => {
    const v = await Vault.load(fixtureStore(), { now });
    const quest = v.resolve("residence-permit")!;
    applyQuestUpdate(v, quest, { complete: ["insurance"], clock: { name: "Paperwork", segments: 6, filled: 5 } }, "player");
    expect(applyQuestUpdate(v, quest, { reopen: ["health insurance", "nonexistent"], clock: { name: "paperwork", segments: 4 } }, "player")).toEqual([
      "○ Get health insurance",
      "clock Paperwork 4/4",
    ]);
    expect(quest.fm.clocks).toEqual([{ name: "Paperwork", segments: 4, filled: 4 }]);
    expect(quest.fm.updated_by).toBe("player");
  });
});
