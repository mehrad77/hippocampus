import { AuthorizationError, OAuthProvider, authorizationErrorRedirect, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { SCOPES, type Scope } from "@hippocampus/mcp";
import { HOME, plain } from "./app.ts";
import { lookupToken, type Grant, type TokenStore } from "./auth.ts";

export interface OAuthSettings {
  /** Public origin of this Worker, e.g. `https://hippocampus.you.workers.dev`. */
  publicUrl: string;
  github: { clientId: string; clientSecret: string; oauthUrl: string; apiUrl: string };
  /** GitHub logins allowed to connect apps: the vault's owners. */
  owners: Set<string>;
  fetch?: typeof fetch;
}

export interface OAuthVars {
  HIPPO_PUBLIC_URL?: string;
  HIPPO_OWNERS?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** Only for local development against a fake GitHub. */
  GITHUB_OAUTH_URL?: string;
  GITHUB_API_URL?: string;
}

/** What a token's grant carries. OAuth scopes come from the token itself, since refreshes can narrow them. */
type GrantProps = { kind: "oauth"; agent: string; login: string } | { kind: "token"; agent: string; scopes: Scope[] };

export const CALLBACK_PATH = "/oauth/github/callback";
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const isScope = (s: string): s is Scope => (SCOPES as readonly string[]).includes(s);

/** OAuth settings, or undefined when OAuth is off (no HIPPO_PUBLIC_URL): then only agent tokens work. */
export function oauthSettings(env: OAuthVars): OAuthSettings | undefined {
  if (!env.HIPPO_PUBLIC_URL) return undefined;
  const missing = (["HIPPO_OWNERS", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"] as const).filter((k) => !env[k]);
  if (missing.length) throw new Error(`OAuth is on (HIPPO_PUBLIC_URL is set) but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} missing`);
  // Fail closed: no owners would mean nobody can connect, so refuse to start rather than guess.
  const owners = new Set(env.HIPPO_OWNERS!.split(/[\s,]+/).filter(Boolean).map((l) => l.toLowerCase()));
  if (!owners.size) throw new Error("HIPPO_OWNERS must list at least one GitHub login");
  return {
    publicUrl: new URL(env.HIPPO_PUBLIC_URL).origin,
    github: {
      clientId: env.GITHUB_OAUTH_CLIENT_ID!,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET!,
      oauthUrl: (env.GITHUB_OAUTH_URL || "https://github.com").replace(/\/$/, ""),
      apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, ""),
    },
    owners,
  };
}

/** The agent and scopes a verified token grants, from either kind of token. */
export function grantFromContext(ctx: { props?: unknown; auth?: { scope?: string[] } }): Grant | undefined {
  const props = ctx.props as Partial<GrantProps> | undefined;
  if (!props?.agent) return undefined;
  if (props.kind === "token") return { agent: props.agent, scopes: (props.scopes ?? []).filter(isScope) };
  if (props.kind === "oauth") return { agent: props.agent, scopes: (ctx.auth?.scope ?? []).filter(isScope) };
  return undefined;
}

/**
 * OAuth 2.1 for MCP connectors (Claude.ai, ChatGPT): this Worker is the authorization server and
 * the resource. The owner approves each app on a consent page (choosing the agent it acts as and
 * its scopes), then proves ownership by signing in with GitHub. Agent tokens keep working.
 */
export function createOAuthProvider(settings: OAuthSettings, opts: { mcp: (request: Request, grant: Grant) => Promise<Response>; tokens: TokenStore }) {
  const resource = `${settings.publicUrl}/mcp`;
  return new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request: Request, _env: unknown, ctx: { props?: unknown; auth?: { scope?: string[] } }) {
        const grant = grantFromContext(ctx);
        return grant ? opts.mcp(request, grant) : plain(403, "This token carries no agent");
      },
    },
    defaultHandler: {
      fetch: (request: Request, env: unknown) => authorizationPages(request, (env as { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER, settings),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [...SCOPES],
    requiredScopes: ["read"],
    resourceMetadata: { resource, authorization_servers: [settings.publicUrl], resource_name: "Hippocampus", bearer_methods_supported: ["header"] },
    // Agent tokens are ours too (minted by `agent-token`), just not through OAuth; nothing is forwarded upstream.
    resolveExternalToken: async ({ token }) => {
      const grant = await lookupToken(token, opts.tokens);
      if (!grant) return null;
      const props: GrantProps = { kind: "token", agent: grant.agent, scopes: grant.scopes };
      return { props, audience: resource };
    },
  });
}

async function authorizationPages(request: Request, oauth: OAuthHelpers, settings: OAuthSettings): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/") return plain(200, HOME);
    if (pathname === "/authorize" && request.method === "GET") return await showConsent(request, oauth);
    if (pathname === "/authorize" && request.method === "POST") return await decide(request, oauth, settings);
    if (pathname === CALLBACK_PATH && request.method === "GET") return await finishSignIn(request, oauth, settings);
    return plain(404, "Not found");
  } catch (err) {
    // Redirect only once the client and its redirect URI are validated; otherwise explain here.
    if (err instanceof AuthorizationError && err.redirectTo) return redirect(err.redirectTo);
    if (err instanceof AuthorizationError) return page(400, "This sign-in can't continue", `<p>${escape(err.description)}</p><p>Start again from the app you were connecting.</p>`);
    throw err;
  }
}

