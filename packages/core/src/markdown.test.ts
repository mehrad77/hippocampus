import { describe, expect, it } from "vitest";
import { getRegion, humanText, parseDoc, renderDoc, setRegion } from "./markdown.ts";
import { parseLinks, unwrapLink } from "./wikilink.ts";
import { fold, slugify } from "./text.ts";

describe("managed regions", () => {
  const body = "Intro by human.\n\n%% hippo:begin facts %%\nold\n%% hippo:end facts %%\n\n## Notes\nKeep me.\n";

  it("replaces region content and leaves prose byte-identical", () => {
    const next = setRegion(body, "facts", "new");
    expect(getRegion(next, "facts")).toBe("new");
    expect(next.startsWith("Intro by human.\n\n")).toBe(true);
    expect(next.endsWith("\n\n## Notes\nKeep me.\n")).toBe(true);
  });

  it("inserts new regions after the last region", () => {
    const next = setRegion(body, "relations", "- a:: [[b]]");
    expect(next.indexOf("hippo:begin relations")).toBeGreaterThan(next.indexOf("hippo:end facts"));
    expect(next.indexOf("hippo:begin relations")).toBeLessThan(next.indexOf("## Notes"));
  });

  it("inserts at top when there are no regions", () => {
    expect(setRegion("## Notes\nx\n", "summary", "S")).toBe("%% hippo:begin summary %%\nS\n%% hippo:end summary %%\n\n## Notes\nx\n");
  });

  it("humanText strips regions", () => {
    expect(humanText(body)).toBe("Intro by human.\n\n\n\n## Notes\nKeep me.");
  });
});

describe("frontmatter", () => {
  it("round-trips and keeps ISO dates as strings", () => {
    const doc = parseDoc("---\ndeadline: 2026-11-30\ntags: [a]\n---\nbody\n");
    expect(doc.data.deadline).toBe("2026-11-30");
    expect(renderDoc(doc.data, doc.body)).toBe("---\ndeadline: 2026-11-30\ntags:\n  - a\n---\nbody\n");
  });
});

describe("text helpers", () => {
  it("folds Turkish characters", () => {
    expect(fold("Çağlayan İğne ŞIK ığ")).toBe("caglayan igne sik ig");
    expect(slugify("Çarşı Öğrenci (Şişli)")).toBe("carsi-ogrenci-sisli");
    expect(slugify("Agência de Migração")).toBe("agencia-de-migracao");
  });

  it("parses wikilinks", () => {
    expect(parseLinks("see [[a|A]] and [[b#h]]")).toEqual([
      { target: "a", alias: "A", heading: undefined },
      { target: "b", heading: "h", alias: undefined },
    ]);
    expect(unwrapLink("[[residence-permit|the quest]]")).toBe("residence-permit");
    expect(unwrapLink("plain")).toBe("plain");
  });
});
