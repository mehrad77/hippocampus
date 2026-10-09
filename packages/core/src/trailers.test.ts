import { describe, expect, it } from "vitest";
import { actorTrailer, parseActorTrailer, withTrailers } from "./trailers.ts";

describe("commit trailers", () => {
  it("go in a final paragraph of their own, one line each", () => {
    expect(withTrailers("remember(residency-agent): ep-1", { "Hippo-Actor": "agent:residency-agent" })).toBe("remember(residency-agent): ep-1\n\nHippo-Actor: agent:residency-agent");
    expect(withTrailers("chore(sleep): consolidate 2 episodes\n\n- ep-1\n\nmodel: local\n", { "Hippo-Actor": "curator", "Hippo-Model": "lmstudio:\nqwen" })).toBe(
      "chore(sleep): consolidate 2 episodes\n\n- ep-1\n\nmodel: local\n\nHippo-Actor: curator\nHippo-Model: lmstudio: qwen",
    );
    expect(withTrailers("subject", { "Hippo-Model": undefined, "Hippo-Actor": " " })).toBe("subject");
    expect(() => withTrailers("subject", { "Hippo Actor": "human" })).toThrow(/invalid trailer key/);
  });

  it("aren't repeated when the message already ends with them", () => {
    const once = withTrailers("party(player): add job-scout", { "Hippo-Actor": "human" });
    expect(withTrailers(once, { "Hippo-Actor": "human" })).toBe(once);
  });

  it("name an actor and parse back", () => {
    for (const actor of [{ kind: "curator" }, { kind: "human" }, { kind: "bootstrap" }, { kind: "agent", id: "job-scout" }] as const) {
      expect(parseActorTrailer(actorTrailer(actor))).toEqual(actor);
    }
    expect(parseActorTrailer(" agent: job-scout ")).toEqual({ kind: "agent", id: "job-scout" });
    expect(parseActorTrailer("gremlin")).toBeUndefined();
    expect(parseActorTrailer("agent:")).toBeUndefined();
  });
});
