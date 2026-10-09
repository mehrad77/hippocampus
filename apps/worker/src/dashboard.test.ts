import { HippoService } from "@hippocampus/core";
import { createDashboardApi, serviceSource, type MintedToken, type RemoteSetupStatus, type TokenInfo } from "@hippocampus/dashboard";
import { GitHubStore, MemoryBlobCache, SnapshotCache } from "@hippocampus/store-github";
import { FakeGitHub } from "@hippocampus/store-github/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../../packages/core/src/__fixtures__/vault.ts";
import { createApp } from "./app.ts";
import { hashToken, kvTokens, newToken } from "./auth.ts";
import { DASHBOARD_API, DASHBOARD_CALLBACK, createDashboardGate, safeReturn } from "./dashboard.ts";
import { oauthMissing } from "./github-login.ts";
import { remoteSetup } from "./remote-setup.ts";
import { ScribeQueue, ScribeStore } from "./scribe.ts";
import { browser, fakeGitHubOAuth, testOAuthSettings } from "./testing/github-oauth.ts";
import { MemoryKV } from "./testing/memory-kv.ts";

const ORIGIN = "https://hippo.test";
const now = () => new Date("2026-09-27T21:00:00.000Z");

/** The asset store, enough of it: `index.html` for directories, `.html` for extensionless paths. */
function fakeAssets(files: Record<string, string>) {
  return {
    async fetch(request: Request) {
      const { pathname } = new URL(request.url);
      const body = files[pathname.endsWith("/") ? `${pathname}index.html` : `${pathname}.html`] ?? files[pathname];
      if (body === undefined && files[`${pathname}/index.html`]) return new Response(null, { status: 307, headers: { location: `${pathname}/` } });
      if (body === undefined) return new Response("Not Found", { status: 404 });
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" } });
    },
  };
}

async function setup(opts: { oauth?: boolean; origin?: string } = {}) {
  const origin = opts.origin ?? ORIGIN;
  const gh = await FakeGitHub.create(Object.fromEntries(fixtureStore().files));
  const blobs = new MemoryBlobCache();
  const snapshots = new SnapshotCache();
  const github = () => new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch, cache: blobs, snapshots });
  const scribe = new ScribeQueue(github());
  const service = () => new HippoService(new ScribeStore(github(), scribe), { now });
  const upstream = fakeGitHubOAuth();
  const settings = opts.oauth === false ? undefined : testOAuthSettings(origin, upstream);
  const missing = settings ? [] : oauthMissing({});
  const sessions = new MemoryKV();
  const tokensKV = new MemoryKV();
  const tokens = kvTokens(tokensKV);
  const gate = createDashboardGate({
    settings,
    missing,
    kv: sessions,
    assets: fakeAssets({ "/dashboard/index.html": "<!doctype html><title>Tavern</title>", "/dashboard/404.html": "<!doctype html><title>Lost</title>" }),
    api: (guard) =>
      createDashboardApi({
        basePath: DASHBOARD_API,
        source: () => serviceSource(service(), { mode: "worker", vault: { kind: "github", repo: gh.repo, branch: "main" } }),
        setup: remoteSetup({ settings, oauthMissing: missing, tokens, repo: { name: gh.repo, branch: "main", info: () => github().info() }, service, now }),
        guard,
      }),
  });
  const app = createApp({ service, tokens, dashboard: gate.fetch });
  const visit = browser(app);

  /** Sign-in through GitHub as `login`, from the dashboard page at `ret`. Returns the callback's response. */
  const signIn = async (login = "player", ret = "/dashboard/quests/", using = visit) => {
    const toGitHub = await using(`${origin}/dashboard/auth/login?return=${encodeURIComponent(ret)}`);
    return using(upstream.signIn(toGitHub.headers.get("location")!, login));
  };
  const api = (path: string, init: RequestInit & { json?: unknown } = {}, using = visit) => {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return using(`${origin}${DASHBOARD_API}/${path}`, { ...init, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) });
  };
  const post = (path: string, json: unknown, headers: Record<string, string> = { origin }) => api(path, { method: "POST", json, headers });
  const connect = async (token: string) => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { fetch: (url, init) => app(new Request(url, init)), requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    return client;
  };
  return { gh, app, visit, signIn, api, post, connect, settings, sessions, tokensKV, upstream };
}

