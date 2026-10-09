import { HippoService } from "@hippocampus/core";
import { GitHubStore, MemoryBlobCache, SnapshotCache } from "@hippocampus/store-github";
import { FakeGitHub } from "@hippocampus/store-github/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../../packages/core/src/__fixtures__/vault.ts";
import { createMcpHandler } from "./app.ts";
import { hashToken, newToken, type Grant } from "./auth.ts";
import { CALLBACK_PATH, createOAuthProvider, oauthSettings, type OAuthSettings } from "./oauth.ts";
import { ScribeQueue, ScribeStore } from "./scribe.ts";
import { MemoryKV } from "./testing/memory-kv.ts";

const ORIGIN = "https://hippo.test";
const CLIENT_REDIRECT = "https://claude.example/api/mcp/auth_callback";
const now = () => new Date("2026-09-27T21:00:00.000Z");

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const s256 = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));

/** GitHub's OAuth endpoints, enough to sign someone in: checks the app's secret and PKCE. */
function fakeGitHubOAuth() {
  const codes = new Map<string, { challenge: string; login: string; id: number }>();
  const tokens = new Map<string, { login: string; id: number }>();
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.href === "https://github.test/login/oauth/access_token") {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      const grant = codes.get(body.code!);
      codes.delete(body.code!);
      const ok = grant && body.client_id === "gh-client" && body.client_secret === "gh-secret" && (await s256(body.code_verifier!)) === grant.challenge;
      if (!ok) return Response.json({ error: "bad_verification_code" });
      const token = `gho_${crypto.randomUUID()}`;
      tokens.set(token, grant);
      return Response.json({ access_token: token, token_type: "bearer", scope: "" });
    }
    if (url.href === "https://api.github.test/user") {
      const user = tokens.get(new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "");
      return user ? Response.json(user) : new Response("{}", { status: 401 });
    }
    return new Response("not found", { status: 404 });
  };
  /** The user signs in at GitHub, which redirects back with a code. */
  const signIn = (authorizeUrl: string, login: string) => {
    const u = new URL(authorizeUrl);
    const code = `gh-${crypto.randomUUID()}`;
    codes.set(code, { challenge: u.searchParams.get("code_challenge")!, login, id: login.length * 1000 });
    return `${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}`;
  };
  return { fetch, signIn };
}

