import { describe, expect, it } from "vitest";
import { boundAgent } from "./serve.ts";

describe("boundAgent", () => {
  const humans = ["player", "game-master"];

  it("binds the agent the URL names, else the --agent default", () => {
    expect(boundAgent(humans, "home-finder", "campus-agent")).toEqual({ agent: "home-finder" });
    expect(boundAgent(humans, null, "campus-agent")).toEqual({ agent: "campus-agent" });
    expect(boundAgent(humans, null)).toEqual({});
    expect(boundAgent(humans, "  ")).toEqual({});
  });

  it("refuses a human, whatever the case, from the URL or the default", () => {
    expect(boundAgent(humans, "player")).toMatchObject({ refused: expect.stringContaining('"player" is a human') });
    expect(boundAgent(humans, "Game-Master")).toMatchObject({ refused: expect.any(String) });
    expect(boundAgent(humans, null, "player")).toMatchObject({ refused: expect.any(String) });
  });

  it("binds nobody when the config doesn't load", () => {
    expect(boundAgent(undefined, "home-finder")).toMatchObject({ refused: expect.stringContaining("doesn't load") });
    expect(boundAgent(undefined, null)).toEqual({});
  });
});
