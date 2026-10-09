import type { HostedKeyInfo, HostedMintedKey, HostedSessionInfo, HostedSetupStatus } from "@hippocampus/dashboard";
import { signWebhook } from "@hippocampus/store-github/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { browser } from "../testing/browser.ts";
import { MemoryKV } from "../testing/memory-kv.ts";
import { keyRequest } from "./registry.ts";
import { createHostedRoutes } from "./routes.ts";
import { safeReturn } from "./session.ts";
import { APP, ORIGIN, appKeyPair, hostedGitHub, registryDb, testSettings } from "./testing.ts";

let keys: Awaited<ReturnType<typeof appKeyPair>>;
beforeAll(async () => {
  keys = await appKeyPair();
});

const PLAYER = 4242;
const GM = 7;
const SCOUT = 5150;
const FELL_THROUGH = "x-fell-through";
const SETTINGS = { campaign: "Lisbon relocation", human: "player", timezone: "Europe/Lisbon", domains: ["residency", "housing"] };

type Visit = ReturnType<typeof browser>;

async function setup() {
  const github = await hostedGitHub(keys);
  const { gh } = github;
  gh.addUser({ login: "player", id: PLAYER });
  gh.addUser({ login: "game-master", id: GM });
  gh.addUser({ login: "job-scout", id: SCOUT });
  const kv = new MemoryKV();
  const seen = { changed: [] as string[], oauthRevoked: [] as number[], destroyed: [] as string[], logs: [] as string[] };
  const routes = createHostedRoutes({
    settings: testSettings(keys.privateKeyPem, [GM]),
    kv,
    registry: await registryDb(),
    fetch: github.fetch,
    hooks: {
      onVaultChanged: (id) => void seen.changed.push(id),
      revokeOAuthGrants: async (id) => void seen.oauthRevoked.push(id),
      destroyVault: async (id) => void seen.destroyed.push(id),
    },
    log: (line) => seen.logs.push(line),
  });
  // What the Worker would do with a request the hosted routes don't answer (it sends it on).
  const send = async (request: Request) => (await routes(request)) ?? new Response(null, { status: 404, headers: { [FELL_THROUGH]: "1" } });
  const player = browser(send);

  const signIn = async (using: Visit, login: string) => {
    const toGitHub = await using(`${ORIGIN}/dashboard/auth/login`);
    return using(github.signIn(toGitHub.headers.get("location")!, login));
  };
  const api = (using: Visit, path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return using(`${ORIGIN}/dashboard/api/${path}`, { method: init.method ?? "GET", headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
  };
  const get = async <T = Record<string, unknown>>(using: Visit, path: string) => {
    const res = await api(using, path);
    return { status: res.status, body: (res.headers.get(FELL_THROUGH) ? undefined : await res.json()) as T, fellThrough: !!res.headers.get(FELL_THROUGH) };
  };
  const post = async <T = Record<string, unknown>>(using: Visit, path: string, json: unknown, headers: Record<string, string> = { origin: ORIGIN }) => {
    const res = await api(using, path, { method: "POST", json, headers });
    return { status: res.status, body: (await res.json()) as T, res };
  };

  /** Player, signed in and approved, with the app installed on player/vault (empty, private). */
  const approvedPlayer = async () => {
    await signIn(player, "player");
    await routes.registry.setAccountStatus(PLAYER, "approved");
    const installation = gh.addInstallation({ account: { id: PLAYER, login: "player", type: "User" }, repos: ["player/vault"] });
    return installation;
  };
  /** …and the vault set up through the API. */
  const readyPlayer = async () => {
    const installation = await approvedPlayer();
    await player(github.installed("player", installation.id));
    const init = await post<{ vault: { id: string } }>(player, "setup/init", { repoId: 9001, ...SETTINGS });
    expect(init.status).toBe(200);
    return { installation, vault: init.body.vault.id };
  };
  return { gh, github, kv, routes, send, player, seen, signIn, api, get, post, approvedPlayer, readyPlayer };
}

describe("signing in", () => {
  it("sends people to GitHub with a state, PKCE and the app's callback", async () => {
    const { player } = await setup();
    const res = await player(`${ORIGIN}/dashboard/auth/login?return=%2Fdashboard%2Fsetup%2F`);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://github.test/login/oauth/authorize");
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ client_id: APP.clientId, redirect_uri: `${ORIGIN}/oauth/github/callback`, code_challenge_method: "S256" });
    expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-hippo_login=[\w-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/);
  });

  it("makes a waitlisted account with a Lax session, in setup mode", async () => {
    const { player, routes, signIn, get } = await setup();
    const back = await signIn(player, "player");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/dashboard/");
    expect(back.headers.getSetCookie().find((c) => c.startsWith("__Host-hippo_session="))).toMatch(/HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=604800$/);
    expect(await routes.registry.account(PLAYER)).toMatchObject({ login: "player", status: "waitlisted" });
    const session = await get<HostedSessionInfo>(player, "session");
    expect(session.body).toEqual({
      mode: "setup",
      user: { login: "player" },
      capabilities: expect.objectContaining({ setup: "hosted", rule: false, quest: false, remember: false, party: false }),
      account: { status: "waitlisted", admin: false },
    });
  });

  it("answers the dashboard API only with a live session", async () => {
    const { player, routes, signIn, get, api } = await setup();
    expect(await get(player, "session")).toMatchObject({ status: 401, body: { code: "SIGN_IN", login: "/dashboard/auth/login" } });
    expect((await get(player, "overview")).status).toBe(401);
    await signIn(player, "player");
    expect((await get(player, "overview")).body).toMatchObject({ code: "NO_VAULT" });
    // Revoking the app's authorization (or deletion) bumps the epoch: every session ends.
    await routes.registry.bumpEpoch(PLAYER);
    expect((await get(player, "session")).status).toBe(401);
    await signIn(player, "player");
    expect((await api(player, "../auth/logout", { method: "POST", headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await api(player, "../auth/logout", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(204);
    expect((await get(player, "session")).status).toBe(401);
  });

  it("refuses a denied account at the door", async () => {
    const { player, routes, signIn } = await setup();
    await routes.registry.signIn({ id: PLAYER, login: "player" });
    await routes.registry.setAccountStatus(PLAYER, "denied");
    const res = await signIn(player, "player");
    expect(res.status).toBe(403);
    expect(player.jar.has("__Host-hippo_session")).toBe(false);
  });

  it("leaves everything else to the rest of the Worker", async () => {
    const { routes } = await setup();
    for (const path of ["/mcp", "/", "/dashboard/", "/dashboard/quests/", "/authorize"]) expect(await routes(new Request(`${ORIGIN}${path}`))).toBeUndefined();
  });

  it("returns only to dashboard pages or the connector's consent page", () => {
    expect(safeReturn("/dashboard/setup/#repo", ORIGIN)).toBe("/dashboard/setup/#repo");
    expect(safeReturn("/authorize?client_id=abc&state=x", ORIGIN)).toBe("/authorize?client_id=abc&state=x");
    for (const bad of ["https://evil.test/dashboard/", "//evil.test/dashboard/", "/\\evil.test", "/mcp", "/authorize/../mcp", "javascript:alert(1)", undefined])
      expect(safeReturn(bad, ORIGIN)).toBe("/dashboard/");
  });
});

describe("onboarding", () => {
  it("goes from the waitlist to a ready vault with keys", async () => {
    const { gh, github, kv, routes, send, player, seen, signIn, get, post } = await setup();
    await signIn(player, "player");
    const waiting = await get<HostedSetupStatus>(player, "setup/status");
    expect(waiting.body).toMatchObject({ kind: "hosted", account: { login: "player", status: "waitlisted", requested: false }, publicUrl: ORIGIN, mcpUrl: `${ORIGIN}/mcp` });
    expect(waiting.body.items).toEqual([expect.objectContaining({ id: "access", state: "todo" })]);
    expect((await get(player, "setup/repos")).body).toMatchObject({ code: "NOT_APPROVED" });

    // Asking for access is a write: our own Origin only.
    expect((await post(player, "setup/access", { note: "moving to lisbon" }, {})).status).toBe(403);
    expect((await post(player, "setup/access", { note: "moving to lisbon" })).status).toBe(200);
    expect((await get<HostedSetupStatus>(player, "setup/status")).body.account.requested).toBe(true);

    // An admin approves.
    const gm = browser(send);
    await signIn(gm, "game-master");
    expect((await get<HostedSessionInfo>(gm, "session")).body.account).toEqual({ status: "approved", admin: true });
    const waitlist = await get<{ accounts: { id: number; login: string; note?: string }[] }>(gm, "admin/accounts?status=waitlisted");
    expect(waitlist.body.accounts).toEqual([expect.objectContaining({ id: PLAYER, login: "player", note: "moving to lisbon" })]);
    expect((await get(player, "admin/accounts")).body).toMatchObject({ code: "ADMIN" });
    expect((await post(gm, "admin/accounts/approve", { id: PLAYER })).body).toMatchObject({ account: { status: "approved" } });

    // The player installs the app on their new private repo; GitHub sends them back.
    const status = await get<HostedSetupStatus>(player, "setup/status");
    expect(status.body.installUrl).toBe(`https://github.test/apps/${APP.slug}/installations/new`);
    expect(status.body.newRepoUrl).toContain("visibility=private");
    const installation = gh.addInstallation({ account: { id: PLAYER, login: "player", type: "User" }, repos: ["player/vault"] });
    const back = await player(github.installed("player", installation.id));
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/dashboard/setup/#repo");
    expect((await get<HostedSetupStatus>(player, "setup/status")).body.installation).toEqual({ id: installation.id, repos: [{ id: 9001, fullName: "player/vault", private: true }] });
    expect((await get(player, "setup/repos")).body).toEqual({ installation: { id: installation.id }, repos: [{ id: 9001, fullName: "player/vault", private: true, empty: true }] });

    // Settings are checked before anything touches GitHub.
    expect((await post(player, "setup/init", { repoId: 9001, ...SETTINGS, timezone: "Mars/Olympus" })).body).toMatchObject({ code: "INVALID" });
    expect((await post(player, "setup/init", { repoId: 1, ...SETTINGS })).status).toBe(404);
    const init = await post<{ vault: { id: string; status: string; fullName: string }; mode: string }>(player, "setup/init", { repoId: 9001, ...SETTINGS });
    expect(init.body).toMatchObject({ mode: "initialized", vault: { status: "ready", fullName: "player/vault", branch: "main" } });
    const vaultId = init.body.vault.id;
    expect(gh.at("player/vault").files()[".github/workflows/validate.yml"]).toBeDefined();
    expect(seen.changed).toContain(vaultId);
    expect(await kv.get(`hosted:install:${PLAYER}`, "json")).toBeNull();
    expect((await post(player, "setup/init", { repoId: 9001, ...SETTINGS })).body).toMatchObject({ code: "HAS_VAULT" });

    // With a ready vault, the session and the vault's API are the Durable Object's.
    expect((await get(player, "session")).fellThrough).toBe(true);
    expect((await get(player, "overview")).fellThrough).toBe(true);
    const request = new Request(`${ORIGIN}/dashboard/api/overview`, { headers: { cookie: [...player.jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    expect(await routes(request)).toBeUndefined();
    expect((await routes.who(request))?.vault).toMatchObject({ id: vaultId, status: "ready" });

    // Keys: shown once, listed without the key, scoped to the vault.
    const minted = await post<HostedMintedKey>(player, "setup/keys", { kind: "bound", agent: "home-finder", scopes: ["read", "remember"], label: "Laptop" });
    expect(minted.body).toMatchObject({ kind: "bound", agent: "home-finder", scopes: ["read", "remember"], label: "Laptop" });
    expect(minted.body.token).toMatch(/^hippo_/);
    expect(minted.body.snippets.map((s) => s.label)).toEqual([
      "Claude Code",
      "Any MCP client over HTTP (.mcp.json)",
      "Cursor (~/.cursor/mcp.json)",
      "VS Code (.vscode/mcp.json)",
      "Claude.ai or ChatGPT (custom connector)",
    ]);
    expect(minted.body.snippets[0]!.code).toBe(`claude mcp add --transport http hippocampus ${ORIGIN}/mcp --header "Authorization: Bearer ${minted.body.token}"`);
    const listed = await get<{ keys: HostedKeyInfo[] }>(player, "setup/keys");
    expect(listed.body.keys.map((k) => k.id)).toEqual([minted.body.id]);
    expect(JSON.stringify(listed.body)).not.toContain(minted.body.token);
    expect((await routes.registry.keyForToken(minted.body.token))?.vault.id).toBe(vaultId);
    expect((await post(player, "setup/keys", { kind: "bound", agent: "curator" })).body).toMatchObject({ code: "INVALID" });

    // Another account's key can't be revoked from here, even knowing its id.
    await routes.registry.signIn({ id: SCOUT, login: "job-scout" });
    await routes.registry.setAccountStatus(SCOUT, "approved");
    const { vault: theirs } = await routes.registry.claimVault({ accountId: SCOUT, installationId: 99, repoId: 9100, fullName: "job-scout/vault", branch: "main" });
    await routes.registry.setVaultStatus(theirs.id, "ready");
    const { key: theirKey } = await routes.registry.mintKey(theirs.id, keyRequest({ kind: "agent" }));
    expect((await post(player, "setup/keys/revoke", { id: theirKey.id })).status).toBe(404);
    expect(await routes.registry.keyByHash(theirKey.id)).toBeDefined();
    expect((await post(player, "setup/keys/revoke", { id: minted.body.id })).body).toEqual({ ok: true });
    expect(await routes.registry.keyForToken(minted.body.token)).toBeUndefined();

    // Logs name routes, never the vault's id, queries or bodies.
    const logs = seen.logs.join("\n");
    expect(logs).toContain('"route":"POST setup/init"');
    expect(logs).not.toContain(vaultId);
    expect(logs).not.toContain("status=waitlisted");
    expect(logs).not.toContain("moving to lisbon");
  });

  it("refuses a public repo and says why", async () => {
    const { gh, github, player, post, approvedPlayer } = await setup();
    const installation = await approvedPlayer();
    gh.at("player/vault").isPrivate = false;
    await player(github.installed("player", installation.id));
    const res = await post(player, "setup/init", { repoId: 9001, ...SETTINGS });
    expect(res.body).toMatchObject({ code: "PUBLIC_REPO" });
    expect(String(res.body.error)).toMatch(/is public/);
  });
});

describe("the install redirect", () => {
  it("is refused when the code belongs to someone else", async () => {
    const { gh, github, kv, player, approvedPlayer } = await setup();
    await approvedPlayer();
    const theirs = gh.addInstallation({ account: { id: SCOUT, login: "job-scout", type: "User" }, repos: [] });
    const res = await player(github.installed("job-scout", theirs.id));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Different GitHub account");
    expect(await kv.get(`hosted:install:${PLAYER}`, "json")).toBeNull();
  });

  it("is refused for an installation the user can't see", async () => {
    const { gh, github, kv, player, approvedPlayer } = await setup();
    await approvedPlayer();
    const theirs = gh.addInstallation({ account: { id: SCOUT, login: "job-scout", type: "User" }, repos: [] });
    const res = await player(github.installed("player", theirs.id));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("can't see that installation");
    expect(await kv.get(`hosted:install:${PLAYER}`, "json")).toBeNull();
  });

  it("is refused for an organization's installation", async () => {
    const { gh, github, kv, player, approvedPlayer } = await setup();
    await approvedPlayer();
    const org = gh.addInstallation({ account: { id: 777, login: "harbor-university", type: "Organization" }, repos: [] });
    gh.users.get("player")!.installations.push(org.id);
    const res = await player(github.installed("player", org.id));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("personal accounts");
    expect(await kv.get(`hosted:install:${PLAYER}`, "json")).toBeNull();
  });

  it("is refused while the account waits for approval", async () => {
    const { gh, github, player, signIn } = await setup();
    await signIn(player, "player");
    const installation = gh.addInstallation({ account: { id: PLAYER, login: "player", type: "User" }, repos: ["player/vault"] });
    expect((await player(github.installed("player", installation.id))).status).toBe(403);
  });

  it("signs the person in first when there's no session or no code, then ties the installation", async () => {
    const { gh, github, kv, routes, send, get } = await setup();
    await routes.registry.signIn({ id: PLAYER, login: "player" });
    await routes.registry.setAccountStatus(PLAYER, "approved");
    const installation = gh.addInstallation({ account: { id: PLAYER, login: "player", type: "User" }, repos: ["player/vault"] });
    const fresh = browser(send);
    const toGitHub = await fresh(github.installed("player", installation.id));
    expect(toGitHub.status).toBe(302);
    expect(new URL(toGitHub.headers.get("location")!).pathname).toBe("/login/oauth/authorize");
    // The install's own code was never bound to this browser, so no session came from it.
    expect(fresh.jar.has("__Host-hippo_session")).toBe(false);
    const back = await fresh(github.signIn(toGitHub.headers.get("location")!, "player"));
    expect(back.headers.get("location")).toBe("/dashboard/setup/#repo");
    expect(await kv.get(`hosted:install:${PLAYER}`, "json")).toMatchObject({ installationId: installation.id });
    expect((await get(fresh, "setup/repos")).status).toBe(200);
    // Signed in, but without a code (user authorization during install was off): confirm by signing in again.
    const again = await fresh(github.installed("player", installation.id, { code: false }));
    expect(new URL(again.headers.get("location")!).pathname).toBe("/login/oauth/authorize");
  });

  it("explains an organization's install request", async () => {
    const { github, player, approvedPlayer } = await setup();
    await approvedPlayer();
    const res = await player(github.installed("player", 31337, { action: "request" }));
    expect(res.status).toBe(202);
  });
});

describe("webhooks", () => {
  async function withVault() {
    const s = await setup();
    const { installation, vault } = await s.readyPlayer();
    let n = 0;
    const deliver = async (event: string, payload: unknown, opts: { delivery?: string; secret?: string } = {}) => {
      const body = JSON.stringify(payload);
      return s.send(
        new Request(`${ORIGIN}/github/webhook`, {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-github-event": event,
            "x-github-delivery": opts.delivery ?? `delivery-${++n}`,
            "x-hub-signature-256": await signWebhook(opts.secret ?? APP.webhookSecret, body),
          },
        }),
      );
    };
    const state = async () => {
      const v = (await s.routes.registry.vault(vault))!;
      return v.reason ? `${v.status}:${v.reason}` : v.status;
    };
    return { ...s, installation, vault, deliver, state };
  }

  it("refuses unsigned deliveries and handles each delivery once", async () => {
    const { vault, routes, seen, deliver } = await withVault();
    const renamed = { action: "renamed", repository: { id: 9001, full_name: "player/memory" } };
    expect((await deliver("repository", renamed, { secret: "wrong" })).status).toBe(401);
    expect((await routes.registry.vault(vault))!.fullName).toBe("player/vault");
    seen.changed.length = 0;
    expect(await (await deliver("repository", renamed, { delivery: "d-1" })).json()).toEqual({ ok: true, changed: 1 });
    expect((await routes.registry.vault(vault))!.fullName).toBe("player/memory");
    expect(await (await deliver("repository", renamed, { delivery: "d-1" })).json()).toEqual({ ok: true, duplicate: true });
    expect(seen.changed).toEqual([vault]);
  });

  it("disconnects and reconnects vaults as their installation and repo change", async () => {
    const { installation, deliver, state } = await withVault();
    const inst = { installation: { id: installation.id } };
    const repo = { repository: { id: 9001, full_name: "player/vault" } };

    await deliver("repository", { action: "publicized", ...repo });
    expect(await state()).toBe("disconnected:public");
    // Unsuspending doesn't fix a public repo.
    await deliver("installation", { action: "unsuspend", ...inst });
    expect(await state()).toBe("disconnected:public");
    await deliver("repository", { action: "privatized", ...repo });
    expect(await state()).toBe("ready");

    await deliver("installation", { action: "suspend", ...inst });
    expect(await state()).toBe("disconnected:suspended");
    await deliver("installation", { action: "unsuspend", ...inst });
    expect(await state()).toBe("ready");

    await deliver("installation_repositories", { action: "removed", ...inst, repositories_removed: [{ id: 9001 }] });
    expect(await state()).toBe("disconnected:repo_removed");
    await deliver("installation_repositories", { action: "added", ...inst, repositories_added: [{ id: 9001 }] });
    expect(await state()).toBe("ready");

    await deliver("repository", { action: "deleted", ...repo });
    expect(await state()).toBe("disconnected:repo_deleted");
    await deliver("installation", { action: "deleted", ...inst });
    expect(await state()).toBe("disconnected:uninstalled");
    expect((await deliver("ping", { zen: "Keep it logically awesome." })).status).toBe(200);
  });

  it("ends the account's sessions when the app's authorization is revoked", async () => {
    const { player, get, deliver } = await withVault();
    expect((await get(player, "setup/status")).status).toBe(200);
    await deliver("github_app_authorization", { action: "revoked", sender: { id: PLAYER, login: "player" } });
    expect((await get(player, "setup/status")).status).toBe(401);
  });
});

describe("account deletion", () => {
  it("needs the login typed, then uninstalls the app and forgets the account", async () => {
    const { gh, routes, player, seen, get, post, readyPlayer } = await setup();
    const { installation, vault } = await readyPlayer();
    const { key } = await routes.registry.mintKey(vault, keyRequest({ kind: "agent" }));
    expect((await post(player, "account/delete", { confirm: "someone-else" })).body).toMatchObject({ code: "CONFIRM" });
    expect((await post(player, "account/delete", { confirm: "player" }, {})).status).toBe(403);
    expect((await get(player, "account")).body).toMatchObject({ login: "player", status: "approved", vault: { id: vault, status: "ready" } });

    const res = await post(player, "account/delete", { confirm: "@Player" });
    expect(res.body).toEqual({ ok: true });
    expect(res.res.headers.getSetCookie()).toEqual([expect.stringMatching(/^__Host-hippo_session=; .*Max-Age=0$/)]);
    expect(gh.installations.has(installation.id)).toBe(false);
    expect(seen.oauthRevoked).toEqual([PLAYER]);
    expect(seen.destroyed).toEqual([vault]);
    expect((await routes.registry.account(PLAYER))!.status).toBe("deleted");
    expect(await routes.registry.vault(vault)).toBeUndefined();
    expect(await routes.registry.keyByHash(key.id)).toBeUndefined();
    // The repo is the person's own: it stays, untouched.
    expect(gh.at("player/vault").files()["_hippo/config.yaml"]).toBeDefined();
    expect((await get(player, "session")).status).toBe(401);
  });
});

it("rate-limits sign-ins when a limiter is bound", async () => {
  const github = await hostedGitHub(keys);
  const routes = createHostedRoutes({
    settings: testSettings(keys.privateKeyPem),
    kv: new MemoryKV(),
    registry: await registryDb(),
    fetch: github.fetch,
    limits: { signIn: { limit: async ({ key }) => ({ success: key !== "signin:203.0.113.9" }) } },
  });
  const from = (ip: string) => routes(new Request(`${ORIGIN}/dashboard/auth/login`, { headers: { "cf-connecting-ip": ip } }));
  expect((await from("203.0.113.9"))!.status).toBe(429);
  expect((await from("198.51.100.4"))!.status).toBe(302);
});
