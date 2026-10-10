import { describe, expect, it } from "vitest";
import { CONFIG, fixtureStore } from "./__fixtures__/vault.ts";
import { applyFact } from "./ops.ts";
import { reconcileFact, type Decision, type ReconcileInput } from "./reconcile.ts";
import type { Fact, FieldDef } from "./schema.ts";
import { Vault } from "./vault.ts";

const at1 = "2026-09-01T10:00:00.000Z";
const at2 = "2026-09-20T10:00:00.000Z";
const at0 = "2026-08-01T10:00:00.000Z";
const fact = (value: string, by: string | undefined, status: Fact["status"] = "canon", at = at1): Fact => ({ value, by, status, at, src: ["ep-1"] });
const decide = (over: Partial<ReconcileInput> & Pick<ReconcileInput, "incoming">): Decision =>
  reconcileFact({ incomingAuthority: "none", existingAuthority: "none", canonThreshold: 2, ...over });
/** Every row but `propose` has a fact. */
const run = (over: Partial<ReconcileInput> & Pick<ReconcileInput, "incoming">) => {
  const d = decide(over);
  if (!d.fact) throw new Error(`no fact for ${d.action}`);
  return { ...d, fact: d.fact };
};
const succession: FieldDef = { kind: "text", succession: true };
const humanOnly: FieldDef = { kind: "text", human_only: true };

