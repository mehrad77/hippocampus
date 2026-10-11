import { describe, expect, it } from "vitest";
import { initRequest } from "./onboarding.ts";

const BASE = { repoId: 9001, timezone: "Europe/Lisbon", domains: ["Residency", "housing"] };

describe("initRequest", () => {
  it("takes the older campaign and human, and links the signed-in login to that human", () => {
    expect(initRequest({ ...BASE, campaign: " Lisbon relocation ", human: "Player" }, "player")).toEqual({
      repoId: 9001,
      campaign: "Lisbon relocation",
      humans: [{ id: "player", github: "player" }],
      timezone: "Europe/Lisbon",
      domains: ["residency", "housing"],
    });
  });

  it("takes name and humans, keeping a github: the request already gives", () => {
    const humans = [{ id: "player", domains: ["housing"] }, { id: "game-master", github: "game-master" }];
    expect(initRequest({ ...BASE, name: "Harbor term", humans, presets: [] }, "player")).toMatchObject({
      campaign: "Harbor term",
      humans: [{ id: "player", domains: ["housing"] }, { id: "game-master", github: "game-master" }],
    });
    expect(initRequest({ ...BASE, name: "Harbor term", humans: ["player"] }, "player").humans).toEqual([{ id: "player", github: "player" }]);
    expect(initRequest({ ...BASE, name: "Harbor term", humans: ["player"] }).humans).toEqual([{ id: "player" }]);
  });

  it("refuses what would make an unusable vault", () => {
    const bad = (body: Record<string, unknown>) => () => initRequest({ ...BASE, name: "Harbor term", human: "player", ...body });
    expect(bad({ name: "", campaign: undefined })).toThrow(/name/);
    expect(bad({ human: undefined })).toThrow(/human/);
    expect(bad({ humans: [] })).toThrow(/humans/);
    expect(bad({ humans: ["player", "Player"] })).toThrow(/each id once/);
    expect(bad({ humans: [{ id: "player", github: "not a login" }] })).toThrow(/GitHub login/);
    expect(bad({ presets: ["pirates"] })).toThrow(/presets: "pirates" isn't one; choose from business, developer/);
    expect(bad({ presets: "people" })).toThrow(/presets/);
    expect(bad({ presets: ["constructor"] })).toThrow(/presets: "constructor" isn't one/);
    expect(bad({ seed: "toString" })).toThrow(/seed/);
  });

  it("takes bundled presets, each once", () => {
    expect(initRequest({ ...BASE, name: "Harbor term", human: "player", presets: ["people", "developer", "people"] }).presets).toEqual(["people", "developer"]);
    expect(initRequest({ ...BASE, name: "Harbor term", human: "player", presets: [] }).presets).toBeUndefined();
  });
});
