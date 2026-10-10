import { describe, expect, it } from "vitest";
import { adminRoutes } from "./admin.ts";
import { Registry } from "./registry.ts";
import { registryDb } from "./testing.ts";

const GM = { id: 7, login: "game-master" };
const PLAYER = { id: 4242, login: "player" };
const url = new URL("https://hippo.test/dashboard/api/admin/vaults");

async function setup() {
  const registry = new Registry(await registryDb());
  await registry.signIn(GM, { admin: true });
  await registry.signIn(PLAYER);
  const { vault } = await registry.claimVault({ accountId: PLAYER.id, installationId: 55, repoId: 9001, fullName: "player/vault", branch: "main" });
  const changed: string[] = [];
  const admin = adminRoutes({ registry, admins: new Set([GM.id]), onVaultChanged: (id) => void changed.push(id) });
  return { registry, vault, changed, admin, gm: (await registry.account(GM.id))!, player: (await registry.account(PLAYER.id))! };
}

describe("admin: vault quotas", () => {
  it("sets a vault's overrides, tells its object, and shows them in the vault list", async () => {
    const { registry, vault, changed, admin, gm } = await setup();
    const res = (await admin("POST", "vaults/quotas", { id: vault.id, quotas: { sleepRunsPerDay: 96 } }, url, gm)) as { vault: { quotas: unknown } };
    expect(res.vault.quotas).toEqual({ sleepRunsPerDay: 96 });
    expect((await registry.vault(vault.id))!.quotas).toEqual({ sleepRunsPerDay: 96 });
    expect(changed).toEqual([vault.id]);
    const list = (await admin("GET", "vaults", undefined, url, gm)) as { vaults: { id: string; quotas: unknown }[] };
    expect(list.vaults[0]).toMatchObject({ id: vault.id, quotas: { sleepRunsPerDay: 96 } });
  });

  it("clears them with null, and goes back to the defaults", async () => {
    const { registry, vault, admin, gm } = await setup();
    await admin("POST", "vaults/quotas", { id: vault.id, quotas: { sleepRunsPerDay: 96 } }, url, gm);
    await admin("POST", "vaults/quotas", { id: vault.id, quotas: null }, url, gm);
    expect((await registry.vault(vault.id))!.quotas).toBeUndefined();
  });

  it("refuses anyone who isn't an admin", async () => {
    const { vault, admin, player } = await setup();
    await expect(admin("POST", "vaults/quotas", { id: vault.id, quotas: { sleepRunsPerDay: 96 } }, url, player)).rejects.toMatchObject({ status: 403, code: "ADMIN" });
  });

  it("refuses bad values, a missing field, and a vault that doesn't exist", async () => {
    const { vault, admin, gm } = await setup();
    const post = (body: unknown) => admin("POST", "vaults/quotas", body, url, gm);
    await expect(post({ id: vault.id, quotas: { sleepRunsPerDay: "96" } })).rejects.toMatchObject({ status: 400, code: "INVALID" });
    await expect(post({ id: vault.id, quotas: { sleepRuns: 96 } })).rejects.toMatchObject({ status: 400, code: "INVALID" });
    await expect(post({ id: vault.id })).rejects.toMatchObject({ status: 400, code: "INVALID" });
    await expect(post({ quotas: { sleepRunsPerDay: 96 } })).rejects.toMatchObject({ status: 400, code: "INVALID" });
    await expect(post({ id: "nope", quotas: { sleepRunsPerDay: 96 } })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});
