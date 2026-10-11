import { fileURLToPath } from "node:url";
import { HippoService, Vault, daysBetween } from "@hippocampus/core";
import { FsStore } from "@hippocampus/core/node";
import { beforeAll, describe, expect, it } from "vitest";
import { buildDemoStore } from "./demo.ts";

const SEED = fileURLToPath(new URL("../../../seeds/example-relocation", import.meta.url));
const TEMPLATE = fileURLToPath(new URL("../../../vault-template", import.meta.url));
const NOW = new Date("2026-09-27T12:00:00.000Z");
/** The demo passport number and the text of its secret inbox episode. */
const PASSPORT = "X0000000";
const SECRET_EPISODE = "Residence card application reference received";

describe("demo campaign", () => {
  let store: Awaited<ReturnType<typeof buildDemoStore>>;
  let svc: HippoService;
  beforeAll(async () => {
    store = await buildDemoStore(new FsStore(SEED), { now: NOW, template: new FsStore(TEMPLATE) });
    svc = new HippoService(store, { now: () => NOW });
  });

  it("loads cleanly", async () => {
    expect((await Vault.load(store, { now: () => NOW })).warnings).toEqual([]);
    const o = await svc.overview();
    expect(o.warnings).toEqual([]);
    expect(o).toMatchObject({ name: "lisbon-arc", campaign: "lisbon-arc", human: "player", today: "2026-09-27", version: { status: "current" } });
    expect(o.humans?.map((h) => h.id)).toEqual(["player", "partner"]);
    expect(o.lastSleep).toBe("2026-09-27T04:00:00.000Z");
  });

  it("has something for every part of the dashboard", async () => {
    const o = await svc.overview();
    const conflicts = o.attention.disputes.filter((d) => d.kind === "conflict");
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
    expect(conflicts.every((d) => d.status === "open" && d.claims.length >= 2)).toBe(true);
    // A proposal for a field only a human sets, and a possible duplicate.
    expect(o.attention.disputes.find((d) => d.kind === "proposal")).toMatchObject({ field: "stakes", state: "pending", entity: { slug: "landlord" } });
    expect(o.attention.disputes.find((d) => d.kind === "merge")?.targets?.map((t) => t.slug).sort()).toEqual(["flat-owner", "landlord"]);
    // A contact past its cadence.
    expect(o.attention.overdue).toEqual([expect.objectContaining({ ref: expect.objectContaining({ slug: "landlord" }), cadence: "1w", daysOverdue: 1 })]);
    expect(o.attention.rumors.length).toBeGreaterThan(0);
    expect(o.attention.stale.length).toBeGreaterThan(0);
    expect(o.attention.unknownAgents).toEqual(["calendar-bot"]);
    // An introduced agent isn't a stranger: it waits for the player's approval instead.
    expect(o.attention.introductions).toEqual([expect.objectContaining({ agent: "transit-scout", title: "Transit Scout", host: "Claude Desktop" })]);
    expect(o.inbox.some((e) => e.agent === "transit-scout")).toBe(true);
    expect(Object.keys(o.counts.goals ?? {}).sort()).toEqual(expect.arrayContaining(["active", "blocked", "dormant"]));
    expect(o.goals?.some((g) => g.progress && g.progress.done > 0 && g.objectives.some((x) => x.done))).toBe(true);
    expect(o.goals?.find((g) => g.slug === "pay-rent")).toMatchObject({ repeat: { every: "1m" }, counterparty: { slug: "landlord" }, owner: { slug: "home-finder" } });
    // Kinds come from the registry; `beat` is an alias kept for older agents.
    expect(o.schema?.kinds.find((k) => k.name === "beat")).toMatchObject({ aliasOf: "observation" });
    expect(o.schema?.kinds.find((k) => k.name === "interaction")).toMatchObject({ behaviour: "interaction" });
    expect(o.upcoming.length).toBeGreaterThan(0);
    expect(o.party.length).toBeGreaterThanOrEqual(5);

    // The landlord's sheet: a confidential identity key, a scoped guideline, contact stats, cadence.
    const landlord = await svc.entityDetail("landlord");
    expect(landlord.facts.find((f) => f.field === "email")).toMatchObject({ value: null, confidential: true });
    expect(landlord.guidelines?.items[0]).toMatchObject({ scope: "lang:pt", by: "home-finder", byHuman: false });
    expect(landlord.stats?.counts).toMatchObject({ interaction: 1, "interaction/call": 1 });
    expect(landlord.cadence).toMatchObject({ every: "1w", overdueDays: 1 });
    expect((await svc.entityDetail("apartment-hunt")).decisions?.[0]).toMatchObject({ by: "player" });
    expect((await svc.entityDetail("harbor-university")).questions?.[0]).toMatchObject({ status: "open" });
    // A fact set by the second human.
    expect((await svc.entityDetail("alfama-flat")).facts.find((f) => f.field === "deposit")).toMatchObject({ by: "partner", byHuman: true, status: "canon" });

    // A sealed secret fact, shown masked.
    const passport = await svc.entityDetail("passport");
    expect(passport.facts.find((f) => f.field === "number")).toMatchObject({ value: null, secret: true, status: "canon" });
    expect(await store.read(passport.path)).toContain("secret://");

    // A secret episode still in the inbox, masked.
    const masked = o.inbox.filter((e) => e.secret);
    expect(masked).toHaveLength(1);
    expect(masked[0]).toMatchObject({ agent: "residency-agent", text: null, about: [] });

    // At least three weeks of chronicle.
    const page = await svc.chronicle();
    expect(page.month).toBe("2026-09");
    const days = (await Promise.all(page.months.map((m) => svc.chronicle(m)))).flatMap((p) => p.days.map((d) => d.date)).sort();
    expect(daysBetween(days[0]!, days.at(-1)!)).toBeGreaterThanOrEqual(21);
    expect(o.activity.filter((a) => a.chronicled > 0).length).toBeGreaterThanOrEqual(21);
    expect(o.chronicle.length).toBeGreaterThan(0);
  });

  it("never reveals the demo secrets", async () => {
    const o = await svc.overview();
    const views: unknown[] = [o, await svc.catalog(), await svc.graph(), await svc.chronicle(), await svc.search("passport"), await svc.search("residence card")];
    for (const ref of [...o.party.map((p) => p.slug), "passport", "residence-permit", "migration-agency", "player"]) views.push(await svc.entityDetail(ref));
    views.push(await svc.entityDetail("landlord"), await svc.entityDetail("flat-owner"));
    const json = JSON.stringify(views);
    expect(json).not.toContain("landlord@example.test");
    expect(json).not.toContain(PASSPORT);
    expect(json).not.toContain(SECRET_EPISODE);
    expect(json).not.toContain("secret://");

    // Only the inbox (until the next sleep encrypts it) holds a secret in plain text, and the passport number is nowhere.
    for (const path of await store.list()) {
      const content = (await store.read(path)) ?? "";
      expect(content, path).not.toContain(PASSPORT);
      if (content.includes(SECRET_EPISODE)) expect(path).toMatch(/^inbox\/residency-agent\//);
    }
  });

  it("is relative to now, so deadlines stay ahead", async () => {
    const later = new Date("2027-03-01T12:00:00.000Z");
    const o = await new HippoService(await buildDemoStore(new FsStore(SEED), { now: later, template: new FsStore(TEMPLATE) }), { now: () => later }).overview();
    expect(o.today).toBe("2027-03-01");
    expect(o.upcoming.every((u) => u.daysLeft >= 0)).toBe(true);
    expect(o.upcoming.length).toBeGreaterThan(0);
  });
});
