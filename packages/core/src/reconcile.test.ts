import { describe, expect, it } from "vitest";
import { reconcileFact, type ReconcileInput } from "./reconcile.ts";
import type { Fact } from "./schema.ts";

const at1 = "2026-09-01T10:00:00.000Z";
const at2 = "2026-09-20T10:00:00.000Z";
const fact = (value: string, by: string | undefined, status: Fact["status"] = "canon", at = at1): Fact => ({ value, by, status, at, src: ["ep-1"] });
const run = (over: Partial<ReconcileInput> & Pick<ReconcileInput, "incoming">) =>
  reconcileFact({ incomingAuthority: "none", existingAuthority: "none", canonThreshold: 2, ...over });

describe("reconcileFact", () => {
  it("creates rumor from non-authority, canon from authority", () => {
    expect(run({ incoming: { value: "x", by: "campus-agent", at: at2, src: ["ep-2"] } }).fact.status).toBe("rumor");
    expect(run({ incoming: { value: "x", by: "residency-agent", at: at2, src: ["ep-2"] }, incomingAuthority: "authority" }).fact.status).toBe("canon");
  });

  it("promotes a rumor when a second agent corroborates", () => {
    const d = run({ existing: fact("x", "campus-agent", "rumor"), incoming: { value: "X ", by: "job-scout", at: at2, src: ["ep-2"] } });
    expect(d.action).toBe("corroborate");
    expect(d.fact.status).toBe("canon");
    expect(d.fact.src).toEqual(["ep-1", "ep-2"]);
    expect(d.fact.seen_by).toBeUndefined();
  });

  it("does not promote when the same agent repeats itself", () => {
    const d = run({ existing: fact("x", "campus-agent", "rumor"), incoming: { value: "x", by: "campus-agent", at: at2, src: ["ep-2"] } });
    expect(d.fact.status).toBe("rumor");
  });

  it("lets a source correct its own report", () => {
    const d = run({ existing: fact("2026-10-01", "residency-agent"), incoming: { value: "2026-10-14", by: "residency-agent", at: at2, src: ["ep-2"] }, incomingAuthority: "authority", existingAuthority: "authority" });
    expect(d.action).toBe("replace");
    expect(d.fact.value).toBe("2026-10-14");
    expect(d.fact.was?.[0]?.value).toBe("2026-10-01");
  });

  it("authority overrides a non-authority value", () => {
    const d = run({ existing: fact("a", "campus-agent", "rumor"), incoming: { value: "b", by: "residency-agent", at: at2, src: [] }, incomingAuthority: "authority" });
    expect(d.action).toBe("replace");
    expect(d.fact.status).toBe("canon");
  });

  it("keeps authority value against a non-authority contradiction", () => {
    const d = run({ existing: fact("a", "residency-agent"), incoming: { value: "b", by: "campus-agent", at: at2, src: [] }, existingAuthority: "authority" });
    expect(d.action).toBe("keep");
    expect(d.fact.value).toBe("a");
  });

  it("disputes when two peers disagree", () => {
    const d = run({ existing: fact("a", "campus-agent"), incoming: { value: "b", by: "job-scout", at: at2, src: ["ep-2"] } });
    expect(d.action).toBe("dispute");
    expect(d.fact.status).toBe("disputed");
    if (d.action === "dispute") expect(d.claims.map((c) => c.value)).toEqual(["a", "b"]);
  });

  it("disputes when an agent contradicts the human", () => {
    const d = run({ existing: fact("a", undefined), incoming: { value: "b", by: "residency-agent", at: at2, src: [] }, existingAuthority: "human", incomingAuthority: "authority" });
    expect(d.action).toBe("dispute");
  });

  it("human always wins, including over disputes", () => {
    const d = run({ existing: fact("a", "campus-agent", "disputed"), incoming: { value: "c", by: "player", at: at2, src: [] }, incomingAuthority: "human" });
    expect(d.action).toBe("replace");
    expect(d.fact.status).toBe("canon");
  });

  it("adds claims to an open dispute", () => {
    const d = run({ existing: fact("a", "campus-agent", "disputed"), incoming: { value: "d", by: "job-scout", at: at2, src: [] } });
    expect(d.action).toBe("dispute");
  });
});
