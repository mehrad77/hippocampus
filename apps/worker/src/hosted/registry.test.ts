import { HttpError } from "@hippocampus/dashboard";
import { describe, expect, it } from "vitest";
import { hashToken } from "../auth.ts";
import { Registry, agentId, isLive, keyRequest, ulid } from "./registry.ts";
import { registryDb } from "./testing.ts";

const PLAYER = { id: 4242, login: "player" };
const GM = { id: 7, login: "game-master" };

async function setup(start = "2026-10-01T09:00:00.000Z") {
  let t = new Date(start).getTime();
  const clock = { advance: (ms: number) => (t += ms) };
  const registry = new Registry(await registryDb(), () => new Date(t));
  return { registry, clock };
}

const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected a rejection");
};

describe("accounts", () => {
  it("waitlists new accounts, approves admins, and keeps a denied account denied", async () => {
    const { registry } = await setup();
    expect(await registry.signIn(PLAYER)).toMatchObject({ id: 4242, login: "player", status: "waitlisted", epoch: 0 });
    expect((await registry.signIn(GM, { admin: true })).status).toBe("approved");
    await registry.setAccountStatus(PLAYER.id, "denied");
    expect((await registry.signIn({ ...PLAYER, login: "player-renamed" })).status).toBe("denied");
    expect((await registry.account(PLAYER.id))!.login).toBe("player-renamed");
  });

  it("promotes a waitlisted account once its id is in the admins", async () => {
    const { registry } = await setup();
    await registry.signIn(GM);
    expect((await registry.signIn(GM, { admin: true })).status).toBe("approved");
  });

  it("takes a note while waitlisted, and refuses once decided", async () => {
    const { registry } = await setup();
    await registry.signIn(PLAYER);
    expect((await registry.requestAccess(PLAYER.id, "moving to lisbon")).note).toBe("moving to lisbon");
    expect((await registry.accounts("waitlisted")).map((a) => a.login)).toEqual(["player"]);
    await registry.setAccountStatus(PLAYER.id, "approved");
    expect((await err(registry.requestAccess(PLAYER.id, "again"))).code).toBe("ALREADY_APPROVED");
    expect((await err(registry.setAccountStatus(999, "approved"))).status).toBe(404);
  });

  it("keeps a deleted account as a tombstone whose epoch only grows", async () => {
    const { registry } = await setup();
    await registry.signIn(PLAYER);
    await registry.requestAccess(PLAYER.id, "moving to lisbon");
    await registry.setAccountStatus(PLAYER.id, "approved");
    await registry.bumpEpoch(PLAYER.id);
    await registry.removeAccount(PLAYER.id);
    const gone = (await registry.account(PLAYER.id))!;
    expect(gone).toMatchObject({ status: "deleted", epoch: 2 });
    expect(gone.note).toBeUndefined();
    expect(await registry.accounts()).toEqual([]);
    // Signing up again starts over on the waitlist, with the epoch it had.
    expect(await registry.signIn(PLAYER)).toMatchObject({ status: "waitlisted", epoch: 2 });
  });
});

