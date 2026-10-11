import { describe, expect, it } from "vitest";
import { VAULT_HEADER, type AdminReferrals, type HostedInvites, type HostedMembers, type HostedNewInvite, type HostedVault, type HostedVaults } from "@hippocampus/dashboard";
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
      grant: { agent: "home-finder", scopes: ["read", "remember"], via: "key", keyKind: "bound" },
      body: expect.stringContaining("tools/list"),
    });
    expect((await grantFor({ kind: "agent" })).grant).toEqual({ scopes: ["read", "remember", "goal"], via: "key", keyKind: "agent" });
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