const cookies = (res: Response) => res.headers.getSetCookie();

describe("dashboard sign-in", () => {
  it("refuses the API without a session", async () => {
    const { api } = await setup();
    const res = await api("session");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "SIGN_IN", login: "/dashboard/auth/login" });
  });

  it("sends the owner to GitHub with a state, a PKCE challenge and the dashboard's callback", async () => {
    const { visit, sessions } = await setup();
    const res = await visit(`${ORIGIN}/dashboard/auth/login?return=%2Fdashboard%2Fquests%2F`);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://github.test/login/oauth/authorize");
    const state = to.searchParams.get("state")!;
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ client_id: "gh-client", redirect_uri: `${ORIGIN}${DASHBOARD_CALLBACK}`, code_challenge_method: "S256", allow_signup: "false" });
    expect(to.searchParams.has("scope")).toBe(false);
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(cookies(res)).toEqual([`__Host-hippo_login=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`]);
    const pending = (await sessions.get(`dashboard:login:${state}`, "json")) as { verifier: string; return: string };
    expect(pending.return).toBe("/dashboard/quests/");
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier)))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(to.searchParams.get("code_challenge")).toBe(challenge);
  });

  it("starts on the public URL, where GitHub sends the owner back", async () => {
    const { visit } = await setup();
    const res = await visit("https://hippocampus.other.test/dashboard/auth/login?return=%2Fdashboard%2F");
    expect(res.headers.get("location")).toBe(`${ORIGIN}/dashboard/auth/login?return=%2Fdashboard%2F`);
    expect(cookies(res)).toEqual([]);
  });

  it("refuses a callback that this browser didn't start, and a replayed one", async () => {
    const { app, visit, upstream } = await setup();
    const toGitHub = await visit(`${ORIGIN}/dashboard/auth/login`);
    const callback = upstream.signIn(toGitHub.headers.get("location")!, "player");
    const elsewhere = await browser(app)(callback);
    expect(elsewhere.status).toBe(400);
    expect(cookies(elsewhere).some((c) => c.startsWith("__Host-hippo_session="))).toBe(false);
    const state = new URL(callback).searchParams.get("state")!;
    expect((await visit(callback.replace(state, "forged"))).status).toBe(400);

    // The real browser, its login cookie intact.
    visit.jar.set("__Host-hippo_login", state);
    expect((await visit(callback)).status).toBe(302);
    // Replayed, even with the login cookie put back: the state was used up.
    visit.jar.set("__Host-hippo_login", state);
    expect((await visit(callback)).status).toBe(400);
  });

  it("refuses GitHub accounts that don't own the vault", async () => {
    const { signIn, api } = await setup();
    const res = await signIn("someone-else");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("@someone-else");
    expect(cookies(res).some((c) => c.startsWith("__Host-hippo_session="))).toBe(false);
    expect((await api("session")).status).toBe(401);
  });

  it("signs an owner in with a strict session cookie, stored only hashed, and returns to the page", async () => {
    const { signIn, api, sessions, visit } = await setup();
    const res = await signIn("player", "/dashboard/quests/?quest=residence-permit");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/quests/?quest=residence-permit");
    const session = cookies(res).find((c) => c.startsWith("__Host-hippo_session="))!;
    expect(session).toMatch(/^__Host-hippo_session=[\w-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=604800$/);
    expect(cookies(res)).toContain("__Host-hippo_login=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    const id = visit.jar.get("__Host-hippo_session")!;
    expect([...sessions.entries.keys()]).toEqual([`dashboard:session:${await hashToken(id)}`]);
    expect(await sessions.get(`dashboard:session:${await hashToken(id)}`, "json")).toMatchObject({ login: "player", githubId: 6000 });

    const info = await api("session");
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ mode: "worker", user: { login: "player" }, campaign: "lisbon-arc", capabilities: { setup: "remote", remember: true } });
    const overview = await api("overview");
    expect(overview.status).toBe(200);
    expect(((await overview.json()) as { party: { slug: string }[] }).party.map((p) => p.slug)).toEqual(expect.arrayContaining(["residency-agent", "campus-agent", "home-finder"]));
  });

  it("lands only on dashboard pages of this origin", () => {
    for (const bad of [null, "", "/", "/mcp", "//evil.example/dashboard/", "https://evil.example/dashboard/", "/dashboard", "/dashboard/../mcp", "/dashboard/%2e%2e/mcp"]) expect(safeReturn(bad, ORIGIN)).toBe("/dashboard/");
    expect(safeReturn("/dashboard/quests/?quest=x#top", ORIGIN)).toBe("/dashboard/quests/?quest=x#top");
  });

  it("refuses writes from other origins, and takes them from its own", async () => {
    const { signIn, post, gh } = await setup();
    await signIn();
    const memory = { text: "Harbor University library card is ready for pickup" };
    expect((await post("actions/remember", memory, {})).status).toBe(403);
    expect((await post("actions/remember", memory, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("actions/remember", memory, { origin: ORIGIN, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(gh.log()).toHaveLength(1);
    const ok = await post("actions/remember", memory, { origin: ORIGIN, "sec-fetch-site": "same-origin" });
    expect(ok.status).toBe(200);
    expect(gh.log()[0]!.message).toMatch(/^remember\(player\): ep-/);
  });

  it("locks out someone removed from the owners at once", async () => {
    const { signIn, api, settings } = await setup();
    await signIn();
    expect((await api("session")).status).toBe(200);
    settings!.owners.delete("player");
    expect((await api("session")).status).toBe(401);
  });

  it("signs out", async () => {
    const { signIn, api, visit, sessions } = await setup();
    await signIn();
    const res = await visit(`${ORIGIN}/dashboard/auth/logout`, { method: "POST", headers: { origin: ORIGIN } });
    expect(res.status).toBe(204);
    expect(cookies(res)).toEqual(["__Host-hippo_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"]);
    expect(sessions.entries.size).toBe(0);
    expect((await api("session")).status).toBe(401);
    // A plain form post goes back to the dashboard.
    const form = await visit(`${ORIGIN}/dashboard/auth/logout`, { method: "POST", headers: { origin: ORIGIN, accept: "text/html" } });
    expect(form.status).toBe(303);
    expect(form.headers.get("location")).toBe("/dashboard/");
    expect((await visit(`${ORIGIN}/dashboard/auth/logout`)).status).toBe(405);
  });

  it("works over plain http for wrangler dev, without __Host- or Secure", async () => {
    const origin = "http://127.0.0.1:8787";
    const { signIn, api } = await setup({ origin });
    const res = await signIn();
    expect(res.status).toBe(302);
    expect(cookies(res).find((c) => c.startsWith("hippo_session="))).toMatch(/^hippo_session=[\w-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/);
    expect((await api("session")).status).toBe(200);
  });
});

describe("dashboard pages", () => {
  it("serves the UI with security headers but no script or style policy of its own", async () => {
    const { visit } = await setup();
    const res = await visit(`${ORIGIN}/dashboard/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Tavern");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect((await visit(`${ORIGIN}/dashboard`)).headers.get("location")).toBe("/dashboard/");
    expect((await visit(`${ORIGIN}/dashboard/`, { method: "POST" })).status).toBe(405);
  });

  it("answers unknown pages with the UI's 404 page", async () => {
    const { visit } = await setup();
    const res = await visit(`${ORIGIN}/dashboard/nowhere/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Lost");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("sends browsers from / to the dashboard", async () => {
    const { app } = await setup();
    const res = await app(new Request(`${ORIGIN}/`, { headers: { accept: "text/html" } }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/");
    expect(await (await app(new Request(`${ORIGIN}/`))).text()).toContain("/mcp");
  });

  it("loads without OAuth, while the API and sign-in say what's missing", async () => {
    const { visit, api, app } = await setup({ oauth: false });
    expect((await visit(`${ORIGIN}/dashboard/`)).status).toBe(200);
    const res = await api("session");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "OAUTH_OFF", needs: ["HIPPO_PUBLIC_URL", "HIPPO_OWNERS", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"] });
    const login = await visit(`${ORIGIN}/dashboard/auth/login`);
    expect(login.status).toBe(503);
    expect(await login.text()).toContain("HIPPO_PUBLIC_URL");
    expect((await visit(`${ORIGIN}${DASHBOARD_CALLBACK}?code=x&state=y`)).status).toBe(503);
    // MCP is unaffected.
    expect((await app(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }))).status).toBe(401);
  });
});

describe("Session Zero on the Worker", () => {
  it("mints, lists and revokes agent tokens that work on /mcp", async () => {
    const { signIn, api, post, connect, tokensKV, app } = await setup();
    expect((await post("setup/tokens", { agent: "home-finder", scopes: ["read", "remember"] })).status).toBe(401);
    await signIn();

    const res = await post("setup/tokens", { agent: "Home-Finder", scopes: ["remember", "read", "read"] });
    expect(res.status).toBe(200);
    const minted = (await res.json()) as MintedToken;
    expect(minted).toMatchObject({ agent: "home-finder", scopes: ["read", "remember"], created: now().toISOString() });
    expect(minted.token).toMatch(/^hippo_/);
    expect(minted.id).toBe(await hashToken(minted.token));
    expect(minted.snippets[0]!.code).toBe(`claude mcp add --transport http hippocampus ${ORIGIN}/mcp --header "Authorization: Bearer ${minted.token}"`);
    // Only the hash is stored, with the grant as metadata so listing is one call.
    expect(tokensKV.entries.get(minted.id)!.metadata).toEqual({ agent: "home-finder", scopes: ["read", "remember"], created: now().toISOString() });
    expect(JSON.stringify([...tokensKV.entries])).not.toContain(minted.token);

    // A token minted before grants were kept as metadata is still listed.
    const legacy = newToken();
    await tokensKV.put(await hashToken(legacy), JSON.stringify({ agent: "campus-agent", scopes: ["read"] }));
    const list = (await (await api("setup/tokens")).json()) as { tokens: TokenInfo[] };
    expect(list.tokens).toEqual([
      { id: await hashToken(legacy), agent: "campus-agent", scopes: ["read"] },
      { id: minted.id, agent: "home-finder", scopes: ["read", "remember"], created: now().toISOString() },
    ]);

    const client = await connect(minted.token);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("remember");

    expect(await (await post("setup/tokens/revoke", { id: minted.id })).json()).toEqual({ ok: true });
    expect((await app(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${minted.token}` }, body: "{}" }))).status).toBe(401);
    expect((await post("setup/tokens/revoke", { id: minted.id })).status).toBe(404);
  });

  it("refuses bad token requests", async () => {
    const { signIn, post } = await setup();
    await signIn();
    for (const body of [
      { agent: "Not An Id!", scopes: ["read"] },
      { agent: "home-finder" },
      { agent: "home-finder", scopes: ["remember"] },
      { agent: "home-finder", scopes: ["read", "admin"] },
    ]) {
      const res = await post("setup/tokens", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID" });
    }
    expect((await post("setup/tokens/revoke", { id: "nope" })).status).toBe(400);
  });

  it("reports health and how each party member connects", async () => {
    const { signIn, api, gh } = await setup();
    await signIn();
    const status = (await (await api("setup/status")).json()) as RemoteSetupStatus;
    expect(status).toMatchObject({
      kind: "remote",
      publicUrl: ORIGIN,
      oauth: { on: true, owners: 1, missing: [] },
      repo: { name: gh.repo, branch: "main", private: true, head: gh.refs.get("main") },
    });
    expect(status.items.map((i) => i.id)).toEqual(["oauth", "repo", "party", "agents", "tokens", "index"]);
    expect(status.items.find((i) => i.id === "repo")!.state).toBe("done");
    const homeFinder = status.agents.find((a) => a.agent === "home-finder")!;
    expect(homeFinder.title).toBe("Home Finder");
    expect(homeFinder.snippets.map((s) => s.code)).toEqual(
      expect.arrayContaining([`claude mcp add --transport http hippocampus ${ORIGIN}/mcp --header "Authorization: Bearer <token>"`, `${ORIGIN}/mcp`]),
    );

    gh.isPrivate = false;
    const exposed = (await (await api("setup/status")).json()) as RemoteSetupStatus;
    expect(exposed.items.find((i) => i.id === "repo")).toMatchObject({ state: "error" });
  });
});
