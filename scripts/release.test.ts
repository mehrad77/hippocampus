import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { bumpType, nextVersion } from "./release.mjs";

describe("release versioning", () => {
  it("derives the bump from conventional commits", () => {
    expect(bumpType(["fix: a", "docs: b"])).toBe("patch");
    expect(bumpType(["fix: a", "feat(cli): b"])).toBe("minor");
    expect(bumpType(["feat!: drop v0 vaults"])).toBe("major");
    expect(bumpType(["refactor: x\n\nBREAKING CHANGE: new config key"])).toBe("major");
    expect(bumpType(["Merge pull request #3 from x/y\n\nfeat: add migrate"])).toBe("minor");
    expect(bumpType(["chore: deps"])).toBe("patch");
  });

  it("computes the next version, keeping breaking changes minor before 1.0", () => {
    expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(nextVersion("0.1.3", "minor")).toBe("0.2.0");
    expect(nextVersion("0.4.2", "major")).toBe("0.5.0");
    expect(nextVersion("1.4.2", "major")).toBe("2.0.0");
  });
});
