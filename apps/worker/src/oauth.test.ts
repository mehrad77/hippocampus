import type { HostedConnectedApp } from "@hippocampus/dashboard";
import { describe, expect, it } from "vitest";
import { ORIGIN } from "./hosted/testing.ts";
import { GM, PLAYER, hostedApp, type HostedHarness, type Visit } from "./testing/hosted-app.ts";

const CLIENT_REDIRECT = "https://claude.example/api/mcp/auth_callback";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const s256 = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));

async function register(h: HostedHarness, clientName = "Claude"): Promise<string> {
  const res = await h.send(
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** An MCP client starting OAuth: registered, and its authorize URL. */
async function client(h: HostedHarness, opts: { clientName?: string; scope?: string; resource?: string } = {}) {
  const clientId = await register(h, opts.clientName);
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    scope: opts.scope ?? "read remember",
    state: "client-state",
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    resource: opts.resource ?? `${ORIGIN}/mcp`,
  });
  return { clientId, verifier, resource: opts.resource ?? `${ORIGIN}/mcp`, authorizeUrl: `${ORIGIN}/authorize?${params}` };
}

/** Up to the consent page, in a signed-in browser. */
async function consent(h: HostedHarness, visit: Visit, opts: { clientName?: string; scope?: string; resource?: string } = {}) {
  const c = await client(h, opts);
  const res = await visit(c.authorizeUrl);
  const page = await res.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)?.[1];
  const submit = (fields: Record<string, string | string[]>, using = visit, headers: Record<string, string> = { origin: ORIGIN }) => {
    const form = new URLSearchParams({ handle: field("handle") ?? "", account: field("account") ?? "", vault: field("vault") ?? "" });
    for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) (k === "vault" ? form.set(k, x) : form.append(k, x));
    return using(`${ORIGIN}/authorize`, { method: "POST", body: form, headers });
  };
  return { ...c, res, page, submit };
}

/** The client trades its code for tokens. */
async function exchange(h: HostedHarness, flow: { clientId: string; verifier: string; resource?: string }, approved: Response) {
  const back = new URL(approved.headers.get("location")!);
  expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
  expect(back.searchParams.get("state")).toBe("client-state");
  const res = await h.send(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: CLIENT_REDIRECT, client_id: flow.clientId, code_verifier: flow.verifier, resource: flow.resource ?? `${ORIGIN}/mcp` }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; scope: string };
}

/** Approve the consent page, and the tokens that come of it. */
async function connect(h: HostedHarness, visit: Visit, fields: Record<string, string | string[]> = {}, opts: { clientName?: string; resource?: string } = {}) {
  const flow = await consent(h, visit, opts);
  const approved = await flow.submit({ decision: "approve", ...fields });
  expect(approved.status).toBe(302);
  return { ...(await exchange(h, flow, approved)), clientId: flow.clientId };
}