describe("vaults", () => {
  const vault = { accountId: PLAYER.id, installationId: 55, repoId: 9001, fullName: "player/vault", branch: "main" };

  it("allows one vault per account and one account per repo", async () => {
    const { registry } = await setup();
    await registry.signIn(PLAYER);
    await registry.signIn(GM, { admin: true });
    const { vault: v } = await registry.claimVault(vault);
    expect(v).toMatchObject({ status: "bootstrapping", fullName: "player/vault", repoId: 9001 });
    expect(v.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await registry.setVaultStatus(v.id, "ready");
    expect((await err(registry.claimVault({ ...vault, repoId: 9002, fullName: "player/other" }))).code).toBe("HAS_VAULT");
    expect((await err(registry.claimVault({ ...vault, accountId: GM.id }))).code).toBe("REPO_TAKEN");
    expect((await registry.vaultsByInstallation(55)).map((x) => x.id)).toEqual([v.id]);
    expect((await registry.vaults())[0]).toMatchObject({ login: "player", fullName: "player/vault" });
  });

  it("takes back a disconnected vault on the same repo with its keys, and replaces one on another repo", async () => {
    const { registry, clock } = await setup();
    await registry.signIn(PLAYER);
    const { vault: v } = await registry.claimVault(vault);
    await registry.setVaultStatus(v.id, "ready");
    const { key } = await registry.mintKey(v.id, keyRequest({ kind: "agent" }));
    await registry.setVaultStatus(v.id, "disconnected", "uninstalled");
    clock.advance(1000);
    const again = await registry.claimVault({ ...vault, installationId: 56 });
    expect(again).toEqual({ vault: expect.objectContaining({ id: v.id, installationId: 56, status: "bootstrapping" }) });
    expect((await registry.vault(v.id))!.reason).toBeUndefined();
    expect((await registry.keys(v.id)).map((k) => k.id)).toEqual([key.id]);
    // A bootstrap in progress blocks others, until it's stale.
    expect((await err(registry.claimVault(vault))).code).toBe("BUSY");
    clock.advance(6 * 60_000);
    await registry.setVaultStatus(v.id, "disconnected", "bootstrap_failed");
    const other = await registry.claimVault({ ...vault, repoId: 9002, fullName: "player/other" });
    expect(other.replaced).toBe(v.id);
    expect(await registry.vault(v.id)).toBeUndefined();
    expect(await registry.keyByHash(key.id)).toBeUndefined();
  });
});

describe("keys", () => {
  async function withVault() {
    const s = await setup();
    await s.registry.signIn(PLAYER);
    await s.registry.setAccountStatus(PLAYER.id, "approved");
    const { vault } = await s.registry.claimVault({ accountId: PLAYER.id, installationId: 55, repoId: 9001, fullName: "player/vault", branch: "main" });
    await s.registry.setVaultStatus(vault.id, "ready");
    return { ...s, vault };
  }

  it("fills in each kind's scopes and checks bound agents", () => {
    expect(keyRequest({ kind: "agent" })).toEqual({ kind: "agent", label: "Any agent", scopes: ["read", "remember", "quest"] });
    expect(keyRequest({ kind: "curator", label: "Nightly" })).toEqual({ kind: "curator", label: "Nightly", scopes: ["read", "curate"] });
    expect(keyRequest({ kind: "bound", agent: " Home-Finder ", scopes: ["remember", "read"] })).toEqual({ kind: "bound", label: "home-finder", agent: "home-finder", scopes: ["read", "remember"] });
    expect(() => keyRequest({ kind: "bound", agent: "home-finder", scopes: ["remember"] })).toThrow(/needs read/);
    expect(() => keyRequest({ kind: "bound", agent: "home-finder", scopes: ["read", "curate"] })).toThrow(/unknown curate/);
    expect(() => keyRequest({ kind: "agent", agent: "home-finder" })).toThrow(/fixed scopes/);
    expect(() => keyRequest({ kind: "admin" })).toThrow(/kind/);
    expect(() => agentId("curator")).toThrow(/reserved/);
    expect(() => agentId("Not An Id")).toThrow(/lowercase/);
  });

  it("stores only a hash, finds the vault by key, and revokes only within the vault", async () => {
    const { registry, vault } = await withVault();
    const { token, key } = await registry.mintKey(vault.id, keyRequest({ kind: "bound", agent: "home-finder", scopes: ["read"] }));
    expect(token).toMatch(/^hippo_[\w-]{43}$/);
    expect(key.id).toBe(await hashToken(token));
    expect(JSON.stringify(await registry.db.all("SELECT * FROM keys"))).not.toContain(token);
    const grant = (await registry.keyForToken(token))!;
    expect(grant).toMatchObject({ kind: "bound", agent: "home-finder", scopes: ["read"], vault: { id: vault.id, fullName: "player/vault" }, accountStatus: "approved" });
    expect(isLive(grant)).toBe(true);
    expect(await registry.keyForToken("ghp_not-ours")).toBeUndefined();
    expect((await err(registry.revokeKey("01OTHERVAULT0000000000000", key.id))).status).toBe(404);
    await registry.revokeKey(vault.id, key.id);
    expect(await registry.keyForToken(token)).toBeUndefined();
    expect((await err(registry.revokeKey(vault.id, key.id))).status).toBe(404);
  });

  it("isn't live once the vault disconnects or the owner is denied", async () => {
    const { registry, vault } = await withVault();
    const { token } = await registry.mintKey(vault.id, keyRequest({ kind: "agent" }));
    await registry.setVaultStatus(vault.id, "disconnected", "public");
    expect(isLive((await registry.keyForToken(token))!)).toBe(false);
    await registry.setVaultStatus(vault.id, "ready");
    await registry.setAccountStatus(PLAYER.id, "denied");
    expect(isLive((await registry.keyForToken(token))!)).toBe(false);
  });

  it("notes use at most every quarter hour", async () => {
    const { registry, vault, clock } = await withVault();
    const { key } = await registry.mintKey(vault.id, keyRequest({ kind: "agent" }));
    await registry.touchKey(key);
    const first = (await registry.keyByHash(key.id))!.lastUsed!;
    clock.advance(60_000);
    await registry.touchKey({ id: key.id });
    expect((await registry.keyByHash(key.id))!.lastUsed).toBe(first);
    clock.advance(15 * 60_000);
    await registry.touchKey({ id: key.id, lastUsed: first });
    expect((await registry.keyByHash(key.id))!.lastUsed! > first).toBe(true);
  });

  it("caps keys per vault", async () => {
    const { registry, vault } = await withVault();
    for (let i = 0; i < 50; i++) await registry.mintKey(vault.id, keyRequest({ kind: "agent" }));
    expect((await err(registry.mintKey(vault.id, keyRequest({ kind: "agent" })))).code).toBe("TOO_MANY_KEYS");
  });
});

describe("webhook deliveries", () => {
  it("claims each delivery once, and forgets them after a week", async () => {
    const { registry, clock } = await setup();
    expect(await registry.claimDelivery("d-1")).toBe(true);
    expect(await registry.claimDelivery("d-1")).toBe(false);
    await registry.releaseDelivery("d-1");
    expect(await registry.claimDelivery("d-1")).toBe(true);
    clock.advance(8 * 24 * 3600_000);
    await registry.claimDelivery("d-2");
    expect((await registry.db.all<{ id: string }>("SELECT id FROM webhook_deliveries")).map((r) => r.id)).toEqual(["d-2"]);
  });
});

it("makes ULIDs that sort by time", () => {
  const a = ulid(new Date("2026-10-01T00:00:00Z"), new Uint8Array(16));
  const b = ulid(new Date("2026-10-01T00:00:01Z"), new Uint8Array(16).fill(255));
  expect(a).toHaveLength(26);
  expect(a < b).toBe(true);
});
