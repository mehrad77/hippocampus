import { describe, expect, it } from "vitest";
import { actorClaims, actorFor, type Principal } from "./audited-store.ts";

const msg = (...trailers: string[]) => `remember(home-finder): ep-1\n\n${trailers.join("\n")}`;
const agentKey: Principal = { kind: "agent", scopes: ["read", "remember"] };
const bound: Principal = { kind: "agent", agent: "home-finder", scopes: ["read", "remember"] };

describe("actor claims", () => {
  it("reads Hippo-Actor from the trailer paragraph only", () => {
    expect(actorClaims(msg("Hippo-Actor: agent:home-finder"))).toEqual(["agent:home-finder"]);
    expect(actorClaims("Hippo-Actor: human")).toEqual([]);
    expect(actorClaims("subject\n\nHippo-Actor: human\n\nmore prose")).toEqual([]);
    expect(actorClaims(msg("Hippo-Actor: curator", "Hippo-Actor: curator", "Hippo-Run: run-1"))).toEqual(["curator"]);
  });

  it("audits a commit as the actor its principal may claim", () => {
    expect(actorFor(msg("Hippo-Actor: agent:home-finder"), agentKey)).toEqual({ kind: "agent", id: "home-finder", scopes: ["read", "remember"] });
    expect(actorFor(msg("Hippo-Actor: agent:home-finder"), bound)).toEqual({ kind: "agent", id: "home-finder", scopes: ["read", "remember"] });
    expect(actorFor(msg("Hippo-Actor: human"), { kind: "human" })).toEqual({ kind: "human" });
    expect(actorFor(msg("Hippo-Actor: curator"), { kind: "curator" })).toEqual({ kind: "curator" });
  });

  it("refuses commits with no claim, several, an unknown one, or one the principal can't make", () => {
    const rule = (message: string, p: Principal) => (actorFor(message, p) as { rule?: string }).rule;
    expect(rule("remember: ep-1", agentKey)).toBe("missing Hippo-Actor trailer");
    expect(rule(msg("Hippo-Actor: human", "Hippo-Actor: curator"), { kind: "human" })).toBe("conflicting Hippo-Actor trailers");
    expect(rule(msg("Hippo-Actor: player"), { kind: "human" })).toBe("unknown Hippo-Actor trailer");
    expect(rule(msg("Hippo-Actor: agent:residency-agent"), bound)).toBe("this key is bound to another agent");
    expect(rule(msg("Hippo-Actor: human"), agentKey)).toBe("agent may not commit as human");
    expect(rule(msg("Hippo-Actor: curator"), agentKey)).toBe("agent may not commit as curator");
    expect(rule(msg("Hippo-Actor: bootstrap"), { kind: "human" })).toBe("human may not commit as bootstrap");
    expect(rule(msg("Hippo-Actor: agent:home-finder"), { kind: "curator" })).toBe("curator may not commit as agent");
  });
});