describe("connecting an app over OAuth", () => {
  it("signs the person in first, then comes back to the consent page", async () => {
    const h = await hostedApp();
    await h.readyAccount(PLAYER);
    const { authorizeUrl } = await client(h);
    const fresh = h.browser();
    const toLogin = await fresh(authorizeUrl);
    expect(toLogin.status).toBe(302);
    const login = new URL(toLogin.headers.get("location")!, ORIGIN);
    expect(login.pathname).toBe("/dashboard/auth/login");
    expect(login.searchParams.get("return")).toBe(authorizeUrl.slice(ORIGIN.length));
    const toGitHub = await fresh(login.href);
    const back = await fresh(h.github.signIn(toGitHub.headers.get("location")!, "player"));
    expect(back.headers.get("location")).toBe(authorizeUrl.slice(ORIGIN.length));
    const page = await fresh(`${ORIGIN}${back.headers.get("location")}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Connect Claude to your vault?");
  });

  it("refuses a bad request before any sign-in", async () => {
    const h = await hostedApp();
    const res = await h.send(new Request(`${ORIGIN}/authorize?response_type=code&client_id=nobody&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}`));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("sends accounts without a ready vault to finish setting up", async () => {
    const h = await hostedApp();
    const visit = h.browser();
    await h.signIn(visit, "player");
    const waiting = await consent(h, visit);
    expect(waiting.res.status).toBe(403);
    expect(waiting.page).toContain("/dashboard/setup/");
    await h.registry.setAccountStatus(PLAYER.id, "approved");
    const noVault = await consent(h, visit);
    expect(noVault.res.status).toBe(409);
    expect(noVault.page).toContain("/dashboard/setup/");
  });

  it("asks only which vault, and says the app's agents name themselves", async () => {
    const h = await hostedApp();
    const { visit } = await h.readyAccount(PLAYER);
    const flow = await consent(h, visit, { clientName: `<script>alert("hi")</script>`, scope: "read remember quest curate" });
    expect(flow.res.status).toBe(200);
    expect(flow.res.headers.get("x-frame-options")).toBe("DENY");
    // Browsers send `Origin: null` on a form post from a no-referrer page, which the origin check would refuse.
    expect(flow.res.headers.get("referrer-policy")).toBe("same-origin");
    expect(flow.res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const page = flow.page;
    expect(page).not.toContain("<script>");
    expect(page).toContain("&#60;script&#62;");
    expect(page).toContain("claude.example");
    expect(page).toContain("player/vault");
    // No agent, scope or name to choose: the app is named after itself, and its agents name themselves.
    for (const field of ['name="agent"', 'name="new_agent"', 'name="scope"', 'name="add_to_party"', 'name="label"']) expect(page).not.toContain(field);
    expect(page).toContain("Each agent in the app names itself");
  });

  it("grants the shared set for the account's vault, with no agent and no party change", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    const tokens = await connect(h, visit);
    // Goals also under their old name, so a rolled-back Worker (which knows only `quest`) keeps them.
    // An owner's app also carries `curate` as the most it may do; whether it does is a switch (off here: the box wasn't ticked).
    expect(tokens.scope.split(" ").sort()).toEqual(["curate", "goal", "quest", "read", "remember"]);
    const res = await h.callMcp(tokens.access_token);
    const seen = (await res.json()) as { vault: string; grant: Record<string, unknown> };
    expect(seen.vault).toBe(vault);
    expect(seen.grant).toEqual({ scopes: ["read", "remember", "goal", "quest", "curate"], via: "oauth", credential: expect.stringMatching(/^oauth:/), curate: false });
    const [grant] = (await h.app.oauth.listUserGrants("account-4242")).items;
    expect(grant!.metadata).toEqual({ label: "Claude", vaultId: vault, curate: false });
    expect(h.vaults.to(vault, "addParty")).toEqual([]);
  });

  it("ignores an agent, scopes or party posted by hand", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    const tokens = await connect(h, visit, { new_agent: "claude-ai", agent: "home-finder", add_to_party: "1", scope: ["read", "curate"] });
    const seen = (await (await h.callMcp(tokens.access_token)).json()) as { grant: Record<string, unknown> };
    expect(seen.grant.agent).toBeUndefined();
    expect(seen.grant.scopes).toEqual(["read", "remember", "goal", "quest", "curate"]);
    expect(seen.grant.curate).toBe(false);
    expect(h.vaults.to(vault, "addParty")).toEqual([]);
  });

  it("still serves a grant made when apps were bound to one agent", async () => {
    const h = await hostedApp();
    const { vault } = await h.readyAccount(PLAYER);
    const flow = await client(h);
    const request = await h.app.oauth.parseAuthRequest(new Request(flow.authorizeUrl));
    const { redirectTo } = await h.app.oauth.completeAuthorization({ request, userId: "account-4242", metadata: { vaultId: vault }, scope: ["read", "remember"], props: { kind: "oauth", vaultId: vault, accountId: PLAYER.id, agent: "claude-ai" } });
    const { access_token } = await exchange(h, flow, new Response(null, { status: 302, headers: { location: redirectTo } }));
    expect(await (await h.callMcp(access_token)).json()).toMatchObject({ vault, grant: { agent: "claude-ai", scopes: ["read", "remember"] } });
  });

  it("lets the person deny", async () => {
    const h = await hostedApp();
    const { visit } = await h.readyAccount(PLAYER);
    const flow = await consent(h, visit);
    const res = await flow.submit({ decision: "deny" });
    const back = new URL(res.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("refuses a consent form from another site, another browser or another account", async () => {
    const h = await hostedApp();
    const { visit } = await h.readyAccount(PLAYER);
    const gm = await h.readyAccount(GM);
    const flow = await consent(h, visit);
    const fields = { decision: "approve" };
    expect((await flow.submit(fields, visit, { origin: "https://evil.test" })).status).toBe(403);
    expect((await flow.submit(fields, visit, {})).status).toBe(403);
    // Another account's browser: the page was shown to someone else.
    const otherAccount = await flow.submit(fields, gm.visit);
    expect(otherAccount.status).toBe(400);
    expect(await otherAccount.text()).toContain("switched accounts");
    // Same account, another browser: the library binds the form's handle to the browser that loaded it.
    const elsewhere = h.browser();
    await h.signIn(elsewhere, "player");
    const forged = await flow.submit(fields, elsewhere);
    expect(forged.status).toBe(400);
    expect(forged.headers.get("location")).toBeNull();
    expect((await h.app.oauth.listUserGrants(`account-${GM.id}`)).items).toEqual([]);
    expect((await h.app.oauth.listUserGrants(`account-${PLAYER.id}`)).items).toEqual([]);
    expect((await flow.submit(fields)).status).toBe(302);
  });

  it("honours scopes narrowed on refresh", async () => {
    const h = await hostedApp();
    const { visit } = await h.readyAccount(PLAYER);
    const first = await connect(h, visit);
    const refreshed = await h.send(
      new Request(`${ORIGIN}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId, scope: "read" }) }),
    );
    const { access_token } = (await refreshed.json()) as { access_token: string };
    expect(await (await h.callMcp(access_token)).json()).toMatchObject({ grant: { scopes: ["read"] } });
  });
});

