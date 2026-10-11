import { HttpError } from "@hippocampus/dashboard";
import { describe, expect, it } from "vitest";
import { hashToken } from "../auth.ts";
import { MAX_VAULTS_PER_USER, Registry, agentId, isLive, keyRequest, ulid } from "./registry.ts";
import { nodeSqlite } from "@hippocampus/index/node";
import { migrate, registryDb } from "./testing.ts";

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

describe("users and identities", () => {
  it("gives each account a user of our own and a GitHub identity, and keeps them in step", async () => {
    const { registry } = await setup();
    const account = await registry.signIn(PLAYER);
    expect(account.user).toMatch(/^u_[0-9a-f]{20}$/);
    expect(await registry.identities(account.user)).toEqual([{ provider: "github", login: "player" }]);
    // Renames follow the identity; the user stays.
    const renamed = await registry.signIn({ ...PLAYER, login: "player-renamed" });
    expect(renamed.user).toBe(account.user);
    expect(await registry.identities(account.user)).toEqual([{ provider: "github", login: "player-renamed" }]);
    await registry.setAccountStatus(PLAYER.id, "approved");
    await registry.bumpEpoch(PLAYER.id);
    const [legacy] = await registry.db.all<{ status: string; session_epoch: number }>("SELECT status, session_epoch FROM accounts WHERE id = ?", [PLAYER.id]);
    const [user] = await registry.db.all<{ status: string; session_epoch: number; name: string }>("SELECT status, session_epoch, name FROM users WHERE id = ?", [account.user]);
    expect(user).toEqual({ ...legacy, name: "player-renamed" });
    expect(await registry.accountByUser(account.user)).toMatchObject({ id: PLAYER.id, status: "approved", epoch: 1 });
  });

  it("makes a user for an account the previous Worker signed up", async () => {
    const { registry } = await setup();
    await registry.db.all("INSERT INTO accounts (id, login, status, created, updated) VALUES (?, ?, 'approved', ?, ?)", [GM.id, GM.login, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"]);
    const account = (await registry.account(GM.id))!;
    expect(account).toMatchObject({ id: GM.id, login: "game-master", status: "approved" });
    expect(await registry.identities(account.user)).toEqual([{ provider: "github", login: "game-master" }]);
    expect((await registry.account(GM.id))!.user).toBe(account.user);
  });

  it("records a GitLab connection as an identity, and forgets it on disconnect", async () => {
    const { registry } = await setup();
    const account = await registry.signIn(PLAYER);
    await registry.saveGitLabCredential({ accountId: PLAYER.id, gitlabUserId: 77, gitlabLogin: "player-gl", secret: "sealed" });
    expect(await registry.identities(account.user)).toEqual([
      { provider: "github", login: "player" },
      { provider: "gitlab", login: "player-gl" },
    ]);
    await registry.deleteGitLabCredential(PLAYER.id);
    expect(await registry.identities(account.user)).toEqual([{ provider: "github", login: "player" }]);
  });
});

it("backfills users, identities and owners from the previous Worker's rows", async () => {
  const db = await migrate(nodeSqlite(":memory:"), { to: "0003_gitlab.sql" });
  const at = "2026-09-01T00:00:00.000Z";
  await db.batch([
    { sql: "INSERT INTO accounts (id, login, status, note, session_epoch, created, updated) VALUES (4242, 'player', 'approved', 'hi', 3, ?, ?)", params: [at, at] },
    { sql: "INSERT INTO accounts (id, login, status, created, updated) VALUES (7, 'game-master', 'waitlisted', ?, ?)", params: [at, at] },
    { sql: "INSERT INTO vaults (id, account_id, installation_id, repo_id, full_name, branch, status, created, updated) VALUES ('01JVAULT000000000000000000', 4242, 55, 9001, 'player/vault', 'main', 'ready', ?, ?)", params: [at, at] },
    { sql: "INSERT INTO gitlab_credentials (account_id, gitlab_user_id, gitlab_login, secret, updated) VALUES (4242, 77, 'player-gl', 'sealed', ?)", params: [at] },
  ]);
  await migrate(db, { from: "0003_gitlab.sql" });
  const registry = new Registry(db);
  const player = (await registry.account(4242))!;
  expect(player).toMatchObject({ id: 4242, login: "player", status: "approved", note: "hi", epoch: 3 });
  expect(await registry.identities(player.user)).toEqual([
    { provider: "github", login: "player" },
    { provider: "gitlab", login: "player-gl" },
  ]);
  expect((await registry.vaultsOf(player)).map((v) => v.owner)).toEqual([player.user]);
  const gm = (await registry.account(7))!;
  expect(gm.user).not.toBe(player.user);
  expect(gm.status).toBe("waitlisted");
});

describe("vaults", () => {
  const vault = { accountId: PLAYER.id, installationId: 55, repoId: 9001, fullName: "player/vault", branch: "main" };

  it("lets one person have several vaults, each repo once, up to the limit", async () => {
    const { registry } = await setup();
    const player = await registry.signIn(PLAYER);
    await registry.signIn(GM, { admin: true });
    const { vault: v } = await registry.claimVault(vault);
    expect(v).toMatchObject({ status: "bootstrapping", fullName: "player/vault", repoId: 9001, owner: player.user });
    expect(v.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await registry.setVaultStatus(v.id, "ready");
    expect((await err(registry.claimVault(vault))).code).toBe("ALREADY_VAULT");
    expect((await err(registry.claimVault({ ...vault, accountId: GM.id }))).code).toBe("REPO_TAKEN");
    const { vault: second } = await registry.claimVault({ ...vault, repoId: 9002, fullName: "player/harbor-notes" });
    expect((await registry.vaultsOf(player)).map((x) => x.id)).toEqual([v.id, second.id]);
    for (let i = 3; i <= MAX_VAULTS_PER_USER; i++) await registry.claimVault({ ...vault, repoId: 9000 + i, fullName: `player/v${i}` });
    expect((await err(registry.claimVault({ ...vault, repoId: 9999, fullName: "player/one-too-many" }))).code).toBe("VAULT_LIMIT");
    expect((await registry.vaultsByInstallation(55)).map((x) => x.id)).toContain(v.id);
    expect((await registry.vaults())[0]).toMatchObject({ login: "player", fullName: "player/vault" });
  });

  it("takes back a disconnected vault on the same repo with its keys, after a stale bootstrap", async () => {
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
    // A bootstrap in progress blocks a retry, until it's stale.
    expect((await err(registry.claimVault(vault))).code).toBe("BUSY");
    clock.advance(6 * 60_000);
    expect((await registry.claimVault(vault)).vault.id).toBe(v.id);
  });

  it("removes a vault with its keys, and forgets it as the last one used", async () => {
    const { registry } = await setup();
    const player = await registry.signIn(PLAYER);
    const { vault: v } = await registry.claimVault(vault);
    const { key } = await registry.mintKey(v.id, keyRequest({ kind: "agent" }));
    await registry.setLastVault(player.user, v.id);
    expect((await registry.account(PLAYER.id))!.lastVault).toBe(v.id);
    await registry.removeVault(v.id);
    expect(await registry.vault(v.id)).toBeUndefined();
    expect(await registry.keyByHash(key.id)).toBeUndefined();
    expect((await registry.account(PLAYER.id))!.lastVault).toBeUndefined();
  });

  it("counts a vault the previous Worker made (no owner) as its account's", async () => {
    const { registry } = await setup();
    const player = await registry.signIn(PLAYER);
    const { vault: v } = await registry.claimVault(vault);
    await registry.db.all("UPDATE vaults SET owner = NULL WHERE id = ?", [v.id]);
    expect((await registry.vaultsOf(player)).map((x) => x.id)).toEqual([v.id]);
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
    expect(keyRequest({ kind: "agent" })).toEqual({ kind: "agent", label: "Any agent", scopes: ["read", "remember", "goal"] });
    expect(keyRequest({ kind: "curator", label: "Nightly" })).toEqual({ kind: "curator", label: "Nightly", scopes: ["read", "curate"] });
    expect(keyRequest({ kind: "bound", agent: " Home-Finder ", scopes: ["remember", "read"] })).toEqual({ kind: "bound", label: "home-finder", agent: "home-finder", scopes: ["read", "remember"] });
    expect(() => keyRequest({ kind: "bound", agent: "home-finder", scopes: ["remember"] })).toThrow(/needs read/);
    expect(() => keyRequest({ kind: "bound", agent: "home-finder", scopes: ["read", "curate"] })).toThrow(/unknown curate/);
    expect(() => keyRequest({ kind: "agent", agent: "home-finder" })).toThrow(/fixed scopes/);
    expect(() => keyRequest({ kind: "admin" })).toThrow(/kind/);
    expect(() => agentId("curator")).toThrow(/reserved/);
    expect(() => agentId("Not An Id")).toThrow(/lowercase/);
  });

  it("stores goal with its old name quest, so a rolled-back Worker keeps honoring it", async () => {
    const { registry, vault } = await withVault();
    // `quest` is still accepted from older dashboards, as `goal`.
    expect(keyRequest({ kind: "bound", agent: "home-finder", scopes: ["read", "quest"] }).scopes).toEqual(["read", "goal"]);
    const { token, key } = await registry.mintKey(vault.id, keyRequest({ kind: "bound", agent: "home-finder", scopes: ["read", "remember", "goal"] }));
    expect(key.scopes).toEqual(["read", "remember", "goal"]);
    const [row] = await registry.db.all<{ scopes: string }>("SELECT scopes FROM keys WHERE hash = ?", [key.id]);
    expect(JSON.parse(row!.scopes)).toEqual(["read", "remember", "goal", "quest"]);
    expect((await registry.keyForToken(token))!.scopes).toEqual(["read", "remember", "goal"]);

    // What the previous Worker did with a stored row: keep only the scopes it knew.
    const OLD_KEY_SCOPES = ["read", "remember", "quest", "curate"];
    expect((JSON.parse(row!.scopes) as unknown[]).filter((s) => OLD_KEY_SCOPES.includes(s as string))).toEqual(["read", "remember", "quest"]);

    // A key the previous Worker minted reads back under the current names.
    await registry.db.all("UPDATE keys SET scopes = ? WHERE hash = ?", [JSON.stringify(["read", "remember", "quest"]), key.id]);
    expect((await registry.keyForToken(token))!.scopes).toEqual(["read", "remember", "goal"]);
    const { key: curator } = await registry.mintKey(vault.id, keyRequest({ kind: "curator" }));
    expect(curator.scopes).toEqual(["read", "curate"]);
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
