import { describe, expect, it } from "vitest";
import { fixtureStore } from "./__fixtures__/vault.ts";
import { CURRENT_VAULT_VERSION, VaultVersionError, migrate } from "./migrations.ts";
import { Vault } from "./vault.ts";

async function withVersion(version: number) {
  const store = fixtureStore();
  await store.write("_hippo/config.yaml", `${(await store.read("_hippo/config.yaml"))!.replace("version: 1\n", `version: ${version}\n`)}`);
  return store;
}

describe("vault format version", () => {
  it("loads the current version", async () => {
    await expect(Vault.load(await withVersion(CURRENT_VAULT_VERSION))).resolves.toBeInstanceOf(Vault);
  });

  it("refuses a vault newer than the tool", async () => {
    await expect(Vault.load(await withVersion(CURRENT_VAULT_VERSION + 1))).rejects.toThrow(/newer than this Hippocampus/);
  });

  it("asks to migrate an older vault, unless the check is skipped", async () => {
    const store = await withVersion(0);
    await expect(Vault.load(store)).rejects.toBeInstanceOf(VaultVersionError);
    await expect(Vault.load(store)).rejects.toThrow(/hippo migrate/);
    await expect(Vault.load(store, { skipVersionCheck: true })).resolves.toBeInstanceOf(Vault);
  });

  it("migrate is a no-op on a current vault", async () => {
    const store = await withVersion(CURRENT_VAULT_VERSION);
    const vault = await Vault.load(store);
    expect(await migrate(store, vault.config)).toEqual({ from: 1, to: 1, applied: [], changed: [] });
  });
});