async function showConsent(request: Request, oauth: OAuthHelpers): Promise<Response> {
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return html(200, consentPage(details, consent.handle), consent.headers);
}

/** The owner's answer. Approval leads to GitHub sign-in; nothing is granted until that proves ownership. */
async function decide(request: Request, oauth: OAuthHelpers, settings: OAuthSettings): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    denied.headers.set("Location", denied.redirectTo);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  // Checked before approving, so going back and fixing the form still works.
  const agent = String(form.get("agent") ?? "").trim().toLowerCase();
  if (!AGENT_ID.test(agent)) return page(400, "Check the agent id", "<p>Use lowercase letters, digits and dashes, like <code>claude-ai</code>. Go back and try again.</p>");
  const scope = form.getAll("scope").map(String).filter(isScope);
  if (!scope.length) return page(400, "Choose what it may do", "<p>Tick at least one permission. Go back and try again.</p>");

  const approved = await oauth.approveConsent(request, handle, { scope });
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier, agent }, headers: approved.headers });
  const github = new URL(`${settings.github.oauthUrl}/login/oauth/authorize`);
  // No `scope`: signing in only needs the public profile, to learn who this is.
  for (const [k, v] of Object.entries({
    client_id: settings.github.clientId,
    redirect_uri: `${settings.publicUrl}${CALLBACK_PATH}`,
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    allow_signup: "false",
  }))
    github.searchParams.set(k, v);
  headers.set("Location", github.href);
  return new Response(null, { status: 302, headers });
}

async function finishSignIn(request: Request, oauth: OAuthHelpers, settings: OAuthSettings): Promise<Response> {
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string; agent: string }>(request);
  const deny = (description: string) => {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied", description));
    return new Response(null, { status: 302, headers });
  };
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return deny("GitHub sign-in was cancelled");
  const user = await githubUser(settings, code, data.verifier);
  if (!user) return deny("GitHub sign-in failed");
  if (!settings.owners.has(user.login.toLowerCase())) return deny("This GitHub account is not an owner of this vault");
  const props: GrantProps = { kind: "oauth", agent: data.agent, login: user.login };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: `github-${user.id}`,
    metadata: { login: user.login, agent: data.agent },
    scope: original.scope,
    props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

/** Who signed in. The GitHub token is used for this one lookup and not kept. */
async function githubUser(settings: OAuthSettings, code: string, verifier: string): Promise<{ login: string; id: number } | undefined> {
  const f = settings.fetch ?? fetch;
  const exchange = await f(`${settings.github.oauthUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: settings.github.clientId,
      client_secret: settings.github.clientSecret,
      code,
      redirect_uri: `${settings.publicUrl}${CALLBACK_PATH}`,
      code_verifier: verifier,
    }),
  });
  const { access_token } = (await exchange.json().catch(() => ({}))) as { access_token?: string };
  if (!exchange.ok || !access_token) return undefined;
  const res = await f(`${settings.github.apiUrl}/user`, {
    headers: { authorization: `Bearer ${access_token}`, accept: "application/vnd.github+json", "user-agent": "hippocampus" },
  });
  if (!res.ok) return undefined;
  const user = (await res.json()) as { login?: string; id?: number };
  return user.login && user.id ? { login: user.login, id: user.id } : undefined;
}

const SCOPE_LABELS: Record<Scope, string> = {
  read: "Read the vault: recall, look up notes, briefings",
  remember: "Remember: add new memories to its inbox",
  quest: "Update quests: objectives, status, clocks",
};

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : "This app registered itself; its name is not verified.";
  const requested = new Set(details.scope);
  const scopes = SCOPES.map(
    (s) =>
      `<label><input type="checkbox" name="scope" value="${s}"${s !== "quest" || requested.has(s) ? " checked" : ""}> ${escape(SCOPE_LABELS[s])}</label>`,
  ).join("\n");
  const suggested = details.clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "connector";
  return `<h1>Connect ${name} to your Hippocampus vault?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<p><label>Acts as agent <input name="agent" value="${escape(suggested)}" pattern="[a-z0-9][a-z0-9\\-]{0,62}" required></label><br>
<small>Its memories are filed under <code>inbox/&lt;agent&gt;/</code>. Use a party member's id to give it that lane.</small></p>
<fieldset><legend>It may</legend>
${scopes}
</fieldset>
<p>Next you'll sign in with GitHub to confirm you own this vault.</p>
<p><button name="decision" value="approve">Continue</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}label{display:block;margin:.25rem 0}fieldset{border:1px solid #ccc;border-radius:6px}button{font:inherit;padding:.4rem 1rem}";

function html(status: number, body: string, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  // A second policy on top of the library's frame-ancestors: no scripts or remote content at all.
  headers.append("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hippocampus</title><style>${STYLE}</style>${body}`, { status, headers });
}

const page = (status: number, title: string, body: string) => html(status, `<h1>${escape(title)}</h1>${body}`);

const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