describe("OAuth grants at the MCP endpoint", () => {
  it("send grants from before hosted vaults back through OAuth", async () => {
    const h = await hostedApp();
    await h.readyAccount(PLAYER);
    // What the single-vault Worker stored: an agent and a login, no vault.
    const flow = await client(h);
    const request = await h.app.oauth.parseAuthRequest(new Request(flow.authorizeUrl));
    const { redirectTo } = await h.app.oauth.completeAuthorization({ request, userId: "github-1", metadata: {}, scope: ["read"], props: { kind: "oauth", agent: "claude-ai", login: "player" } });
    const { access_token } = await exchange(h, flow, new Response(null, { status: 302, headers: { location: redirectTo } }));
    const res = await h.callMcp(access_token);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer realm="OAuth", resource_metadata="https:\/\/hippo\.test\/\.well-known\/oauth-protected-resource\/mcp", error="invalid_token"/);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
    expect(h.vaults.calls.filter((c) => c.method === "mcp")).toEqual([]);
  });

  it("stop at a disconnected vault, and end with the account", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    const { access_token } = await connect(h, visit);
    expect((await h.callMcp(access_token)).status).toBe(200);
    const repo = { id: PLAYER.repo, full_name: "player/vault" };
    await h.deliver("repository", { action: "publicized", repository: repo });
    const refused = await h.callMcp(access_token);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "vault_unavailable" });
    await h.deliver("repository", { action: "privatized", repository: repo });
    expect((await h.callMcp(access_token)).status).toBe(200);
    await h.post(visit, "account/delete", { confirm: "player" });
    expect((await h.callMcp(access_token)).status).toBe(401);
    expect((await h.app.oauth.listUserGrants("account-4242")).items).toEqual([]);
    expect(h.vaults.to(vault, "mcp")).toHaveLength(2);
  });

  it("reach only the vault of the account that approved them", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const gm = await h.readyAccount(GM);
    const mine = await connect(h, player.visit);
    const theirs = await connect(h, gm.visit);
    expect(await (await h.callMcp(mine.access_token)).json()).toMatchObject({ vault: player.vault });
    expect(await (await h.callMcp(theirs.access_token)).json()).toMatchObject({ vault: gm.vault });
  });
});

