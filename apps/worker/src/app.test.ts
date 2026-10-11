import { describe, expect, it } from "vitest";
import { VAULT_HEADER, type AdminReferrals, type HostedDeviceRequest, type HostedInvites, type HostedMembers, type HostedNewInvite, type HostedVault, type HostedVaults } from "@hippocampus/dashboard";
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

  it("refuses plain http and a GitHub stand-in in production, naming the setting but not its value", async () => {
    const all = { VAULT_HOST: {}, REGISTRY: {}, OAUTH_KV: {}, ASSETS: {}, HIPPO_ADMINS: "4242", GITHUB_APP_ID: "4321", GITHUB_APP_SLUG: "s", GITHUB_APP_CLIENT_ID: "c", GITHUB_APP_CLIENT_SECRET: "x", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_APP_WEBHOOK_SECRET: "w" };
    expect(configProblem({ ...all, HIPPO_PUBLIC_URL: ORIGIN })).toBeUndefined();
    const http = configProblem({ ...all, HIPPO_PUBLIC_URL: "http://hippo.test" });
    expect(http?.status).toBe(503);
    expect(await http!.text()).toContain("must be this Worker's https URL");
    const fake = configProblem({ ...all, HIPPO_PUBLIC_URL: ORIGIN, GITHUB_API_URL: "https://stand-in.test" });
    const text = await fake!.text();
    expect(fake!.status).toBe(503);
    expect(text).toContain("only for local development");
    expect(text).not.toContain("stand-in");
  });
});

describe("the dashboard API", () => {
  it("goes to the caller's own vault, as them, without their cookie", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const gm = await h.readyAccount(GM);
    const res = await h.api(player.visit, "overview?quest=lisbon");
    expect(await res.json()).toEqual({ vault: player.vault, user: { login: "player", account: { status: "approved", admin: false }, role: "owner" }, path: "/dashboard/api/overview" });
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
      grant: { agent: "home-finder", scopes: ["read", "remember"], via: "key", keyKind: "bound", credential: expect.stringMatching(/^key:[0-9a-f]{64}$/) },
      body: expect.stringContaining("tools/list"),
    });
    expect((await grantFor({ kind: "agent" })).grant).toEqual({ scopes: ["read", "remember", "goal"], via: "key", keyKind: "agent", credential: expect.stringMatching(/^key:/) });
    expect((await grantFor({ kind: "curator" })).grant).toEqual({ scopes: ["read", "curate"], via: "key", keyKind: "curator", credential: expect.stringMatching(/^key:/) });
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
    expect(server.scopes_supported).toEqual(["read", "remember", "goal", "curate", "quest"]);
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

describe("several vaults", () => {
  it("lets a person switch between their vaults, and remembers the last one", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const harbor = await h.addVault(player.visit, PLAYER, { name: "harbor-notes", id: 9101 });
    const listed = (await (await h.api(player.visit, "vaults")).json()) as HostedVaults;
    expect(listed.vaults.map((v) => [v.fullName, v.role])).toEqual([
      ["player/vault", "owner"],
      ["player/harbor-notes", "owner"],
    ]);
    expect(listed.current).toBe(player.vault);
    const on = (vault: string) => ({ headers: { [VAULT_HEADER]: vault } });
    expect(await (await h.api(player.visit, "overview", on(harbor))).json()).toMatchObject({ vault: harbor });
    // A new tab without the header opens the vault used last.
    expect(await (await h.api(player.visit, "overview")).json()).toMatchObject({ vault: harbor });
    expect((await (await h.api(player.visit, "vaults")).json()) as HostedVaults).toMatchObject({ current: harbor });
    // Someone else's vault, or a made-up one, is no vault at all.
    const gm = await h.readyAccount(GM);
    const theirs = await h.api(player.visit, "overview", on(gm.vault));
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toMatchObject({ code: "NO_VAULT" });
    expect(h.vaults.to(gm.vault, "dashboard")).toEqual([]);
  });

  it("removes one vault, with its keys and object, only when its name is typed", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const harbor = await h.addVault(player.visit, PLAYER, { name: "harbor-notes", id: 9101 });
    const token = await h.mintKey(harbor, { kind: "agent" });
    expect((await h.post(player.visit, "setup/vaults/remove", { id: harbor, confirm: "player/vault" })).status).toBe(400);
    expect((await h.post(player.visit, "setup/vaults/remove", { id: harbor, confirm: "player/harbor-notes" })).status).toBe(200);
    expect(h.vaults.to(harbor, "destroy")).toHaveLength(1);
    expect(await h.registry.keyForToken(token)).toBeUndefined();
    expect(h.vaults.to(player.vault, "destroy")).toEqual([]);
    expect(((await (await h.api(player.visit, "vaults")).json()) as HostedVaults).vaults.map((v) => v.id)).toEqual([player.vault]);
    // The repo is the person's own: nothing was written to it.
    expect(h.gh.at("player/harbor-notes").files()["_hippo/config.yaml"]).toBeDefined();
  });

  it("refuses a key at another vault's address, naming only the key's own", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const harbor = await h.addVault(player.visit, PLAYER, { name: "harbor-notes", id: 9101 });
    const token = await h.mintKey(player.vault, { kind: "agent" });
    expect((await h.callMcp(token, undefined, {}, `/mcp/${player.vault}`)).status).toBe(200);
    const wrong = await h.callMcp(token, undefined, {}, `/mcp/${harbor}`);
    expect(wrong.status).toBe(403);
    const body = (await wrong.json()) as { error: string; error_description: string };
    expect(body.error).toBe("wrong_vault");
    expect(body.error_description).toContain("player/vault");
    expect(body.error_description).not.toContain("harbor-notes");
    expect(h.vaults.to(harbor, "mcp")).toEqual([]);
    expect((await h.callMcp(token, undefined, {}, "/mcp/not-a-vault")).status).toBe(404);
    // The plain address still works: the key decides.
    expect((await h.callMcp(token)).status).toBe(200);
  });

  it("wipes every vault's object when the account is deleted", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const harbor = await h.addVault(player.visit, PLAYER, { name: "harbor-notes", id: 9101 });
    expect((await h.post(player.visit, "account/delete", { confirm: "player" })).status).toBe(200);
    expect(h.vaults.to(player.vault, "destroy")).toHaveLength(1);
    expect(h.vaults.to(harbor, "destroy")).toHaveLength(1);
  });
});

