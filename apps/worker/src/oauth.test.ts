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
async function client(h: HostedHarness, opts: { clientName?: string; scope?: string } = {}) {
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
    resource: `${ORIGIN}/mcp`,
  });
  return { clientId, verifier, authorizeUrl: `${ORIGIN}/authorize?${params}` };
}

/** Up to the consent page, in a signed-in browser. */
async function consent(h: HostedHarness, visit: Visit, opts: { clientName?: string; scope?: string } = {}) {
  const c = await client(h, opts);
  const res = await visit(c.authorizeUrl);
  const page = await res.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)?.[1];
  const submit = (fields: Record<string, string | string[]>, using = visit, headers: Record<string, string> = { origin: ORIGIN }) => {
    const form = new URLSearchParams({ handle: field("handle") ?? "", account: field("account") ?? "" });
    for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) form.append(k, x);
    return using(`${ORIGIN}/authorize`, { method: "POST", body: form, headers });
  };
  return { ...c, res, page, submit };
}

/** The client trades its code for tokens. */
async function exchange(h: HostedHarness, flow: { clientId: string; verifier: string }, approved: Response) {
  const back = new URL(approved.headers.get("location")!);
  expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
  expect(back.searchParams.get("state")).toBe("client-state");
  const res = await h.send(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: CLIENT_REDIRECT, client_id: flow.clientId, code_verifier: flow.verifier, resource: `${ORIGIN}/mcp` }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; scope: string };
}

/** Consent as `agent` with `scope`, and the tokens that come of it. */
async function connect(h: HostedHarness, visit: Visit, fields: Record<string, string | string[]>, opts: { clientName?: string } = {}) {
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

  it("asks which agent and what it may do, with curate off and explained", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    h.vaults.parties.set(vault, [
      { id: "home-finder", title: "Home finder" },
      { id: "campus-agent", title: "Campus <agent>" },
    ]);
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
    expect(page).toContain('<option value="home-finder">Home finder (home-finder)</option>');
    expect(page).toContain("Campus &#60;agent&#62;");
    const checked = [...page.matchAll(/<input type="checkbox" name="scope" value="(\w+)"( checked)?>/g)].map((m) => [m[1], !!m[2]]);
    // Whatever the app asked for, only read and remember start ticked.
    expect(checked).toEqual([
      ["read", true],
      ["remember", true],
      ["quest", false],
      ["curate", false],
    ]);
    expect(page).toMatch(/secret memories in plain text/);
  });

  it("grants the chosen agent and scopes for the account's vault", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    h.vaults.parties.set(vault, [{ id: "home-finder", title: "Home finder" }]);
    const tokens = await connect(h, visit, { agent: "home-finder", scope: ["read", "remember"] });
    expect(tokens.scope).toBe("read remember");
    const res = await h.callMcp(tokens.access_token);
    expect(await res.json()).toMatchObject({ vault, grant: { agent: "home-finder", scopes: ["read", "remember"], via: "oauth" } });
    const [grant] = (await h.app.oauth.listUserGrants("account-4242")).items;
    expect(grant!.metadata).toEqual({ label: "Claude", vaultId: vault, agent: "home-finder" });
    expect(h.vaults.to(vault, "addParty")).toEqual([]);
  });

  it("can add a new agent to the party as it connects", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    const flow = await consent(h, visit, { clientName: "Claude Desktop" });
    // An empty party: the new id is suggested and adding it is ticked.
    expect(flow.page).toContain('name="new_agent" value="claude-desktop"');
    expect(flow.page).toMatch(/name="add_to_party" value="1" checked/);
    const approved = await flow.submit({ decision: "approve", new_agent: "claude-desktop", new_title: "Claude Desktop", add_to_party: "1", scope: ["read", "remember"] });
    expect(approved.status).toBe(302);
    expect(h.vaults.to(vault, "addParty")).toEqual([expect.objectContaining({ input: { id: "claude-desktop", title: "Claude Desktop" }, via: "@player" })]);
    const tokens = await exchange(h, flow, approved);
    expect(await (await h.callMcp(tokens.access_token)).json()).toMatchObject({ grant: { agent: "claude-desktop" } });
    // Already in the party: it isn't added twice.
    await connect(h, visit, { new_agent: "claude-desktop", add_to_party: "1", scope: "read" });
    expect(h.vaults.to(vault, "addParty")).toHaveLength(1);
  });

  it("checks the agent id and scopes before approving, so the form can be fixed", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    const flow = await consent(h, visit);
    expect((await flow.submit({ decision: "approve", new_agent: "Not An Id!", scope: "read" })).status).toBe(400);
    expect((await flow.submit({ decision: "approve", new_agent: "curator", scope: "read" })).status).toBe(400);
    expect((await flow.submit({ decision: "approve", new_agent: "claude-ai", scope: "remember" })).status).toBe(400);
    const refused = await flow.submit({ decision: "approve", new_agent: "player", add_to_party: "1", scope: "read" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("human");
    expect(h.vaults.parties.get(vault) ?? []).toEqual([]);
    expect((await flow.submit({ decision: "approve", new_agent: "claude-ai", scope: "read" })).status).toBe(302);
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
    const fields = { decision: "approve", new_agent: "attacker", scope: ["read", "remember", "quest"] };
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
    const first = await connect(h, visit, { new_agent: "claude-ai", scope: ["read", "remember", "quest"] });
    const refreshed = await h.send(
      new Request(`${ORIGIN}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId, scope: "read" }) }),
    );
    const { access_token } = (await refreshed.json()) as { access_token: string };
    expect(await (await h.callMcp(access_token)).json()).toMatchObject({ grant: { agent: "claude-ai", scopes: ["read"] } });
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
    const { access_token } = await connect(h, visit, { new_agent: "claude-ai", scope: "read" });
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
    const mine = await connect(h, player.visit, { new_agent: "claude-ai", scope: "read" });
    const theirs = await connect(h, gm.visit, { new_agent: "claude-ai", scope: ["read", "curate"] });
    expect(await (await h.callMcp(mine.access_token)).json()).toMatchObject({ vault: player.vault, grant: { scopes: ["read"] } });
    expect(await (await h.callMcp(theirs.access_token)).json()).toMatchObject({ vault: gm.vault, grant: { scopes: ["read", "curate"] } });
  });
});

describe("connected apps", () => {
  it("lists the account's apps and revokes them", async () => {
    const h = await hostedApp();
    const player = await h.readyAccount(PLAYER);
    const gm = await h.readyAccount(GM);
    const { access_token } = await connect(h, player.visit, { new_agent: "claude-ai", scope: ["read", "remember"] }, { clientName: "Claude" });
    await connect(h, gm.visit, { new_agent: "chatgpt", scope: "read" }, { clientName: "ChatGPT" });
    const list = async (visit: Visit) => ((await (await h.api(visit, "account/apps")).json()) as { apps: HostedConnectedApp[] }).apps;
    const apps = await list(player.visit);
    expect(apps).toEqual([{ id: expect.any(String), client: "Claude", scopes: ["read", "remember"], agent: "claude-ai", created: expect.any(String) }]);
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
