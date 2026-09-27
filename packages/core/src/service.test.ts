import { describe, expect, it } from "vitest";
import { fixtureStore } from "./__fixtures__/vault.ts";
import { applyFact, applyRulings } from "./ops.ts";
import { parseDoc } from "./markdown.ts";
import { HippoService } from "./service.ts";
import { Vault } from "./vault.ts";
import { decryptSecret, generateKeyPair } from "./secrets.ts";

const now = () => new Date("2026-09-27T12:00:00.000Z");

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
    const { path } = await svc.remember("Residency Agent", { text: "agency appointment booked for 2026-10-14 at Alfama", kind: "fact", about: ["[[migration-agency]]"] });
    expect(path).toMatch(/^inbox\/residency-agent\/2026-09-27T120000-\w{6}\.md$/);
    const r = await svc.recall("agency appointment");
    expect(r.entities[0]?.ref).toBe("[[migration-agency]]");
    expect(r.pending[0]?.text).toContain("2026-10-14");
  });

  it("onboard includes lane and owned quests", async () => {
    const text = await new HippoService(fixtureStore(), { now }).onboard("residency-agent");
    expect(text).toContain("You are Residency Agent");
    expect(text).toContain("[[residence-permit]]");
    expect(text).toContain("inbox/<agent-id>/");
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