describe("sharing a vault", () => {
  async function sharedWith(role: "member" | "viewer" = "member") {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const made = (await (await h.post(player.visit, "vaults/members/invite", { role, human: "game-master", login: "game-master", domains: ["university"] })).json()) as HostedNewInvite;
    const gm = h.browser();
    await h.signIn(gm, "game-master");
    return { h, player, gm, made };
  }

  it("invites by login: the invitee sees it, accepts, is approved, and acts as their own human", async () => {
    const { h, player, gm, made } = await sharedWith();
    expect(made.link).toMatch(/^https:\/\/hippo\.test\/dashboard\/invite\/#hinv_/);
    expect(made.invite).toMatchObject({ vault: player.vault, role: "member", human: "game-master", login: "game-master" });
    const waiting = (await (await h.api(gm, "invites")).json()) as HostedInvites;
    expect(waiting.incoming).toEqual([expect.objectContaining({ id: made.invite.id, from: "player", vault: { id: player.vault, fullName: "player/vault" }, role: "member", human: "game-master" })]);

    const accepted = (await (await h.post(gm, "invites/accept", { id: made.invite.id })).json()) as { vault: HostedVault };
    expect(accepted.vault).toMatchObject({ id: player.vault, role: "member", human: "game-master" });
    expect(await (await h.api(gm, "session")).json()).toMatchObject({ vault: player.vault, user: { login: "game-master", role: "member", human: "game-master", account: { status: "approved" } } });
    expect(h.vaults.to(player.vault, "linkHuman")).toEqual([expect.objectContaining({ human: "game-master", logins: { github: "game-master" }, via: "@game-master", create: { domains: ["university"] } })]);

    const members = (await (await h.api(player.visit, "vaults/members")).json()) as HostedMembers;
    expect(members.members.map((m) => [m.login, m.role, m.human ?? null])).toEqual([
      ["player", "owner", null],
      ["game-master", "member", "game-master"],
    ]);
    expect(members.invites).toEqual([]);
    // The member sees who's in, but not the invites, and can't invite.
    expect(((await (await h.api(gm, "vaults/members")).json()) as HostedMembers).invites).toBeUndefined();
    expect((await h.post(gm, "vaults/members/invite", { role: "member", human: "job-scout" })).status).toBe(403);
  });

  it("lets a member make their own agent keys, not a curator's, and see only theirs", async () => {
    const { h, player, gm, made } = await sharedWith();
    await h.post(gm, "invites/accept", { id: made.invite.id });
    await h.post(player.visit, "setup/keys", { kind: "agent", label: "Player's" });
    expect((await h.post(gm, "setup/keys", { kind: "agent", label: "GM's" })).status).toBe(200);
    expect(await (await h.post(gm, "setup/keys", { kind: "curator" })).json()).toMatchObject({ code: "OWNER_ONLY" });
    expect(((await (await h.api(gm, "setup/keys")).json()) as { keys: { label: string }[] }).keys.map((k) => k.label)).toEqual(["GM's"]);
    expect(((await (await h.api(player.visit, "setup/keys")).json()) as { keys: { label: string }[] }).keys.map((k) => k.label).sort()).toEqual(["GM's", "Player's"]);
    expect(await (await h.post(gm, "setup/vaults/remove", { id: player.vault, confirm: "player/vault" })).json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps a viewer to reading", async () => {
    const { h, player, gm, made } = await sharedWith("viewer");
    await h.post(gm, "invites/accept", { id: made.invite.id });
    expect((await h.api(gm, "overview")).status).toBe(200);
    expect(await (await h.post(gm, "actions/remember", { text: "x" })).json()).toMatchObject({ code: "READ_ONLY" });
    expect(h.vaults.to(player.vault, "dashboard").filter((c) => c.user?.login === "game-master").map((c) => c.path)).toEqual(["/dashboard/api/overview"]);
    expect(await (await h.post(gm, "setup/keys", { kind: "agent" })).json()).toMatchObject({ code: "READ_ONLY" });
    // Promoted, they can write.
    await h.post(player.visit, "vaults/members/role", { user: ((await (await h.api(player.visit, "vaults/members")).json()) as HostedMembers).members[1]!.user, role: "member" });
    expect((await h.post(gm, "actions/remember", { text: "x" })).status).toBe(200);
  });

  it("removes a member with their keys, and unlinks their login; or they leave", async () => {
    const { h, player, gm, made } = await sharedWith();
    await h.post(gm, "invites/accept", { id: made.invite.id });
    const key = ((await (await h.post(gm, "setup/keys", { kind: "agent" })).json()) as { token: string }).token;
    const them = ((await (await h.api(player.visit, "vaults/members")).json()) as HostedMembers).members[1]!.user;
    expect((await h.post(player.visit, "vaults/members/remove", { user: them })).status).toBe(200);
    expect(await h.registry.keyForToken(key)).toBeUndefined();
    expect(h.vaults.to(player.vault, "linkHuman").at(-1)).toMatchObject({ human: "game-master", logins: { github: null }, via: "@player" });
    expect(((await (await h.api(gm, "vaults")).json()) as HostedVaults).vaults).toEqual([]);
    expect(await (await h.api(gm, "overview", { headers: { [VAULT_HEADER]: player.vault } })).json()).toMatchObject({ code: "NO_VAULT" });

    // Invited again, by link this time; then they leave on their own.
    const again = (await (await h.post(player.visit, "vaults/members/invite", { role: "member", human: "game-master" })).json()) as HostedNewInvite;
    const token = again.link.split("#")[1]!;
    expect(await (await h.post(gm, "invites/peek", { token })).json()).toMatchObject({ from: "player", vault: { fullName: "player/vault" } });
    // A link invite's id alone isn't enough: it takes the token.
    expect((await h.post(gm, "invites/accept", { id: again.invite.id })).status).toBe(410);
    expect((await h.post(gm, "invites/accept", { token })).status).toBe(200);
    expect((await h.post(gm, "invites/accept", { token })).status).toBe(410);
    expect((await h.post(gm, "vaults/leave", {})).status).toBe(200);
    expect((await h.post(player.visit, "vaults/leave", {})).status).toBe(403);
  });

  it("invites people to the app alone, and shows admins the referral graph", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const made = (await (await h.post(player.visit, "invites", {})).json()) as HostedNewInvite;
    expect(made.invite.vault).toBeUndefined();
    const scout = h.browser();
    await h.signIn(scout, "job-scout");
    expect(await (await h.api(scout, "session")).json()).toMatchObject({ account: { status: "waitlisted" } });
    expect(await (await h.post(scout, "invites/accept", { token: made.link.split("#")[1] })).json()).toEqual({});
    expect(await (await h.api(scout, "session")).json()).toMatchObject({ account: { status: "approved" } });
    expect(((await (await h.api(player.visit, "invites")).json()) as HostedInvites)).toMatchObject({ sent: [], accepted: 1, canInvite: true, limit: 10 });

    // game-master is the admin here.
    const gm = h.browser();
    await h.signIn(gm, "game-master");
    const graph = (await (await h.api(gm, "admin/referrals")).json()) as AdminReferrals;
    const byLogin = new Map(graph.people.map((p) => [p.login, p.user]));
    expect(graph.edges).toEqual([{ from: byLogin.get("player"), to: byLogin.get("job-scout"), at: expect.any(String) }]);
    expect(graph.people.find((p) => p.login === "job-scout")).toMatchObject({ invitedBy: byLogin.get("player"), status: "approved" });
    expect((await h.post(gm, "admin/referrals/invites", { user: byLogin.get("job-scout"), allow: false })).status).toBe(200);
    expect(await (await h.post(scout, "invites", {})).json()).toMatchObject({ code: "INVITES_OFF" });
    expect((await h.api(player.visit, "admin/referrals")).status).toBe(403);
  });
});

describe("connecting an app", () => {
  it("seats a new agent with its key, and frees the agent's name when the key is revoked", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const res = await h.post(player.visit, "setup/keys", { kind: "bound", agent: "claude-code", label: "Claude Code", seat: true, title: "Claude Code", app: "cursor" });
    const minted = (await res.json()) as { id: string; snippets: { label: string }[] };
    expect(res.status).toBe(200);
    expect(minted.snippets[0]!.label).toMatch(/^Cursor/);
    expect(h.vaults.to(player.vault, "addParty")).toEqual([expect.objectContaining({ input: expect.objectContaining({ id: "claude-code", title: "Claude Code" }), via: "@player" })]);
    // Already in the party: not seated twice.
    await h.post(player.visit, "setup/keys", { kind: "bound", agent: "claude-code", seat: true });
    expect(h.vaults.to(player.vault, "addParty")).toHaveLength(1);

    expect((await h.post(player.visit, "setup/keys/revoke", { id: minted.id })).status).toBe(200);
    expect(h.vaults.to(player.vault, "releaseClaims")).toEqual([expect.objectContaining({ credentials: [`key:${minted.id}`] })]);

    // A key for the vault's human can't be seated, so it isn't kept either.
    const human = await h.post(player.visit, "setup/keys", { kind: "bound", agent: "player", seat: true });
    expect(human.status).toBe(400);
    expect((await h.registry.keys(player.vault)).map((k) => k.agent)).toEqual(["claude-code"]);
  });
});

