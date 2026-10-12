import { describe, expect, it } from "vitest";
import { initRequest } from "./onboarding.ts";

const BASE = { repoId: 9001, timezone: "Europe/Lisbon", domains: ["Residency", "housing"] };

/** A request for a new vault, narrowed so its settings can be read. */
const newVault = (body: unknown, login?: string) => {
  const req = initRequest(body, login);
  if (req.adopt) throw new Error("expected a new vault, got adopt");
  return req;
};

describe("initRequest", () => {
  it("takes the older campaign and human, and links the signed-in login to that human", () => {
    expect(initRequest({ ...BASE, campaign: " Lisbon relocation ", human: "Player" }, "player")).toEqual({
      repoId: 9001,
      provider: "github",
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
    expect(newVault({ ...BASE, name: "Harbor term", humans: ["player"] }, "player").humans).toEqual([{ id: "player", github: "player" }]);
    expect(newVault({ ...BASE, name: "Harbor term", humans: ["player"] }).humans).toEqual([{ id: "player" }]);
  });

  it("refuses what would make an unusable vault", () => {
    const bad = (body: Record<string, unknown>) => () => initRequest({ ...BASE, name: "Harbor term", human: "player", ...body });
    expect(bad({ name: "", campaign: undefined })).toThrow(/name/);
    expect(bad({ human: undefined })).toThrow(/human/);
    expect(bad({ humans: [] })).toThrow(/humans/);
    expect(bad({ humans: ["player", "Player"] })).toThrow(/each id once/);
    expect(bad({ humans: [{ id: "player", github: "not a login" }] })).toThrow(/GitHub login/);
    expect(bad({ humans: [{ id: "player", gitlab: "-not.a.login" }] })).toThrow(/GitLab username/);
    expect(newVault({ ...BASE, name: "Harbor term", humans: [{ id: "player", gitlab: "player.gl" }] }).humans).toEqual([{ id: "player", gitlab: "player.gl" }]);
    expect(bad({ presets: ["pirates"] })).toThrow(/presets: "pirates" isn't one; choose from business, developer/);
    expect(bad({ presets: "people" })).toThrow(/presets/);
    expect(bad({ presets: ["constructor"] })).toThrow(/presets: "constructor" isn't one/);
    expect(bad({ seed: "toString" })).toThrow(/seed/);
  });

  it("takes just the repo to reconnect a vault that exists: its own config holds the rest", () => {
    expect(initRequest({ repoId: 9001, adopt: true }, "player")).toEqual({ repoId: 9001, provider: "github", adopt: true });
    expect(initRequest({ repoId: 9001, adopt: true, provider: "gitlab" }).provider).toBe("gitlab");
    const bad = (body: Record<string, unknown>) => () => initRequest({ repoId: 9001, adopt: true, ...body });
    expect(bad({ adopt: "yes" })).toThrow(/adopt/);
    expect(bad({ seed: "example-relocation" })).toThrow(/no seed or presets/);
    expect(bad({ presets: ["people"] })).toThrow(/no seed or presets/);
    expect(bad({ presets: "people" })).toThrow(/presets/);
    expect(bad({ recipient: "nope" })).toThrow(/recipient/);
    expect(initRequest({ repoId: 9001, adopt: true, presets: [] }).adopt).toBe(true);
    // Without adopt, the form is still required.
    expect(() => initRequest({ repoId: 9001 })).toThrow(/name/);
  });

  it("takes bundled presets, each once", () => {
    expect(newVault({ ...BASE, name: "Harbor term", human: "player", presets: ["people", "developer", "people"] }).presets).toEqual(["people", "developer"]);
    expect(newVault({ ...BASE, name: "Harbor term", human: "player", presets: [] }).presets).toBeUndefined();
  });
});
