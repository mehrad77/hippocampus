import { describe, expect, it } from "vitest";
import { ScriptedLLM } from "../llm.ts";
import { CASES } from "./cases.ts";
import { caseFiles, runCase } from "./harness.ts";
import { scoreCase } from "./score.ts";
import { recommend, standings } from "./compare.ts";
import type { EvalRun } from "./run.ts";

const byId = (id: string) => CASES.find((c) => c.id === id)!;

/** A curator that answers `claims` with `facts`, the other steps as a careful curator would. */
function curator(mention: { name: string; type: string }, match: string, facts: { entity: string; field: string; value: string; secret: boolean }[]) {
  return new ScriptedLLM()
    .respond("mentions", () => ({ entities: [{ ...mention, aliases: [], domains: [] }] }))
    .respond("match", () => ({ match }))
    .respond("claims", () => ({ facts, relations: [], goals: [] }))
    .respond("summary", () => ({ summary: "A note about the move to [[lisbon]]." }));
}

describe("the curator eval's scorer", () => {
  it("gives a careful night full marks, and a night that keeps the annotation less", async () => {
    const c = byId("annotation-date");
    const good = await scoreCase(c, await runCase(c, curator({ name: "Migration Agency", type: "faction" }, "migration-agency", [{ entity: "migration-agency", field: "appointment_date", value: "2026-03-14", secret: false }])));
    expect(good).toMatchObject({ mentions: 1, match: 1, claims: 1, falseDisputes: 0, gates: { secretRecall: true, noLeak: true }, failed: [] });
    expect(good.endToEnd).toBe(1);
    expect(good.fieldReuse).toBe(1);

    const sloppy = await scoreCase(
      c,
      await runCase(c, curator({ name: "Migration Agency", type: "faction" }, "migration-agency", [{ entity: "migration-agency", field: "appointment", value: "2026-03-14 (confirmed by phone)", secret: false }])),
    );
    expect(sloppy.claims!).toBeLessThan(1);
    expect(sloppy.endToEnd).toBeLessThan(good.endToEnd);
  });

  it("fails the secret gate when an ID isn't flagged, and passes it when it is", async () => {
    const c = byId("secret-passport");
    const flagged = await scoreCase(c, await runCase(c, curator({ name: "Passport", type: "item" }, "new", [{ entity: "passport", field: "number", value: "X98765432", secret: true }])));
    expect(flagged.gates).toEqual({ secretRecall: true, noLeak: true });
    const careless = await scoreCase(c, await runCase(c, curator({ name: "Passport", type: "item" }, "new", [{ entity: "passport", field: "number", value: "X98765432", secret: false }])));
    expect(careless.gates.secretRecall).toBe(false);
  });

  it("doesn't count a mention the gold allows against precision, but still counts an unexpected one", async () => {
    const c = byId("secret-passport");
    const twoMentions = (extra: { name: string; type: string }) =>
      new ScriptedLLM()
        .respond("mentions", () => ({ entities: [{ name: "Passport", type: "item", aliases: [], domains: [] }, { ...extra, aliases: [], domains: [] }] }))
        .respond("match", (req) => ({ match: req.prompt.includes("Player") ? "player" : "new" }))
        .respond("claims", () => ({ facts: [{ entity: "passport", field: "number", value: "X98765432", secret: true }], relations: [], goals: [] }))
        .respond("summary", () => ({ summary: "A note about the move to [[lisbon]]." }));
    const allowed = await scoreCase(c, await runCase(c, twoMentions({ name: "Player", type: "character" })));
    expect(allowed.mentions).toBe(1);
    const stray = await scoreCase(c, await runCase(c, twoMentions({ name: "Agency desk", type: "location" })));
    expect(stray.mentions!).toBeLessThan(1);
  });

  it("lets a confidential fact keep its value in its note, and fails the gate when a note is named after it", async () => {
    const c = byId("confidential-health");
    const night = (entities: { name: string; type: string }[], facts: object[]) =>
      new ScriptedLLM()
        .respond("mentions", () => ({ entities: entities.map((e) => ({ ...e, aliases: [], domains: [] })) }))
        .respond("match", () => ({ match: "new" }))
        .respond("claims", () => ({ facts, relations: [], goals: [] }))
        .respond("summary", () => ({ summary: "An insurer in [[lisbon]]." }));
    const kept = await scoreCase(c, await runCase(c, night([{ name: "Lisbon Care", type: "faction" }], [{ entity: "lisbon-care", field: "covers", value: "knee therapy plan", secret: false, confidential: true }])));
    expect(kept.gates.noLeak).toBe(true);
    const named = await scoreCase(
      c,
      await runCase(c, night([{ name: "Lisbon Care", type: "faction" }, { name: "Knee therapy plan", type: "item" }], [])),
    );
    expect(named.gates.noLeak).toBe(false);
    expect(named.failed).toContain("hidden value in items/knee-therapy-plan.md");
  });

  it("credits a fact that lands on a note the gold allows instead", async () => {
    const c = byId("goal-progress");
    const s = await scoreCase(c, await runCase(c, curator({ name: "Residence permit", type: "goal" }, "residence-permit", [{ entity: "residence-permit", field: "appointment_date", value: "2026-04-02T10:30", secret: false }])));
    expect(s.claims).toBe(1);
  });

  it("builds every case's vault from the seed, with its notes and inbox", async () => {
    for (const c of CASES) {
      const files = await caseFiles(c);
      expect(Object.keys(files).filter((p) => p.startsWith("inbox/") && !p.endsWith("README.md")), c.id).toHaveLength(c.episodes.length);
      expect(files["_hippo/config.yaml"], c.id).not.toContain("recipient: null");
    }
  });
});

describe("the recommended mix", () => {
  const run = (model: string, step: Partial<Record<"mentions" | "match" | "claims" | "summary", number>>, micros: number, gatesOk = true): EvalRun => ({
    label: model,
    at: "2026-11-16T00:00:00Z",
    provider: "mistral",
    mix: { mentions: model, match: model, claims: model, summary: model },
    promptVersion: "p1",
    gitRef: "abc",
    results: [
      {
        case: "x",
        repeat: 0,
        score: { case: "x", ...step, endToEnd: 0.9, falseDisputes: 0, schemaValid: { mentions: 1, match: 1, claims: 1, summary: 1 }, gates: { secretRecall: true, noLeak: gatesOk }, failed: [] },
        micros: { mentions: micros, match: micros, claims: micros, summary: micros },
        ms: {},
        calls: { mentions: 1, match: 1, claims: 1, summary: 1 },
      },
    ],
  });

  // A leak rules a model out of the steps that write names and summaries; match writes neither.
  it("takes the cheapest model within the margin per step, and never one that fails that step's gate", () => {
    const runs = [run("small", { mentions: 0.95, match: 0.9, claims: 0.7, summary: 0.98 }, 100), run("large", { mentions: 0.96, match: 0.95, claims: 0.95, summary: 0.99 }, 1_000), run("cheap-leaky", { mentions: 1, match: 1, claims: 1, summary: 1 }, 1, false)];
    const mix = recommend(standings(runs), 0.03);
    expect(mix).toEqual({ mentions: "small", match: "cheap-leaky", claims: "large", summary: "small" });
  });
});