describe("one key per app", () => {
  it("remembers the app a key was made for, and lists who has spoken through each connection", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const res = await h.post(player.visit, "setup/keys", { kind: "agent", label: "Cursor", app: "cursor" });
    const minted = (await res.json()) as { id: string; kind: string; app?: string };
    expect(minted).toMatchObject({ kind: "agent", app: "cursor" });
    const bad = await h.post(player.visit, "setup/keys", { kind: "agent", app: "Not An App!" });
    expect(((await bad.json()) as { app?: string }).app).toBeUndefined();
    expect((await h.registry.keys(player.vault)).find((k) => k.id === minted.id)?.app).toBe("cursor");

    h.vaults.claimed.set(player.vault, [
      { agent: "cursor-home-finder", credential: `key:${minted.id}`, since: "2026-10-11T10:00:00.000Z" },
      { agent: "cursor-job-scout", credential: `key:${minted.id}`, since: "2026-10-11T11:00:00.000Z" },
    ]);
    const listed = (await (await h.api(player.visit, "setup/keys")).json()) as { keys: { id: string; app?: string }[]; agents: { agent: string; credential: string }[] };
    expect(listed.keys.find((k) => k.id === minted.id)?.app).toBe("cursor");
    expect(listed.agents.map((a) => a.agent)).toEqual(["cursor-home-finder", "cursor-job-scout"]);
  });
});

