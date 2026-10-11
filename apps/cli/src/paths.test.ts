import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assetCandidates, assetRoot } from "./paths.ts";

describe("assetRoot", () => {
  it("prefers the package next to the bundle when published", () => {
    expect(assetCandidates("/pkg/dist")).toEqual(["/pkg", "/"]);
  });

  it("prefers the repo root from source, so a stale apps/cli/vault-template can't shadow it", () => {
    expect(assetCandidates("/repo/apps/cli/src")).toEqual(["/repo", "/repo/apps/cli"]);
  });

  it("finds the repo's own vault-template from source", () => {
    const repo = resolve(import.meta.dirname, "../../..");
    expect(assetRoot()).toBe(repo);
    expect(existsSync(join(assetRoot(), "vault-template"))).toBe(true);
  });
});
