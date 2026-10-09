import { describe, expect, it } from "vitest";
import { configProblem } from "./app.ts";
import { ORIGIN } from "./hosted/testing.ts";
import { GM, PLAYER, SCOUT, hostedApp } from "./testing/hosted-app.ts";

describe("the hosted Worker's pages", () => {
  it("sends / to the dashboard when signed in, and to the welcome page otherwise", async () => {
    const h = await hostedApp();
    const anonymous = await h.send(new Request(`${ORIGIN}/`, { headers: { accept: "text/html" } }));
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toBe("/dashboard/welcome/");
    const visit = h.browser();
    await h.signIn(visit, "player");
    expect((await visit(`${ORIGIN}/`)).headers.get("location")).toBe("/dashboard/");
    expect((await h.send(new Request(`${ORIGIN}/`, { method: "POST" }))).status).toBe(405);
  });

  it("serves the UI with security headers, revalidating HTML, and its own 404 page", async () => {
    const h = await hostedApp();
    const res = await h.send(new Request(`${ORIGIN}/dashboard/`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Tavern");
    expect(Object.fromEntries(["x-frame-options", "content-security-policy", "x-content-type-options", "referrer-policy", "cross-origin-opener-policy", "cache-control"].map((k) => [k, res.headers.get(k)]))).toEqual({
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
      "cache-control": "no-cache",
    });
    // Astro's meta CSP owns scripts and styles; the header mustn't fight it.
    expect(res.headers.get("content-security-policy")).not.toMatch(/script-src|style-src/);
    const lost = await h.send(new Request(`${ORIGIN}/dashboard/nowhere/`));
    expect(lost.status).toBe(404);
    expect(await lost.text()).toContain("Lost");
    expect(lost.headers.get("x-frame-options")).toBe("DENY");
    expect((await h.send(new Request(`${ORIGIN}/dashboard/`, { method: "POST" }))).status).toBe(405);
    expect((await h.send(new Request(`${ORIGIN}/elsewhere`))).status).toBe(404);
  });

  it("names what's missing when the Worker isn't configured, and nothing else", () => {
    const page = configProblem({ HIPPO_PUBLIC_URL: ORIGIN, GITHUB_APP_ID: "4321", REGISTRY: {}, ASSETS: {} });
    expect(page?.status).toBe(503);
    return page!.text().then((text) => {
      for (const name of ["VAULT_HOST", "OAUTH_KV", "HIPPO_ADMINS", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET"]) expect(text).toContain(name);
      expect(text).not.toContain("4321");
      expect(text).not.toContain("REGISTRY");
    });
  });
});

describe("the dashboard API", () => {
  it("goes to the caller's own vault, as them, without their cookie", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const gm = await h.readyAccount(GM);
    const res = await h.api(player.visit, "overview?quest=lisbon");
    expect(await res.json()).toEqual({ vault: player.vault, user: { login: "player", account: { status: "approved", admin: false } }, path: "/dashboard/api/overview" });
    expect(await (await h.api(gm.visit, "overview")).json()).toMatchObject({ vault: gm.vault, user: { login: "game-master", account: { status: "approved", admin: true } } });
    const [call] = h.vaults.to(player.vault, "dashboard");
    expect(call).toMatchObject({ authorization: null, cookie: null });
    // Told where it lives once, before the first request.
    expect(h.vaults.to(player.vault, "configure").map((c) => c.meta)).toEqual([{ vaultId: player.vault, fullName: "player/vault", branch: "main", repoId: PLAYER.repo, installationId: player.installation.id }]);
    await h.api(player.visit, "session");
    expect(h.vaults.to(player.vault, "configure")).toHaveLength(1);
  });

  it("takes writes only from our own origin", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    expect((await h.post(visit, "actions/remember", { text: "x" }, {})).status).toBe(403);
    expect((await h.post(visit, "actions/remember", { text: "x" }, { origin: "https://evil.test" })).status).toBe(403);
    expect(h.vaults.to(vault, "dashboard")).toEqual([]);
    expect((await h.post(visit, "actions/remember", { text: "x" })).status).toBe(200);
  });

  it("stays with the hosted routes until the vault is ready", async () => {
    const h = await hostedApp();
    const visit = h.browser();
    expect((await h.api(visit, "overview")).status).toBe(401);
    await h.signIn(visit, "player");
    expect(await (await h.api(visit, "overview")).json()).toMatchObject({ code: "NO_VAULT" });
    expect(await (await h.api(visit, "session")).json()).toMatchObject({ mode: "setup" });
    expect(h.vaults.calls).toEqual([]);
  });
});

describe("MCP with vault keys", () => {
  it("gives each kind of key its grant", async () => {
    const h = await hostedApp();
    const { vault } = await h.readyAccount(PLAYER);
    const grantFor = async (body: unknown) => ((await (await h.callMcp(await h.mintKey(vault, body))).json()) as { vault: string; grant: unknown });
    expect(await grantFor({ kind: "bound", agent: "home-finder", scopes: ["read", "remember"] })).toEqual({
      vault,
      grant: { agent: "home-finder", scopes: ["read", "remember"], via: "key", keyKind: "bound" },
      body: expect.stringContaining("tools/list"),
    });
    expect((await grantFor({ kind: "agent" })).grant).toEqual({ scopes: ["read", "remember", "quest"], via: "key", keyKind: "agent" });
    expect((await grantFor({ kind: "curator" })).grant).toEqual({ scopes: ["read", "curate"], via: "key", keyKind: "curator" });
    // The Durable Object gets the grant, never the key itself.
    expect(h.vaults.to(vault, "mcp").every((c) => c.authorization === null)).toBe(true);
  });

  it("notes when a key was used", async () => {
    const h = await hostedApp();
    const { vault } = await h.readyAccount(PLAYER);
    const token = await h.mintKey(vault, { kind: "agent" });
    await h.callMcp(token);
    await Promise.all(h.waits);
    expect((await h.registry.keyForToken(token))?.lastUsed).toBeDefined();
  });

  it("refuses unknown, revoked and other tokens, and keys of a vault that isn't ready", async () => {
    const h = await hostedApp();
    const { vault } = await h.readyAccount(PLAYER);
    for (const token of ["hippo_not-a-real-key", "something-else", "a:b:c"]) {
      const res = await h.callMcp(token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
    const token = await h.mintKey(vault, { kind: "agent" });
    const key = (await h.registry.keyForToken(token))!;
    await h.registry.setVaultStatus(vault, "disconnected", "public");
    expect((await h.callMcp(token)).status).toBe(401);
    await h.registry.setVaultStatus(vault, "ready");
    expect((await h.callMcp(token)).status).toBe(200);
    await h.registry.revokeKey(vault, key.id);
    expect((await h.callMcp(token)).status).toBe(401);
    expect(h.vaults.to(vault, "mcp")).toHaveLength(1);
    // Logs say which route and how it went, never the token or the vault's id.
    expect(h.logs.join("\n")).toContain('"route":"POST mcp"');
    expect(h.logs.map((l) => JSON.parse(l) as Record<string, unknown>)).toContainEqual({ route: "oauth", status: 401, ms: expect.any(Number), code: "invalid_token" });
    expect(h.logs.join("\n")).not.toContain(token);
    expect(h.logs.join("\n")).not.toContain(vault);
  });

  it("keeps each account's keys and sessions to its own vault", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const gm = await h.readyAccount(GM);
    await h.callMcp(await h.mintKey(player.vault, { kind: "agent" }));
    await h.callMcp(await h.mintKey(gm.vault, { kind: "curator" }));
    await h.api(player.visit, "overview");
    expect(h.vaults.calls.filter((c) => c.method === "mcp" || c.method === "dashboard").map((c) => [c.vault, c.method, c.grant?.keyKind ?? c.user?.login])).toEqual([
      [player.vault, "mcp", "agent"],
      [gm.vault, "mcp", "curator"],
      [player.vault, "dashboard", "player"],
    ]);
  });

  it("rate-limits per key", async () => {
    const h = await hostedApp({ limits: { mcp: { limit: async ({ key }) => ({ success: !key.startsWith("mcp:key:") }) } } });
    const { vault } = await h.readyAccount(PLAYER);
    const res = await h.callMcp(await h.mintKey(vault, { kind: "agent" }));
    expect(res.status).toBe(429);
    expect(h.vaults.to(vault, "mcp")).toEqual([]);
  });
});

describe("OAuth endpoints", () => {
  it("point unauthenticated clients at the authorization server", async () => {
    const h = await hostedApp();
    const res = await h.send(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const resource = (await (await h.send(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`))).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const server = (await (await h.send(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>;
    expect(server).toMatchObject({ authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register` });
    expect(server.scopes_supported).toEqual(["read", "remember", "quest", "curate"]);
  });

  it("rate-limit client registration by IP", async () => {
    const h = await hostedApp({ limits: { register: { limit: async ({ key }) => ({ success: key !== "register:203.0.113.9" }) } } });
    const register = (ip: string) =>
      h.send(
        new Request(`${ORIGIN}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
          body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.example/cb"], token_endpoint_auth_method: "none" }),
        }),
      );
    const limited = await register("203.0.113.9");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "temporarily_unavailable" });
    expect((await register("198.51.100.4")).status).toBe(201);
  });
});

describe("vault changes reach the Durable Object", () => {
  it("disconnects, reconfigures and renames from GitHub's webhooks", async () => {
    const h = await hostedApp();
    const { vault } = await h.readyAccount(PLAYER);
    h.vaults.calls.length = 0;
    const repo = { repository: { id: PLAYER.repo, full_name: "player/vault" } };
    await h.deliver("repository", { action: "publicized", ...repo });
    expect(h.vaults.to(vault)).toEqual([expect.objectContaining({ method: "disconnect", reason: "public" })]);
    await h.deliver("repository", { action: "privatized", ...repo });
    await h.deliver("repository", { action: "renamed", repository: { id: PLAYER.repo, full_name: "player/memory" } });
    expect(h.vaults.to(vault, "configure").map((c) => c.meta?.fullName)).toEqual(["player/vault", "player/memory"]);
  });

  it("wipes the vault's object and revokes connected apps when the account is deleted", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    const res = await h.post(visit, "account/delete", { confirm: "player" });
    expect(res.status).toBe(200);
    expect(h.vaults.to(vault, "destroy")).toHaveLength(1);
    expect((await h.app.oauth.listUserGrants("account-4242")).items).toEqual([]);
  });

  it("keeps other accounts' objects alone", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const scout = await h.readyAccount(SCOUT);
    await h.post(player.visit, "account/delete", { confirm: "player" });
    expect(h.vaults.to(scout.vault).map((c) => c.method)).not.toContain("destroy");
  });
});