describe("an agent connecting on a person's behalf (device sign-in)", () => {
  const start = (h: Awaited<ReturnType<typeof hostedApp>>, body: Record<string, string>) =>
    h.send(new Request(`${ORIGIN}/connect/device`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }));
  const poll = (h: Awaited<ReturnType<typeof hostedApp>>, device_code: string) =>
    h.send(new Request(`${ORIGIN}/connect/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code }) }));

  it("gives the app one shared key for the vault the person approves, once", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const res = await start(h, { client_name: "Claude Code on the laptop" });
    const started = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number };
    expect(started).toMatchObject({ verification_uri: `${ORIGIN}/dashboard/connect/`, expires_in: 600, interval: 5 });
    expect(started.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.verification_uri_complete).toBe(`${ORIGIN}/dashboard/connect/?code=${started.user_code}`);

    expect(await (await poll(h, started.device_code)).json()).toMatchObject({ error: "authorization_pending" });
    expect(await (await poll(h, started.device_code)).json()).toMatchObject({ error: "slow_down" });

    const seen = (await (await h.api(player.visit, `connect?code=${started.user_code.toLowerCase()}`)).json()) as HostedDeviceRequest;
    expect(seen).toMatchObject({ client: "Claude Code on the laptop", vaults: [expect.objectContaining({ id: player.vault })] });
    // Approving is a write: our own origin only.
    expect((await h.post(player.visit, "connect/approve", { code: started.user_code, vault: player.vault }, {})).status).toBe(403);
    expect((await h.post(player.visit, "connect/approve", { code: started.user_code, vault: player.vault })).status).toBe(200);
    // Its agents name and introduce themselves: nothing is seated, and no agent is fixed.
    expect(h.vaults.to(player.vault, "addParty")).toEqual([]);

    const got = (await (await poll(h, started.device_code)).json()) as { access_token: string; token_type: string; mcp_url: string; agent?: string; server_name: string; claude_code: string };
    expect(got).toMatchObject({ token_type: "Bearer", mcp_url: `${ORIGIN}/mcp/${player.vault}`, server_name: "hippo-vault" });
    expect(got.agent).toBeUndefined();
    expect(got.claude_code).toContain(got.access_token);
    const key = (await h.registry.keyForToken(got.access_token))!;
    expect(key).toMatchObject({ kind: "agent", label: "Claude Code on the laptop", scopes: ["read", "remember", "goal"], vaultId: player.vault });
    expect(key.agent).toBeUndefined();
    expect((await h.callMcp(got.access_token, undefined, {}, `/mcp/${player.vault}`)).status).toBe(200);
    // Collected once: the device code is spent.
    expect(await (await poll(h, started.device_code)).json()).toMatchObject({ error: "expired_token" });
  });

  it("keeps to what the app asked for: read-only gets an agent of its own, since a shared key can't be read-only", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const asked = (await (await start(h, { client_name: "Dashboard Widget", access: "read" })).json()) as { device_code: string; user_code: string };
    // Whatever else the approval page posts is ignored: access is the app's own request.
    expect((await h.post(player.visit, "connect/approve", { code: asked.user_code, vault: player.vault, access: "curate", agent: "player", seat: true })).status).toBe(200);
    const got = (await (await poll(h, asked.device_code)).json()) as { access_token: string; agent: string };
    expect(got.agent).toBe("dashboard-widget");
    expect(await h.registry.keyForToken(got.access_token)).toMatchObject({ kind: "bound", agent: "dashboard-widget", scopes: ["read"] });
    expect(h.vaults.to(player.vault, "addParty")).toEqual([]);
  });

  it("lets the person refuse, keeps curators for owners, and refuses unknown grants and codes", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const one = (await (await start(h, { client_name: "Somebody's bot" })).json()) as { device_code: string; user_code: string };
    expect((await h.post(player.visit, "connect/deny", { code: one.user_code })).status).toBe(200);
    expect(await (await poll(h, one.device_code)).json()).toMatchObject({ error: "access_denied" });
    expect((await h.api(player.visit, `connect?code=${one.user_code}`)).status).toBe(410);

    const curator = (await (await start(h, { client_name: "Nightly curator", access: "curate" })).json()) as { device_code: string; user_code: string };
    await h.post(player.visit, "connect/approve", { code: curator.user_code, vault: player.vault, access: "curate" });
    const got = (await (await poll(h, curator.device_code)).json()) as { access_token: string; server_name: string };
    expect((await h.registry.keyForToken(got.access_token))?.kind).toBe("curator");
    expect(got.server_name).toBe("hippo-vault-curator");

    expect(await (await h.send(new Request(`${ORIGIN}/connect/token`, { method: "POST", body: new URLSearchParams({ grant_type: "password", device_code: "x" }) }))).json()).toMatchObject({ error: "unsupported_grant_type" });
    expect(await (await poll(h, "hdev_made-up")).json()).toMatchObject({ error: "expired_token" });
    expect((await start(h, {})).status).toBe(400);
  });
});

describe("what agents can read before signing in", () => {
  it("serves llms.txt, an MCP server card and an AI catalog, open to any origin and naming no vault", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const get = (path: string) => h.send(new Request(`${ORIGIN}${path}`));

    const llms = await get("/llms.txt");
    expect(llms.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await llms.text();
    expect(text).toMatch(/^# Hippocampus\n\n> /);
    expect(text).toContain(`POST ${ORIGIN}/connect/device`);
    expect(text).toContain("Never ask the person to paste a key into a chat");

    const card = await get("/mcp/server-card");
    expect(card.status).toBe(200);
    expect(card.headers.get("content-type")).toBe("application/mcp-server-card+json");
    expect(card.headers.get("access-control-allow-origin")).toBe("*");
    const c = (await card.json()) as { $schema: string; name: string; description: string; remotes: { type: string; url: string; supportedProtocolVersions: string[] }[] };
    expect(c.$schema).toBe("https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json");
    expect(c.name.split("/")).toHaveLength(2);
    expect(c.description.length).toBeLessThanOrEqual(100);
    expect(c.remotes[0]).toMatchObject({ type: "streamable-http", url: `${ORIGIN}/mcp` });
    expect(c.remotes[0]!.supportedProtocolVersions.length).toBeGreaterThan(0);

    const catalog = (await (await get("/.well-known/ai-catalog.json")).json()) as { entries: { identifier: string; type: string; url: string }[] };
    expect(catalog.entries).toEqual([{ identifier: expect.stringMatching(/^urn:air:/), type: "application/mcp-server-card+json", url: `${ORIGIN}/mcp/server-card` }]);

    for (const body of [text, JSON.stringify(c), JSON.stringify(catalog)]) {
      expect(body).not.toContain(player.vault);
      expect(body).not.toContain("player/vault");
    }
    // The card isn't behind the OAuth guard; MCP itself still is.
    expect((await h.send(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }))).status).toBe(401);
  });

  it("names its icon in the server card and answers /favicon.ico with it", async () => {
    const h = await hostedApp();
    const card = (await (await h.send(new Request(`${ORIGIN}/mcp/server-card`))).json()) as { icons: { src: string; mimeType: string }[] };
    expect(card.icons.map((i) => [i.src, i.mimeType])).toEqual([
      [`${ORIGIN}/dashboard/icon.png`, "image/png"],
      [`${ORIGIN}/dashboard/favicon.svg`, "image/svg+xml"],
    ]);

    const ico = await h.send(new Request(`${ORIGIN}/favicon.ico`));
    expect(ico.status).toBe(200);
    expect(await ico.text()).toBe("the icon");
    expect((await h.send(new Request(`${ORIGIN}/favicon.ico`, { method: "POST" }))).status).toBe(405);
  });
});