describe("connecting at a vault's address", () => {
  it("accepts the address as the resource, and the token works there", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    const resource = `${ORIGIN}/mcp/${vault}`;
    const tokens = await connect(h, visit, {}, { resource });
    const res = await h.callMcp(tokens.access_token, undefined, {}, `/mcp/${vault}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ vault, grant: { via: "oauth" } });
    // Plain /mcp follows the grant's vault.
    expect(await (await h.callMcp(tokens.access_token)).json()).toMatchObject({ vault });
  });

  it("starts at the vault the address named", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const harbor = await h.addVault(player.visit, PLAYER, { name: "harbor-notes", id: 9101 });
    // Signed in, the person's current vault is the first; the address names the second.
    for (const [named, other] of [[harbor, player.vault], [player.vault, harbor]] as const) {
      const flow = await consent(h, player.visit, { resource: `${ORIGIN}/mcp/${named}` });
      expect(flow.res.status).toBe(200);
      expect(flow.page).toContain(`<option value="${named}" selected>`);
      expect(flow.page).not.toContain(`<option value="${other}" selected>`);
      const tokens = await exchange(h, flow, await flow.submit({ decision: "approve", vault: named }));
      expect(await (await h.callMcp(tokens.access_token)).json()).toMatchObject({ vault: named });
    }
  });

  it("keeps the vault through sign-in", async () => {
    const h = await hostedApp();
    const { vault } = await h.readyAccount(PLAYER);
    const { authorizeUrl } = await client(h, { resource: `${ORIGIN}/mcp/${vault}` });
    const fresh = h.browser();
    const toLogin = await fresh(authorizeUrl);
    const login = new URL(toLogin.headers.get("location")!, ORIGIN);
    const toGitHub = await fresh(login.href);
    const back = await fresh(h.github.signIn(toGitHub.headers.get("location")!, "player"));
    expect(await (await fresh(`${ORIGIN}${back.headers.get("location")}`)).text()).toContain("Connect Claude to your vault?");
  });

  it("still refuses a resource that isn't ours", async () => {
    const h = await hostedApp();
    await h.readyAccount(PLAYER);
    const { authorizeUrl } = await client(h, { resource: "https://elsewhere.test/mcp" });
    const res = await h.browser()(authorizeUrl);
    // Straight back to the client with invalid_target, before any sign-in.
    expect(new URL(res.headers.get("location") ?? "https://none.test").searchParams.get("error")).toBe("invalid_target");
  });

  it("describes itself at the address, at the root and at /mcp", async () => {
    const h = await hostedApp();
    const { vault } = await h.readyAccount(PLAYER);
    const meta = async (path: string) => h.send(new Request(`${ORIGIN}/.well-known/oauth-protected-resource${path}`));
    const at = await meta(`/mcp/${vault}`);
    expect(at.status).toBe(200);
    expect(at.headers.get("access-control-allow-origin")).toBe("*");
    expect(await at.json()).toMatchObject({ resource: `${ORIGIN}/mcp/${vault}`, authorization_servers: [ORIGIN] });
    expect(await (await meta("")).json()).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    expect(await (await meta("/mcp")).json()).toMatchObject({ resource: `${ORIGIN}/mcp` });
    expect((await meta("/mcp/not-a-vault")).status).toBe(404);
    expect((await h.send(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/${vault}`, { method: "OPTIONS" }))).status).toBe(204);
  });

  it("answers an unauthenticated address with metadata for that address", async () => {
    const h = await hostedApp();
    const { vault } = await h.readyAccount(PLAYER);
    const res = await h.send(new Request(`${ORIGIN}/mcp/${vault}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/${vault}"`);
    const plain = await h.send(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(plain.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("names itself on every call, like a shared key", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    const { access_token } = await connect(h, visit, {}, { resource: `${ORIGIN}/mcp/${vault}` });
    const seen = (await (await h.callMcp(access_token)).json()) as { grant: Record<string, unknown> };
    expect(seen.grant.agent).toBeUndefined();
  });
});

describe("connected apps", () => {
  it("lists the account's apps and revokes them", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const gm = await h.readyAccount(GM);
    const { access_token } = await connect(h, player.visit, {}, { clientName: "Claude" });
    await connect(h, gm.visit, {}, { clientName: "ChatGPT" });
    const list = async (visit: Visit) => ((await (await h.api(visit, "account/apps")).json()) as { apps: HostedConnectedApp[] }).apps;
    const apps = await list(player.visit);
    expect(apps).toEqual([{ id: expect.any(String), client: "Claude", scopes: ["read", "remember", "goal", "quest", "curate"], vault: expect.stringMatching(/^[0-9A-Z]{26}$/), created: expect.any(String), curate: false, mayCurate: true }]);
    const [theirs] = await list(gm.visit);
    expect((await h.post(player.visit, "account/apps/revoke", { id: theirs!.id })).status).toBe(404);
    expect((await h.post(player.visit, "account/apps/revoke", { id: "../x" })).status).toBe(400);
    expect((await h.post(player.visit, "account/apps/revoke", { id: apps[0]!.id }, {})).status).toBe(403);
    expect(await (await h.post(player.visit, "account/apps/revoke", { id: apps[0]!.id })).json()).toEqual({ ok: true });
    expect(await list(player.visit)).toEqual([]);
    expect((await h.callMcp(access_token)).status).toBe(401);
    expect(await list(gm.visit)).toHaveLength(1);
  });
});

describe("letting an app curate", () => {
  const list = async (h: HostedHarness, visit: Visit) => ((await (await h.api(visit, "account/apps")).json()) as { apps: HostedConnectedApp[] }).apps;

  it("offers the owner a ticked box, and grants curating as the app's ceiling with the box as its starting switch", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    const flow = await consent(h, visit);
    expect(flow.page).toMatch(/<input type="checkbox" name="curate" checked>/);
    expect(flow.page).toContain("secret and confidential values included");

    const { access_token } = await exchange(h, flow, await flow.submit({ decision: "approve", curate: "on" }));
    const seen = (await (await h.callMcp(access_token)).json()) as { grant: Record<string, unknown> };
    expect(seen.grant).toMatchObject({ scopes: ["read", "remember", "goal", "quest", "curate"], curate: true });
    const [app] = await list(h, visit);
    expect(app).toMatchObject({ vault, curate: true, mayCurate: true });
  });

  it("turns it on and off from the account's apps list, as the owner only", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const gm = await h.readyAccount(GM);
    await connect(h, player.visit, {});
    const [app] = await list(h, player.visit);
    expect(app).toMatchObject({ curate: false, mayCurate: true });

    expect((await h.post(player.visit, "account/apps/curate", { id: app!.id, on: true })).status).toBe(200);
    expect(h.vaults.to(player.vault, "setCurate")).toEqual([expect.objectContaining({ credential: `oauth:${app!.id}`, on: true })]);
    expect((await list(h, player.visit))[0]).toMatchObject({ curate: true, mayCurate: true });
    await h.post(player.visit, "account/apps/curate", { id: app!.id, on: false });
    expect((await list(h, player.visit))[0]).toMatchObject({ curate: false });

    expect((await h.post(player.visit, "account/apps/curate", { id: app!.id, on: "yes" })).status).toBe(400);
    expect((await h.post(player.visit, "account/apps/curate", { id: "../x", on: true })).status).toBe(400);
    expect((await h.post(player.visit, "account/apps/curate", { id: app!.id, on: true }, {})).status).toBe(403);
    // Another account's app isn't theirs to switch.
    expect((await h.post(gm.visit, "account/apps/curate", { id: app!.id, on: true })).status).toBe(404);
  });

  it("gives a member's app no curating, however the form is posted, and refuses to switch it", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const made = (await (await h.post(player.visit, "vaults/members/invite", { role: "member", human: "game-master", login: "game-master", domains: ["university"] })).json()) as { invite: { id: string } };
    const gm = h.browser();
    await h.signIn(gm, "game-master");
    await h.post(gm, "invites/accept", { id: made.invite.id });

    const flow = await consent(h, gm);
    expect(flow.page).not.toContain('name="curate"');
    const { access_token, scope } = await exchange(h, flow, await flow.submit({ decision: "approve", curate: "on" }));
    expect(scope.split(" ")).not.toContain("curate");
    const seen = (await (await h.callMcp(access_token)).json()) as { grant: Record<string, unknown> };
    expect(seen.grant.scopes).not.toContain("curate");
    expect(seen.grant.curate).toBeUndefined();
    const [app] = await list(h, gm);
    expect(app).toMatchObject({ curate: false, mayCurate: false });
    expect((await h.post(gm, "account/apps/curate", { id: app!.id, on: true })).status).toBe(403);
  });

  it("asks the owner of another vault's app to connect again when it predates curating", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    const flow = await client(h);
    const request = await h.app.oauth.parseAuthRequest(new Request(flow.authorizeUrl));
    const { redirectTo } = await h.app.oauth.completeAuthorization({ request, userId: "account-4242", metadata: { vaultId: vault }, scope: ["read", "remember"], props: { kind: "oauth", vaultId: vault, accountId: PLAYER.id } });
    await exchange(h, flow, new Response(null, { status: 302, headers: { location: redirectTo } }));
    const [old] = await list(h, visit);
    expect(old).toMatchObject({ curate: false, mayCurate: false });
    expect((await h.post(visit, "account/apps/curate", { id: old!.id, on: true })).status).toBe(409);
  });
});
