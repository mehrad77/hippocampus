import { describe, expect, it } from "vitest";
import { VAULT_HEADER as SERVER_HEADER } from "@hippocampus/dashboard";
import { VAULT_HEADER, vaultFromSearch, withoutVaultParam } from "./vault.ts";

describe("the tab's vault", () => {
  it("names the same header as the server", () => {
    expect(VAULT_HEADER).toBe(SERVER_HEADER);
  });

  it("reads a vault id from the address, and nothing that isn't one", () => {
    expect(vaultFromSearch("?vault=01J9Z8D3M0V000000000000001")).toBe("01J9Z8D3M0V000000000000001");
    expect(vaultFromSearch("?vault=01j9z8d3m0v000000000000001")).toBe("01J9Z8D3M0V000000000000001");
    expect(vaultFromSearch("?vault=../admin")).toBeUndefined();
    expect(vaultFromSearch("?ref=player")).toBeUndefined();
  });

  it("drops ?vault= from an address and keeps the rest", () => {
    expect(withoutVaultParam("https://hippo.test/dashboard/entity/?ref=player&vault=01J9Z8D3M0V000000000000001#facts")).toBe("/dashboard/entity/?ref=player#facts");
  });
});

describe("adding a vault", () => {
  it("stays on through a trip to GitHub (which drops ?add), and only on the add steps", async () => {
    const data = new Map<string, string>();
    const fake = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
    Object.defineProperty(globalThis, "sessionStorage", { value: fake, configurable: true });
    try {
      const { addingVaultNow, stopAddingVault } = await import("./vault.ts");
      expect(addingVaultNow("", "#repo")).toBe(false);
      expect(addingVaultNow("?add", "#create")).toBe(true);
      expect(addingVaultNow("", "#repo")).toBe(true);
      expect(addingVaultNow("", "#agents")).toBe(false);
      expect(addingVaultNow("", "")).toBe(false);
      stopAddingVault();
      expect(addingVaultNow("", "#repo")).toBe(false);
    } finally {
      Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });
});