async function setup() {
  const gh = await FakeGitHub.create(Object.fromEntries(fixtureStore().files));
  const blobs = new MemoryBlobCache();
  const snapshots = new SnapshotCache();
  const github = () => new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch, cache: blobs, snapshots });
  const scribe = new ScribeQueue(github());
  const grants = new Map<string, Grant>();
  const upstream = fakeGitHubOAuth();
  const settings: OAuthSettings = {
    ...oauthSettings({ HIPPO_PUBLIC_URL: ORIGIN, HIPPO_OWNERS: "Player", GITHUB_OAUTH_CLIENT_ID: "gh-client", GITHUB_OAUTH_CLIENT_SECRET: "gh-secret", GITHUB_OAUTH_URL: "https://github.test", GITHUB_API_URL: "https://api.github.test" })!,
    fetch: upstream.fetch as typeof fetch,
  };
  const provider = createOAuthProvider(settings, {
    mcp: createMcpHandler({ service: () => new HippoService(new ScribeStore(github(), scribe), { now }) }),
    tokens: { get: async (hash) => grants.get(hash) ?? null },
  });
  const env = { OAUTH_KV: new MemoryKV() };
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
  const send = (request: Request) => provider.fetch(request, env as never, ctx as never);

  /** A browser: keeps cookies, doesn't follow redirects. */
  const browser = () => {
    const jar = new Map<string, string>();
    return async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      const res = await send(new Request(url, { ...init, headers, redirect: "manual" }));
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attrs] = c.split(";");
        const [name, value] = pair!.split(/=(.*)/s) as [string, string];
        if (!value || attrs.some((a) => /max-age=0/i.test(a.trim()))) jar.delete(name.trim());
        else jar.set(name.trim(), value);
      }
      return res;
    };
  };

  const register = async (clientName = "Claude") => {
    const res = await send(
      new Request(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: clientName, redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
      }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  };

  /** Up to the consent page, as an MCP client sends the owner there. */
  const startAuthorization = async (opts: { clientName?: string; scope?: string } = {}) => {
    const clientId = await register(opts.clientName);
    const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      scope: opts.scope ?? "read",
      state: "client-state",
      code_challenge: await s256(verifier),
      code_challenge_method: "S256",
      resource: `${ORIGIN}/mcp`,
    });
    const visit = browser();
    const consent = await visit(`${ORIGIN}/authorize?${params}`);
    const page = await consent.text();
    const handle = /name="handle" value="([^"]+)"/.exec(page)?.[1];
    const submit = (fields: Record<string, string | string[]>, using = visit) => {
      const form = new URLSearchParams({ handle: handle! });
      for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) form.append(k, x);
      return using(`${ORIGIN}/authorize`, { method: "POST", body: form });
    };
    return { clientId, verifier, visit, consent, page, submit };
  };

  /** The whole dance: consent, GitHub sign-in, code exchange. Returns the token response, or the client's error. */
  const authorize = async (opts: { agent?: string; scope?: string[]; login?: string; clientName?: string } = {}) => {
    const flow = await startAuthorization({ clientName: opts.clientName });
    const toGitHub = await flow.submit({ decision: "approve", agent: opts.agent ?? "claude-ai", scope: opts.scope ?? ["read", "remember"] });
    expect(toGitHub.status).toBe(302);
    const back = await flow.visit(upstream.signIn(toGitHub.headers.get("location")!, opts.login ?? "player"));
    const toClient = new URL(back.headers.get("location")!);
    if (!toClient.searchParams.get("code")) return { error: toClient.searchParams.get("error"), description: toClient.searchParams.get("error_description") };
    expect(toClient.searchParams.get("state")).toBe("client-state");
    const token = await send(
      new Request(`${ORIGIN}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "authorization_code", code: toClient.searchParams.get("code")!, redirect_uri: CLIENT_REDIRECT, client_id: flow.clientId, code_verifier: flow.verifier, resource: `${ORIGIN}/mcp` }),
      }),
    );
    expect(token.status).toBe(200);
    return { ...((await token.json()) as { access_token: string; refresh_token: string; scope: string }), clientId: flow.clientId };
  };

  const connect = async (token: string) => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        fetch: (url, init) => send(new Request(url, init)),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };

  const mint = async (agent: string, scopes: Grant["scopes"]) => {
    const token = newToken();
    grants.set(await hashToken(token), { agent, scopes });
    return token;
  };

  return { gh, send, browser, startAuthorization, authorize, connect, mint };
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

describe("OAuth for MCP connectors", () => {
  it("points unauthenticated clients at the authorization server", async () => {
    const { send } = await setup();
    const res = await send(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain('scope="read"');
    const resource = (await (await send(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`))).json()) as { resource: string; authorization_servers: string[] };
    expect(resource).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const server = (await (await send(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>;
    expect(server).toMatchObject({ authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register` });
    expect(server.scopes_supported).toEqual(["read", "remember", "quest"]);
  });

  it("connects an app as the agent and with the scopes the owner chose", async () => {
    const { gh, authorize, connect } = await setup();
    const token = await authorize({ agent: "claude-ai", scope: ["read", "remember"] });
    expect(token).toHaveProperty("access_token");
    const client = await connect((token as { access_token: string }).access_token);
    const tools = await toolNames(client);
    expect(tools).toContain("remember");
    expect(tools).not.toContain("update_quest");
    await client.callTool({ name: "remember", arguments: { text: "Enrolment at Harbor University opens 2026-10-01" } });
    expect(gh.log()[0]!.message).toMatch(/^remember\(claude-ai\): ep-/);
  });

  it("honours scopes narrowed on refresh", async () => {
    const { send, authorize, connect } = await setup();
    const first = (await authorize({ scope: ["read", "remember", "quest"] })) as { refresh_token: string; clientId: string };
    const refreshed = await send(
      new Request(`${ORIGIN}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId, scope: "read" }) }),
    );
    const { access_token } = (await refreshed.json()) as { access_token: string };
    expect(await toolNames(await connect(access_token))).not.toContain("remember");
  });

  it("refuses GitHub accounts that don't own the vault", async () => {
    const { authorize } = await setup();
    expect(await authorize({ login: "someone-else" })).toEqual({ error: "access_denied", description: "This GitHub account is not an owner of this vault" });
  });

  it("lets the owner deny", async () => {
    const { startAuthorization } = await setup();
    const flow = await startAuthorization();
    const res = await flow.submit({ decision: "deny" });
    const back = new URL(res.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("shows a consent page that can't be framed and escapes what the app registered", async () => {
    const { startAuthorization } = await setup();
    const { consent, page } = await startAuthorization({ clientName: `<script>alert("hi")</script>` });
    expect(consent.status).toBe(200);
    expect(page).not.toContain("<script>");
    expect(page).toContain("&#60;script&#62;");
    expect(page).toContain("claude.example");
    expect(consent.headers.get("x-frame-options")).toBe("DENY");
    expect(consent.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("refuses a consent form posted from another browser", async () => {
    const { startAuthorization, browser } = await setup();
    const flow = await startAuthorization();
    const forged = await flow.submit({ decision: "approve", agent: "attacker", scope: ["read", "remember", "quest"] }, browser());
    expect(forged.status).toBe(400);
    expect(forged.headers.get("location")).toBeNull();
  });

  it("checks the agent id before approving, so the form can be fixed", async () => {
    const { startAuthorization } = await setup();
    const flow = await startAuthorization();
    expect((await flow.submit({ decision: "approve", agent: "Not An Id!", scope: "read" })).status).toBe(400);
    expect((await flow.submit({ decision: "approve", agent: "claude-ai", scope: "read" })).status).toBe(302);
  });

  it("refuses a replayed GitHub callback", async () => {
    const { startAuthorization } = await setup();
    const flow = await startAuthorization();
    const toGitHub = await flow.submit({ decision: "approve", agent: "claude-ai", scope: "read" });
    const state = new URL(toGitHub.headers.get("location")!).searchParams.get("state");
    const callback = `${ORIGIN}${CALLBACK_PATH}?code=whatever&state=${state}`;
    await flow.visit(callback);
    expect((await flow.visit(callback)).status).toBe(400);
  });

  it("still accepts agent tokens, with their own scopes", async () => {
    const { send, connect, mint } = await setup();
    expect(await toolNames(await connect(await mint("home-finder", ["read"])))).not.toContain("remember");
    const unknown = await send(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: "Bearer hippo_unknown" }, body: "{}" }));
    expect(unknown.status).toBe(401);
  });
});

describe("oauthSettings", () => {
  it("is off without a public URL and fails closed when half configured", () => {
    expect(oauthSettings({})).toBeUndefined();
    expect(() => oauthSettings({ HIPPO_PUBLIC_URL: ORIGIN, GITHUB_OAUTH_CLIENT_ID: "x", GITHUB_OAUTH_CLIENT_SECRET: "y" })).toThrow(/HIPPO_OWNERS/);
    expect(() => oauthSettings({ HIPPO_PUBLIC_URL: ORIGIN, HIPPO_OWNERS: " , ", GITHUB_OAUTH_CLIENT_ID: "x", GITHUB_OAUTH_CLIENT_SECRET: "y" })).toThrow(/at least one/);
    expect(oauthSettings({ HIPPO_PUBLIC_URL: "https://Hippo.Test/", HIPPO_OWNERS: "Player", GITHUB_OAUTH_CLIENT_ID: "x", GITHUB_OAUTH_CLIENT_SECRET: "y" })).toMatchObject({
      publicUrl: "https://hippo.test",
      owners: new Set(["player"]),
    });
  });
});