// One test per row of the precedence table in reconcile.ts.
describe("reconcileFact", () => {
  it("absent: rumor from none, canon from authority or a human", () => {
    expect(run({ incoming: { value: "x", by: "campus-agent", at: at2, src: ["ep-2"] } }).fact.status).toBe("rumor");
    expect(run({ incoming: { value: "x", by: "residency-agent", at: at2, src: ["ep-2"] }, incomingAuthority: "authority" }).fact.status).toBe("canon");
    expect(run({ incoming: { value: "x", by: "player", at: at2, src: ["ep-2"] }, incomingAuthority: "human" }).fact.status).toBe("canon");
  });

  it("absent: keeps the report's qualifiers", () => {
    const d = run({ incoming: { value: "x", by: "player", at: at2, src: [], valid_from: "2026-01-01", confidence: 0.8 }, incomingAuthority: "human" });
    expect(d.fact).toMatchObject({ valid_from: "2026-01-01", confidence: 0.8 });
    expect(d.fact.valid_until).toBeUndefined();
  });

  it("same value: a second agent promotes a rumor (corroborate)", () => {
    const d = run({ existing: fact("x", "campus-agent", "rumor"), incoming: { value: "X ", by: "job-scout", at: at2, src: ["ep-2"] } });
    expect(d.action).toBe("corroborate");
    expect(d.fact.status).toBe("canon");
    expect(d.fact.src).toEqual(["ep-1", "ep-2"]);
    expect(d.fact.seen_by).toBeUndefined();
  });

  it("same value: the same agent repeating itself does not promote", () => {
    const d = run({ existing: fact("x", "campus-agent", "rumor"), incoming: { value: "x", by: "campus-agent", at: at2, src: ["ep-2"] } });
    expect(d.fact.status).toBe("rumor");
  });

  it("same value: authority promotes, a human confirms and takes the value", () => {
    expect(run({ existing: fact("x", "campus-agent", "rumor"), incoming: { value: "x", by: "residency-agent", at: at2, src: [] }, incomingAuthority: "authority" }).fact.status).toBe("canon");
    const d = run({ existing: fact("x", "campus-agent", "rumor"), incoming: { value: "x", by: "player", at: at2, src: [] }, incomingAuthority: "human" });
    expect(d.fact).toMatchObject({ status: "canon", by: "player" });
  });

  it("differs, existing by human: an agent disputes, with or without authority", () => {
    for (const incomingAuthority of ["authority", "none"] as const) {
      const d = run({ existing: fact("a", undefined), incoming: { value: "b", by: "residency-agent", at: at2, src: [] }, existingAuthority: "human", incomingAuthority });
      expect(d.action).toBe("dispute");
    }
  });

  it("differs, existing authority: a human replaces, authority disputes, none is not adopted", () => {
    const existing = fact("a", "residency-agent");
    expect(run({ existing, incoming: { value: "b", by: "player", at: at2, src: [] }, existingAuthority: "authority", incomingAuthority: "human" }).action).toBe("replace");
    expect(run({ existing, incoming: { value: "b", by: "home-finder", at: at2, src: [] }, existingAuthority: "authority", incomingAuthority: "authority" }).action).toBe("dispute");
    const d = run({ existing, incoming: { value: "b", by: "campus-agent", at: at2, src: [] }, existingAuthority: "authority" });
    expect(d.action).toBe("keep");
    expect(d.fact.value).toBe("a");
  });

  it("differs, existing none: a human or authority replaces, a peer disputes", () => {
    const d = run({ existing: fact("a", "campus-agent", "rumor"), incoming: { value: "b", by: "residency-agent", at: at2, src: [] }, incomingAuthority: "authority" });
    expect(d.action).toBe("replace");
    expect(d.fact.status).toBe("canon");
    expect(d.fact.was?.[0]).toMatchObject({ value: "a", why: "replaced" });
    expect(run({ existing: fact("a", "campus-agent"), incoming: { value: "b", by: "player", at: at2, src: [] }, incomingAuthority: "human" }).action).toBe("replace");
    const peer = run({ existing: fact("a", "campus-agent"), incoming: { value: "b", by: "job-scout", at: at2, src: ["ep-2"] } });
    expect(peer.action).toBe("dispute");
    expect(peer.fact.status).toBe("disputed");
    if (peer.action === "dispute") expect(peer.claims.map((c) => c.value)).toEqual(["a", "b"]);
  });

  it("differs, same author, newer: self-correction, the prior marked retconned", () => {
    const d = run({ existing: fact("2026-10-01", "residency-agent"), incoming: { value: "2026-10-14", by: "residency-agent", at: at2, src: ["ep-2"] }, incomingAuthority: "authority", existingAuthority: "authority" });
    expect(d.action).toBe("replace");
    expect(d.fact.value).toBe("2026-10-14");
    expect(d.fact.was?.[0]).toMatchObject({ value: "2026-10-01", why: "retconned" });
  });

  it("existing disputed: a human settles it, anyone else adds a claim", () => {
    const d = run({ existing: fact("a", "campus-agent", "disputed"), incoming: { value: "c", by: "player", at: at2, src: [] }, incomingAuthority: "human" });
    expect(d.action).toBe("replace");
    expect(d.fact.status).toBe("canon");
    expect(run({ existing: fact("a", "campus-agent", "disputed"), incoming: { value: "d", by: "job-scout", at: at2, src: [] } }).action).toBe("dispute");
  });

  it("existing disputed, held by another human of equal rank: a human adds a claim", () => {
    const d = run({ existing: fact("a", "game-master", "disputed"), incoming: { value: "c", by: "player", at: at2, src: [] }, existingAuthority: "human", incomingAuthority: "human" });
    expect(d.action).toBe("dispute");
  });

  it("two humans: the same human replaces their own value", () => {
    const d = run({ existing: fact("a", undefined), incoming: { value: "b", by: "player", at: at2, src: [] }, existingAuthority: "human", incomingAuthority: "human", sameAuthor: true });
    expect(d.action).toBe("replace");
    expect(d.fact.was?.[0]?.why).toBe("retconned");
  });

  it("two humans: the one whose domain it is wins, either way round", () => {
    const over = run({ existing: fact("a", "game-master"), incoming: { value: "b", by: "player", at: at2, src: [] }, existingAuthority: "human", incomingAuthority: "human_domain" });
    expect(over.action).toBe("replace");
    const kept = run({ existing: fact("a", "player"), incoming: { value: "b", by: "game-master", at: at2, src: [] }, existingAuthority: "human_domain", incomingAuthority: "human" });
    expect(kept.action).toBe("keep");
    expect(kept.fact.value).toBe("a");
  });

  it("two humans of equal rank dispute", () => {
    expect(run({ existing: fact("a", "game-master"), incoming: { value: "b", by: "player", at: at2, src: [] }, existingAuthority: "human", incomingAuthority: "human" }).action).toBe("dispute");
    expect(run({ existing: fact("a", "game-master"), incoming: { value: "b", by: "player", at: at2, src: [] }, existingAuthority: "human_domain", incomingAuthority: "human_domain" }).action).toBe("dispute");
  });

  it("succession, newer, rank ≥ existing: the old value is closed into `was`", () => {
    const d = run({
      def: succession,
      existing: fact("harbor-university", "job-scout"),
      incoming: { value: "migration-agency", by: "job-scout", at: at2, src: ["ep-2"], valid_from: "2026-09-15" },
    });
    expect(d.action).toBe("succeed");
    expect(d.fact).toMatchObject({ value: "migration-agency", valid_from: "2026-09-15", status: "rumor" });
    expect(d.fact.was).toEqual([{ value: "harbor-university", by: "job-scout", at: at1, valid_until: "2026-09-15", why: "succeeded" }]);
    const byAt = run({ def: succession, existing: fact("a", "campus-agent"), incoming: { value: "b", by: "residency-agent", at: at2, src: [] }, incomingAuthority: "authority" });
    expect(byAt.action).toBe("succeed");
    expect(byAt.fact.status).toBe("canon");
    expect(byAt.fact.was?.[0]?.valid_until).toBe(at2);
  });

  it("succession, newer but lower rank: the usual rules apply", () => {
    const d = run({ def: succession, existing: fact("a", "residency-agent"), incoming: { value: "b", by: "campus-agent", at: at2, src: [] }, existingAuthority: "authority" });
    expect(d.action).toBe("keep");
  });

  it("succession never closes a human-held value: an agent still disputes, the same human succeeds", () => {
    const agent = run({ def: succession, existing: fact("a", undefined), incoming: { value: "b", by: "residency-agent", at: at2, src: [] }, existingAuthority: "human", incomingAuthority: "authority" });
    expect(agent.action).toBe("dispute");
    const self = run({ def: succession, existing: fact("a", undefined), incoming: { value: "b", by: "player", at: at2, src: [] }, existingAuthority: "human", incomingAuthority: "human", sameAuthor: true });
    expect(self.action).toBe("succeed");
  });

  it("succession, older than existing: backfilled into `was`, current value kept", () => {
    const existing = { ...fact("migration-agency", "job-scout"), was: [{ value: "language-center", by: "job-scout", at: at0, valid_until: "2026-05-01" }] };
    const d = run({ def: succession, existing, incoming: { value: "harbor-university", by: "campus-agent", at: at2, src: ["ep-3"], valid_from: "2026-06-01" } });
    expect(d.action).toBe("backfill");
    expect(d.fact.value).toBe("migration-agency");
    expect(d.fact.was?.map((w) => w.value)).toEqual(["language-center", "harbor-university"]);
    expect(d.fact.was?.[1]).toMatchObject({ why: "succeeded", valid_until: at1, valid_from: "2026-06-01" });
    const again = run({ def: succession, existing: d.fact, incoming: { value: "harbor-university", by: "job-scout", at: at2, src: [], valid_from: "2026-06-01" } });
    expect(again.action).toBe("keep");
  });

  it("human_only, incoming not human: proposed, the fact untouched", () => {
    const existing = fact("a", undefined);
    const d = decide({ def: humanOnly, existing, incoming: { value: "b", by: "residency-agent", at: at2, src: ["ep-2"] }, existingAuthority: "human", incomingAuthority: "authority" });
    expect(d.action).toBe("propose");
    expect(d.fact).toBe(existing);
    if (d.action === "propose") expect(d.claim).toMatchObject({ value: "b", by: "residency-agent" });
    expect(decide({ def: humanOnly, incoming: { value: "b", by: "campus-agent", at: at2, src: [] } }).action).toBe("propose");
    expect(decide({ def: humanOnly, existing, incoming: { value: "a", by: "campus-agent", at: at2, src: [] }, existingAuthority: "human" }).action).toBe("corroborate");
    expect(decide({ def: humanOnly, existing, incoming: { value: "b", by: "player", at: at2, src: [] }, existingAuthority: "human", incomingAuthority: "human", sameAuthor: true }).action).toBe("replace");
  });

  it("caps the history when a retconned fact is recreated", () => {
    const was = Array.from({ length: 5 }, (_, i) => ({ value: `old-${i}`, by: "residency-agent", at: at1 }));
    const d = run({
      existing: { ...fact("gone", "residency-agent", "retconned"), was },
      incoming: { value: "new", by: "residency-agent", at: at2, src: ["ep-2"] },
      incomingAuthority: "authority",
    });
    expect(d.action).toBe("create");
    expect(d.fact.was).toHaveLength(5);
    expect(d.fact.was?.at(-1)?.value).toBe("gone");
  });
});

