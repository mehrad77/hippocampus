import { describe, expect, it } from "vitest";
import { ApiError } from "./api.ts";
import { needsUpgrade, upgradeSummary } from "./upgrade.ts";

describe("vault upgrade", () => {
  it("recognizes the hosted app's upgrade-needed answer, and nothing else", () => {
    expect(needsUpgrade(new ApiError(409, "older format", "VAULT_UPGRADE_NEEDED"))).toBe(true);
    expect(needsUpgrade(new ApiError(409, "changed", "CONFLICT"))).toBe(false);
    expect(needsUpgrade(new Error("VAULT_UPGRADE_NEEDED"))).toBe(false);
    expect(needsUpgrade(undefined)).toBe(false);
  });

  it("says what the upgrade did", () => {
    expect(upgradeSummary({ upgraded: true, from: 1, to: 2, changed: 1, notes: [] })).toBe("Upgraded the vault from format v1 to v2 (1 file changed, in one commit).");
    expect(upgradeSummary({ upgraded: true, from: 1, to: 2, changed: 7, notes: [] })).toContain("7 files");
    expect(upgradeSummary({ upgraded: false, from: 2, to: 2, changed: 0, notes: [] })).toBe("The vault was already in the current format.");
  });
});
