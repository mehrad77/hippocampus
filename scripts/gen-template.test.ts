import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { OUT, collect, render } from "./gen-template.mjs";

describe("bundled vault template", () => {
  it("matches vault-template/, seeds/ and presets/", () => {
    const committed = readFileSync(join(import.meta.dirname, "..", OUT), "utf8");
    expect(committed === render(), `${OUT} is stale: run pnpm gen:template`).toBe(true);
  });

  it("holds the template as a vault would get it, and only public seeds", () => {
    const { template, seeds, presets } = collect() as { template: Record<string, string>; seeds: Record<string, unknown>; presets: Record<string, Record<string, string>> };
    for (const path of [".gitignore", "_hippo/config.yaml", "_hippo/curator.md", "AGENTS.md", ".github/workflows/validate.yml"]) expect(template, path).toHaveProperty([path]);
    expect(Object.keys(seeds)).toContain("example-relocation");
    expect(Object.keys(seeds).filter((s) => s.startsWith("private-"))).toEqual([]);
    expect(Object.keys(presets)).toEqual(["business", "developer", "household", "people", "student"]);
    for (const files of Object.values(presets)) expect(files).toHaveProperty(["preset.yaml"]);
  });
});