/** Two humans: `player` (primary, housing) and `game-master` (residency); a character type with qualified fields. */
const TWO_HUMANS = CONFIG.replace("human: player\n", "humans:\n  - { id: player, domains: [housing] }\n  - { id: game-master, domains: [residency], github: gm-login }\n").replace(
  "character: { folder: characters, description: People }",
  "character: { folder: characters, description: People, fields: { employer: { succession: true }, stakes: { human_only: true }, visa: { domain: residency } } }",
);
const now = () => new Date("2026-09-27T12:00:00.000Z");
const twoHumans = (extra: Record<string, string> = {}) =>
  Vault.load(fixtureStore({ "_hippo/config.yaml": TWO_HUMANS, "characters/player.md": "---\ntype: character\ntitle: Player\n---\n", ...extra }), { now });

describe("applyFact rows that need a vault", () => {
  it("different scopes never conflict: each scope is its own key", async () => {
    const v = await twoHumans();
    const pc = v.resolve("player")!;
    await applyFact(v, pc, "greeting", "Olá", { by: "campus-agent", at: at1, src: ["ep-1"] }, { scope: "lang:pt" });
    const r = await applyFact(v, pc, "greeting", "Hello", { by: "job-scout", at: at2, src: ["ep-2"] }, { scope: "Lang:EN" });
    expect(r).toMatchObject({ field: "greeting@lang:en", decision: "create" });
    await applyFact(v, pc, "greeting@lang:pt", "Olá", { by: "job-scout", at: at2, src: ["ep-3"] });
    expect(Object.keys(pc.fm.facts)).toEqual(["greeting@lang:pt", "greeting@lang:en"]);
    expect(pc.fm.facts["greeting@lang:pt"]).toMatchObject({ value: "Olá", status: "canon" });
    expect(v.openDisputes()).toEqual([]);
    await applyFact(v, pc, "greeting", "Oi", { by: "home-finder", at: at2, src: ["ep-4"] }, { scope: "lang:pt" });
    expect(v.openDisputes().map((d) => [d.slug, d.fm.field])).toEqual([["dispute-player-greeting-lang-pt", "greeting@lang:pt"]]);
  });

  it("ranks the human whose domain covers the entity or field above the other human", async () => {
    const v = await twoHumans();
    const pc = v.resolve("player")!;
    const agency = v.resolve("migration-agency")!;
    expect(v.authorityOf("game-master", agency)).toBe("human_domain");
    expect(v.authorityOf("player", agency)).toBe("human");
    expect(v.authorityOf(undefined, agency)).toBe("human");
    expect(v.authorityOf("game-master", pc, "visa")).toBe("human_domain");
    expect(v.authorityOf("residency-agent", pc, "visa@country:pt")).toBe("authority");
    expect(v.authorityOf("residency-agent", pc, "employer")).toBe("none");

    await applyFact(v, agency, "office", "Alfama", { by: "player", at: at1, src: ["ep-1"] });
    expect((await applyFact(v, agency, "office", "Belém", { by: "game-master", at: at2, src: ["ep-2"] })).decision).toBe("replace");
    expect((await applyFact(v, agency, "office", "Baixa", { by: "player", at: at2, src: ["ep-3"] })).decision).toBe("keep");
    await applyFact(v, pc, "nickname", "Jo", { by: "player", at: at1, src: ["ep-4"] });
    expect((await applyFact(v, pc, "nickname", "Jojo", { by: "game-master", at: at2, src: ["ep-5"] })).decision).toBe("dispute");
  });

  it("succession and human_only fields come from the type's field definitions", async () => {
    const v = await twoHumans();
    const pc = v.resolve("player")!;
    await applyFact(v, pc, "employer", "Harbor University", { by: "job-scout", at: at1, src: ["ep-1"] });
    const r = await applyFact(v, pc, "employer", "Migration Agency", { by: "job-scout", at: at2, src: ["ep-2"] }, { validFrom: "2026-09-15" });
    expect(r.decision).toBe("succeed");
    expect(pc.fm.facts.employer?.was?.[0]).toMatchObject({ value: "Harbor University", valid_until: "2026-09-15", why: "succeeded" });

    const p = await applyFact(v, pc, "stakes", "high", { by: "residency-agent", at: at2, src: ["ep-3"] });
    expect(p.decision).toBe("propose");
    expect(pc.fm.facts.stakes).toBeUndefined();
    expect(v.disputes.get("proposal-player-stakes")?.fm).toMatchObject({ kind: "proposal", state: "pending", status: "open", claims: [{ value: "high", by: "residency-agent" }] });
    expect((await applyFact(v, pc, "stakes", "high", { by: "game-master", at: at2, src: ["ep-4"] })).decision).toBe("create");
  });

  it("stores confidential and confidence qualifiers on the fact", async () => {
    const v = await twoHumans();
    const pc = v.resolve("player")!;
    await applyFact(v, pc, "phone", "+351 900 000 003", { by: "player", at: at1, src: ["ep-1"] }, { confidential: true, confidence: 0.9, validUntil: "2027-01-01" });
    expect(pc.fm.facts.phone).toMatchObject({ confidential: true, confidence: 0.9, valid_until: "2027-01-01" });
  });
});
