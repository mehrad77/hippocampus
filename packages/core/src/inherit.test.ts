import { describe, expect, it } from "vitest";
import { managedStore } from "./__fixtures__/managed.ts";
import { meshCadence, resolveInheritance } from "./inherit.ts";
import { parseDuration } from "./text.ts";
import { Vault } from "./vault.ts";

const now = () => new Date("2026-09-27T12:00:00.000Z");
const note = (fm: string) => `---\n${fm}\n---\n`;

const ARCHETYPES = {
  "archetypes/stranger.md": note("type: archetype\ncadence: none\ndefaults: { register: formal, language: en }\nguidelines:\n  - { rule: Introduce yourself first, status: canon }"),
  "archetypes/colleague.md": note('type: archetype\nextends: "[[stranger]]"\ncadence: 1m\ndefaults: { register: neutral }\nguidelines:\n  - { rule: Keep it about work, status: canon }'),
  "archetypes/close-friend.md": note("type: archetype\ncadence: 2w\ndefaults: { register: casual, emoji: true }\nguidelines:\n  - { rule: keep it about work, status: canon }\n  - { rule: Ask about the family, status: canon }"),
};
const load = (extra: Record<string, string> = {}) => Vault.load(managedStore({ ...ARCHETYPES, ...extra }), { now });

describe("parseDuration", () => {
  it("reads days, weeks, months and years", () => {
    expect(parseDuration("3d")).toBe(3);
    expect(parseDuration("2w")).toBe(14);
    expect(parseDuration("1m")).toBe(30);
    expect(parseDuration("1y")).toBe(365);
    expect(parseDuration(" 2 weeks ")).toBe(14);
    expect(parseDuration("none")).toBeUndefined();
    expect(parseDuration("weekly")).toBeUndefined();
    expect(parseDuration("0d")).toBeUndefined();
  });
});

describe("resolveInheritance", () => {
  it("follows extends, then mixins from tags naming inheritable notes; the child wins", async () => {
    const v = await load({
      "characters/landlord.md": note('type: character\ntitle: The landlord\nextends: "[[colleague]]"\ntags: [close-friend, residency, stranger]\ndefaults: { language: pt }\nguidelines:\n  - { rule: Write in Portuguese, scope: "lang:pt", status: canon }'),
    });
    const r = resolveInheritance(v, v.resolve("landlord")!);
    expect(r.chain.map((e) => e.slug)).toEqual(["colleague", "stranger"]);
    // `stranger` is already in the chain; `residency` names no note.
    expect(r.mixins.map((e) => e.slug)).toEqual(["close-friend"]);
    expect(r.defaults).toEqual({ register: "neutral", language: "pt", emoji: true });
    expect(r.guidelines.map((g) => [g.rule, g.source])).toEqual([
      ["Write in Portuguese", "landlord"],
      ["Keep it about work", "colleague"],
      ["Introduce yourself first", "stranger"],
      ["Ask about the family", "close-friend"],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("ignores tags naming notes of a type that isn't inheritable", async () => {
    const v = await load({ "characters/landlord.md": note("type: character\ntags: [migration-agency]") });
    expect(resolveInheritance(v, v.resolve("landlord")!).mixins).toEqual([]);
  });

  it("stops at three ancestors and at cycles, with warnings", async () => {
    const chain = {
      "archetypes/a1.md": note('type: archetype\nextends: "[[a2]]"'),
      "archetypes/a2.md": note('type: archetype\nextends: "[[a3]]"'),
      "archetypes/a3.md": note('type: archetype\nextends: "[[a4]]"'),
      "archetypes/a4.md": note("type: archetype\ndefaults: { deep: true }"),
      "archetypes/c1.md": note('type: archetype\nextends: "[[c2]]"'),
      "archetypes/c2.md": note('type: archetype\nextends: "[[c1]]"'),
      "characters/deep.md": note('type: character\nextends: "[[a1]]"'),
      "characters/loop.md": note('type: character\nextends: "[[c1]]"'),
      "characters/lost.md": note('type: character\nextends: "[[nobody]]"'),
    };
    const v = await load(chain);
    const deep = resolveInheritance(v, v.resolve("deep")!);
    expect(deep.chain.map((e) => e.slug)).toEqual(["a1", "a2", "a3"]);
    expect(deep.defaults).toEqual({});
    expect(deep.warnings[0]).toMatch(/deeper than 3/);
    const loop = resolveInheritance(v, v.resolve("loop")!);
    expect(loop.chain.map((e) => e.slug)).toEqual(["c1", "c2"]);
    expect(loop.warnings[0]).toMatch(/cycle at c1/);
    expect(resolveInheritance(v, v.resolve("lost")!).warnings[0]).toMatch(/doesn't exist/);
  });

  it("meshes cadence: own value, else any none, else the most common, the shortest on a tie", async () => {
    const groups = {
      "groups/study-group.md": note("type: group\ncadence: 2w"),
      "groups/book-club.md": note("type: group\ncadence: 2w"),
      "groups/quiet-club.md": note("type: group\ncadence: none"),
    };
    const v = await load({
      ...groups,
      "characters/own.md": note('type: character\ncadence: 3d\nextends: "[[stranger]]"'),
      "characters/colleague-only.md": note('type: character\nextends: "[[colleague]]"\ntags: [close-friend]'),
      "characters/friend.md": note('type: character\ntags: [close-friend]\nrelations:\n  - { rel: member_of, target: "[[study-group]]" }\n  - { rel: member_of, target: "[[book-club]]" }'),
      "characters/quiet.md": note('type: character\ntags: [close-friend]\nrelations:\n  - { rel: member_of, target: "[[quiet-club]]" }'),
      "characters/plain.md": note("type: character"),
    });
    const cadence = (slug: string) => resolveInheritance(v, v.resolve(slug)!).cadence;
    expect(cadence("own")).toBe("3d");
    // The chain reaches `stranger` (none).
    expect(cadence("colleague-only")).toBe("none");
    expect(cadence("friend")).toBe("2w");
    expect(cadence("quiet")).toBe("none");
    expect(cadence("plain")).toBeUndefined();
    expect(meshCadence(undefined, ["1m", "2w"])).toBe("2w");
    expect(meshCadence(undefined, ["1m", "1m", "2w"])).toBe("1m");
    const warnings: string[] = [];
    expect(meshCadence(undefined, ["weekly", "1m"], warnings)).toBe("1m");
    expect(warnings[0]).toMatch(/weekly/);
  });
});
