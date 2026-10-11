import { AuthorizationError, CimdFetchError, type ConsentDescription, type GrantSummary, type OAuthHelpers, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { LEGACY_GOAL_SCOPE, SCOPES, type Scope } from "@hippocampus/mcp";
import { isScope } from "./auth.ts";
import type { ConnectedApp, ConnectedApps } from "./hosted/account.ts";
import { KIND_SCOPES, type Account, type KeyGrant, type KeyKind, type MemberVault, type VaultRecord } from "./hosted/registry.ts";
import type { Caller } from "./hosted/routes.ts";
import { LOGIN_PATH } from "./hosted/session.ts";
import { vaultMeta, type VaultGrant, type VaultMeta, type VaultStub } from "./hosted/vault-port.ts";
import { escape, html, page } from "./pages.ts";

// OAuth 2.1 for MCP connectors (Claude.ai, ChatGPT): this Worker is the authorization server and
// the resource. People sign in to the hosted app first, then approve each app on a consent page
// that picks the vault. The app's agents name themselves on each call, as with a shared key. Vault
// keys (`hippo_…`) work alongside.

export const MCP_PATH = "/mcp";
/** A vault id (a ULID). */
const VAULT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The vault an MCP address names: `/mcp/<vault id>` gives the id, plain `/mcp` gives undefined (the
 * credential's vault), anything else null.
 */
export function addressedVault(pathname: string): string | undefined | null {
  const rest = pathname.slice(MCP_PATH.length).replace(/\/+$/, "");
  if (!rest) return undefined;
  const id = rest.slice(1);
  return rest.startsWith("/") && VAULT_ID.test(id) ? id : null;
}

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
/** Carries the vault a connector's address named through sign-in to the consent page. Ours alone, never the client's. */
const VAULT_HINT = "hippo_vault";

/**
 * Protected-resource metadata (RFC 9728) for `/mcp`, or for one vault's address. A client that was
 * given `/mcp/<vault id>` expects it to name that URL, so the library's `/mcp` one isn't enough.
 */
export function protectedResource(publicUrl: string, vaultId?: string) {
  return {
    resource: `${publicUrl}${MCP_PATH}${vaultId ? `/${vaultId}` : ""}`,
    authorization_servers: [publicUrl],
    resource_name: "Hippocampus",
    bearer_methods_supported: ["header"],
    scopes_supported: ["read"],
  };
}

/** The vault in a resource URL (`<origin>/mcp/<vault id>`), if it is one of ours. */
function vaultOfResource(value: string, publicUrl: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== new URL(publicUrl).origin) return undefined;
    return addressedVault(url.pathname) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * A client given `/mcp/<vault id>` sends that as the `resource` of `/authorize` and `/oauth/token`, but
 * the library knows only `/mcp` (grants made so far have that audience, and tokens for it are accepted
 * at every `/mcp/<id>`). So the request says `/mcp`, and `/authorize` also remembers the vault.
 */
export async function canonicalResource(request: Request, publicUrl: string): Promise<Request> {
  const canonical = `${publicUrl}${MCP_PATH}`;
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === AUTHORIZE_PATH) {
    const named = url.searchParams.getAll("resource");
    const vault = named.map((r) => vaultOfResource(r, publicUrl)).find(Boolean);
    url.searchParams.delete(VAULT_HINT);
    if (!vault) return new Request(url, request);
    url.searchParams.delete("resource");
    for (const r of named) url.searchParams.append("resource", vaultOfResource(r, publicUrl) ? canonical : r);
    url.searchParams.set(VAULT_HINT, vault);
    return new Request(url, request);
  }
  if (request.method === "POST" && url.pathname === TOKEN_PATH && (request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
    const body = new URLSearchParams(await request.clone().text());
    const named = body.getAll("resource");
    if (!named.some((r) => vaultOfResource(r, publicUrl))) return request;
    body.delete("resource");
    for (const r of named) body.append("resource", vaultOfResource(r, publicUrl) ? canonical : r);
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return new Request(request.url, { method: "POST", headers, body: body.toString() });
  }
  return request;
}

export const AUTHORIZE_PATH = "/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";
const SETUP_PAGE = "/dashboard/setup/";

/** A key's grant, looked up on every request (so never stored), with its vault. */
export interface KeyProps {
  kind: "key";
  vaultId: string;
  vault: VaultMeta;
  keyId: string;
  keyKind: KeyKind;
  agent?: string;
  scopes: Scope[];
  lastUsed?: string;
}

/** An OAuth grant's props, stored encrypted with the grant. Its scopes come from each token, since refreshes can narrow them. */
export interface OAuthProps {
  kind: "oauth";
  vaultId: string;
  accountId: number;
  /** Grants made before apps named their own agents are bound to one; new ones have none. */
  agent?: string;
  /** Whether the person let the app curate when connecting it; the switch they can flip later starts here. */
  curate?: boolean;
}

export type GrantProps = KeyProps | OAuthProps;

/** The OAuth library's user id for an account. It can't hold `:`, which separates the parts of the library's tokens. */
export const oauthUserId = (accountId: number) => `account-${accountId}`;

/** A connection's id for holding agent names (agent-claims.ts): a key by its hash, an app by its grant. */
export const keyCredential = (keyId: string) => `key:${keyId}`;
export const oauthCredential = (grantId: string) => `oauth:${grantId}`;

/** A key's props. Only `bound` keys carry an agent; each kind's scopes are capped at what the kind allows. */
export function keyProps(key: KeyGrant): KeyProps {
  const allowed = KIND_SCOPES[key.kind];
  return {
    kind: "key",
    vaultId: key.vault.id,
    vault: vaultMeta(key.vault),
    keyId: key.id,
    keyKind: key.kind,
    ...(key.kind === "bound" && key.agent ? { agent: key.agent } : {}),
    scopes: key.scopes.filter((s) => allowed.includes(s)).filter(isScope),
    ...(key.lastUsed ? { lastUsed: key.lastUsed } : {}),
  };
}

/**
 * What an MCP request may do, from its token's props. Undefined for props without a vault: grants
 * made before vaults were hosted here, whose holders have to connect again.
 */
export function grantOf(raw: unknown, tokenScopes: string[], token?: string): { props: GrantProps; grant: VaultGrant } | undefined {
  const props = raw as Partial<GrantProps> | undefined;
  if (typeof props?.vaultId !== "string" || !props.vaultId) return undefined;
  if (props.kind === "key" && props.vault && typeof props.keyId === "string") {
    const p = props as KeyProps;
    return { props: p, grant: { ...(p.agent ? { agent: p.agent } : {}), scopes: p.scopes.filter(isScope), via: "key", keyKind: p.keyKind, credential: keyCredential(p.keyId) } };
  }
  if (props.kind === "oauth" && typeof props.accountId === "number" && (props.agent === undefined || typeof props.agent === "string") && (props.curate === undefined || typeof props.curate === "boolean")) {
    const p = props as OAuthProps;
    const grantId = token?.split(":")[1];
    return { props: p, grant: { ...(p.agent ? { agent: p.agent } : {}), scopes: tokenScopes.filter(isScope), via: "oauth", ...(grantId ? { credential: oauthCredential(grantId) } : {}), ...(p.curate !== undefined ? { curate: !!p.curate } : {}) } };
  }
  return undefined;
}

/** What the OAuth library's handlers receive as their context. */
export interface OAuthContext {
  waitUntil(promise: Promise<unknown>): void;
  props?: unknown;
  /** `token` is `<user>:<grant>:<secret>` for the library's own tokens. */
  auth?: { scope?: string[]; clientId?: string; userId?: string; token?: string };
}

export interface ProviderHandlers {
  /** `/mcp` with a valid token: `ctx.props` holds its props. */
  mcp(request: Request, ctx: OAuthContext): Promise<Response>;
  /** Everything the library doesn't answer itself. */
  site(request: Request): Promise<Response>;
  /** A vault key's props, or null for anything that isn't a live key. */
  resolveKey(token: string): Promise<KeyProps | null>;
  /** An error the library answered itself (a bad token, a refused registration). */
  error(e: { status: number; code: string }): void;
}

/** The library's options. The env it's given needs only `OAUTH_KV`. */
export function providerOptions(publicUrl: string, handlers: ProviderHandlers): OAuthProviderOptions<{ OAUTH_KV: unknown }> {
  const resource = `${publicUrl}${MCP_PATH}`;
  // The library's own docs: apps/worker/node_modules/@cloudflare/workers-oauth-provider/docs/.
  return {
    // Matched as a prefix (`/mcp` and `/mcp/…`), so `/mcp/<vault id>` needs a token too. The library
    // answers CORS for this route itself: OPTIONS gets a 204, responses reflect the Origin.
    apiRoute: MCP_PATH,
    apiHandler: { fetch: (request: Request, _env: unknown, ctx: OAuthContext) => handlers.mcp(request, ctx) },
    defaultHandler: { fetch: (request: Request) => handlers.site(request) },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    scopesSupported: [...SCOPES, LEGACY_GOAL_SCOPE],
    requiredScopes: ["read"],
    resourceMetadata: { resource, authorization_servers: [publicUrl], resource_name: "Hippocampus", bearer_methods_supported: ["header"] },
    // Vault keys are ours too, just not issued through OAuth. A token in the library's own
    // `<user>:<grant>:<secret>` shape never gets here. Null is a 401 with a challenge; a throw (other
    // than ExternalTokenError) escapes to app.ts's 500. Props land on ctx.props; ctx.auth.scope is [].
    resolveExternalToken: async ({ token }: { token: string }) => {
      const props = await handlers.resolveKey(token);
      return props ? { props, audience: resource } : null;
    },
    // Instead of the library's own log line, whose descriptions can quote what a client sent.
    // Returning nothing keeps the library's own error response.
    onError: ({ status, code }: { status: number; code: string }) => handlers.error({ status, code }),
  };
}

/** A 401 that sends an MCP client back through OAuth. The description is ours, never a client's. */
export function invalidToken(publicUrl: string, description: string): Response {
  const challenge = `Bearer realm="OAuth", resource_metadata="${publicUrl}/.well-known/oauth-protected-resource${MCP_PATH}", error="invalid_token", error_description="${description}"`;
  return Response.json({ error: "invalid_token", error_description: description }, { status: 401, headers: { "www-authenticate": challenge, "cache-control": "no-store" } });
}

// ── Connected apps ───────────────────────────────────────────────────────────

/** The account's OAuth grants, for its settings page and for deleting the account. */
export function connectedApps(
  oauth: OAuthHelpers,
  /** A grant for a vault was revoked: free the agent name it held there. */
  revoked: (vaultId: string, credential: string) => Promise<void> = async () => {},
  /** What the person switched since connecting these (credentials `oauth:<grant>`), in one vault. */
  switched: (vaultId: string, credentials: string[]) => Promise<Record<string, boolean>> = async () => ({}),
): ConnectedApps & { revokeAll(accountId: number): Promise<void>; revokeVault(accountId: number, vaultId: string): Promise<void> } {
  const revoke = async (g: GrantSummary, accountId: number) => {
    await oauth.revokeGrant(g.id, oauthUserId(accountId));
    const vaultId = (g.metadata as { vaultId?: unknown } | undefined)?.vaultId;
    if (typeof vaultId === "string") await revoked(vaultId, oauthCredential(g.id)).catch(() => undefined);
  };
  async function grants(accountId: number): Promise<GrantSummary[]> {
    const out: GrantSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await oauth.listUserGrants(oauthUserId(accountId), cursor ? { cursor } : {});
      out.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return out;
  }
  const view = async (g: GrantSummary, switches: Record<string, boolean>): Promise<ConnectedApp> => {
    const meta = (g.metadata ?? {}) as { label?: unknown; agent?: unknown; vaultId?: unknown; curate?: unknown };
    // The ceiling is the scope; whether it does now is the person's switch, else what they chose connecting it.
    const ceiling = g.scope.includes("curate");
    const client = typeof meta.label === "string" && meta.label ? meta.label : ((await oauth.lookupClient(g.clientId).catch(() => null))?.clientName ?? g.clientId);
    return {
      id: g.id,
      client,
      scopes: g.scope,
      ...(typeof meta.agent === "string" ? { agent: meta.agent } : {}),
      ...(typeof meta.vaultId === "string" ? { vault: meta.vaultId } : {}),
      created: new Date(g.createdAt * 1000).toISOString(),
      mayCurate: ceiling,
      curate: ceiling && (switches[oauthCredential(g.id)] ?? meta.curate === true),
    };
  };
  return {
    async list(accountId) {
      const all = await grants(accountId);
      const vaults = [...new Set(all.map((g) => (g.metadata as { vaultId?: unknown } | undefined)?.vaultId).filter((v): v is string => typeof v === "string"))];
      const switches: Record<string, Record<string, boolean>> = {};
      await Promise.all(
        vaults.map(async (v) => {
          const credentials = all.filter((g) => (g.metadata as { vaultId?: unknown } | undefined)?.vaultId === v && g.scope.includes("curate")).map((g) => oauthCredential(g.id));
          switches[v] = credentials.length ? await switched(v, credentials).catch(() => ({})) : {};
        }),
      );
      const apps = await Promise.all(all.map((g) => view(g, switches[String((g.metadata as { vaultId?: unknown } | undefined)?.vaultId)] ?? {})));
      return apps.sort((a, b) => b.created.localeCompare(a.created));
    },
    async revoke(accountId, id) {
      const g = (await grants(accountId)).find((x) => x.id === id);
      if (!g) return false;
      await revoke(g, accountId);
      return true;
    },
    async revokeAll(accountId) {
      for (const g of await grants(accountId)) await revoke(g, accountId);
    },
    async revokeVault(accountId, vaultId) {
      for (const g of await grants(accountId)) if ((g.metadata as { vaultId?: unknown } | undefined)?.vaultId === vaultId) await revoke(g, accountId);
    },
  };
}

// ── /authorize ────────────────────────────────────────────────────────────────

export interface AuthorizeDeps {
  publicUrl: string;
  oauth: OAuthHelpers;
  /** The signed-in caller (the hosted session), and their vaults. */
  who(request: Request): Promise<Caller | undefined>;
  /** The vault's Durable Object, configured. */
  vault(vault: VaultRecord): Promise<VaultStub>;
}

/**
 * `GET /authorize` signs the person in (or sends them to), then asks which of their vaults the app
 * connects to; `POST /authorize` grants that. A grant is for one vault, as a key
 * is. It has no agent and one fixed set of scopes (read, remember, goal): the app's agents name
 * themselves on each call, and the person decides what they're trusted with on the Agents page.
 */
export function authorizePage(deps: AuthorizeDeps): (request: Request) => Promise<Response> {
  const { oauth, publicUrl } = deps;

  async function show(request: Request): Promise<Response> {
    // Validated first, so a bad request never takes a detour through sign-in.
    const authRequest = await oauth.parseAuthRequest(request);
    const caller = await deps.who(request);
    if (!caller) {
      const url = new URL(request.url);
      return redirect(`${LOGIN_PATH}?return=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
    }
    const blocked = notReady(caller);
    if (blocked) return blocked;
    const vaults = readyVaults(caller);
    // The vault the connector's address named, else the one they're working in.
    const hint = new URL(request.url).searchParams.get(VAULT_HINT);
    const vault = vaults.find((v) => v.id === hint) ?? vaults.find((v) => v.id === caller.vault?.id) ?? vaults[0]!;
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return html(200, consentPage({ details, handle: consent.handle, account: caller.account, vault, vaults }), consent.headers);
  }

  async function decide(request: Request): Promise<Response> {
    // The library binds the form to this browser; this keeps other sites from posting it at all.
    const site = request.headers.get("sec-fetch-site");
    if (request.headers.get("origin") !== publicUrl || (site && site !== "same-origin")) return page(403, "Cross-origin request refused", "<p>Start again from the app you were connecting.</p>");
    const caller = await deps.who(request);
    if (!caller) return page(401, "You're signed out", "<p>Start connecting again from the app; you'll be asked to sign in.</p>");
    const blocked = notReady(caller);
    if (blocked) return blocked;
    const form = await request.formData();
    // Signed out and in as someone else since the page loaded: this approval isn't theirs to give.
    if (String(form.get("account") ?? "") !== String(caller.account.id)) return page(400, "You've switched accounts", "<p>Start again from the app you were connecting.</p>");
    const vault = readyVaults(caller).find((v) => v.id === String(form.get("vault") ?? ""));
    if (!vault) return page(400, "Pick one of your vaults", "<p>That vault isn't ready, or it isn't yours. Go back and pick another.</p>");
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      denied.headers.set("Location", denied.redirectTo);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    // Granted under its old name too, so a rolled-back Worker (which knows only `quest`) keeps it.
    // An owner's app may also curate, as the most it can do: a token's scopes can't change later, so
    // whether it does is a switch the person flips on the Connected apps list (starting at their choice here).
    const owner = vault.role === "owner";
    const curate = owner && form.get("curate") === "on";
    const scope: Scope[] = [...SHARED_SCOPES, LEGACY_GOAL_SCOPE, ...(owner ? (["curate"] as const) : [])];

    const approved = await oauth.approveConsent(request, handle, { scope });
    const client = await oauth.lookupClient(approved.request.clientId).catch(() => null);
    const props: OAuthProps = { kind: "oauth", vaultId: vault.id, accountId: caller.account.id, ...(owner ? { curate } : {}) };
    // Named after the app itself: nothing to ask.
    const label = client?.clientName?.slice(0, 80) ?? "";
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: oauthUserId(caller.account.id),
      metadata: { label, vaultId: vault.id, ...(owner ? { curate } : {}) },
      scope: approved.request.scope,
      props,
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  }

  return async (request) => {
    try {
      if (request.method === "GET") return await show(request);
      if (request.method === "POST") return await decide(request);
      return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, POST" } });
    } catch (err) {
      // Redirect only once the client and its redirect URI are validated; otherwise explain here.
      if (err instanceof AuthorizationError && err.redirectTo) return redirect(err.redirectTo);
      if (err instanceof AuthorizationError) return page(400, "This sign-in can't continue", `<p>${escape(err.description)}</p><p>Start again from the app you were connecting.</p>`);
      if (err instanceof CimdFetchError) return page(400, "This app couldn't be verified", "<p>Its published details didn't load. Try again later.</p>");
      throw err;
    }
  };
}

/** The vaults an app may connect to: ready ones the person can write to (not as a viewer). */
const readyVaults = (caller: Caller) => caller.vaults.filter((v) => v.status === "ready" && v.role !== "viewer");

/** Connecting needs an approved account with a ready vault. */
function notReady(caller: Caller): Response | undefined {
  const { account, vaults } = caller;
  const setup = `<p>Finish setting up at <a href="${SETUP_PAGE}">${SETUP_PAGE}</a>, then connect again from the app.</p>`;
  if (account.status !== "approved") return page(403, "Your account isn't approved yet", `<p>An admin has to approve <strong>@${escape(account.login)}</strong> before apps can connect.</p>${setup}`);
  if (!readyVaults(caller).length) return page(409, vaults.length ? "Your vault isn't ready" : "You don't have a vault yet", setup);
  return undefined;
}

// Scopes are also defined in packages/mcp/src/server.ts (SCOPES) and apps/worker/src/hosted/registry.ts (KIND_SCOPES).
/** What a connector app gets: what a shared key has (registry's `KIND_SCOPES.agent`). */
const SHARED_SCOPES = KIND_SCOPES.agent.filter((x): x is Scope => isScope(x) && x !== LEGACY_GOAL_SCOPE);

function consentPage(o: { details: ConsentDescription; handle: string; account: Account; vault: MemberVault; vaults: MemberVault[] }): string {
  const { details } = o;
  const name = escape(details.clientName);
  const origin = details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : "This app registered itself; its name is not verified.";
  const vaultField =
    o.vaults.length > 1
      ? `<fieldset><legend>Vault</legend><label>It connects to <select name="vault">${o.vaults.map((v) => `<option value="${escape(v.id)}"${v.id === o.vault.id ? " selected" : ""}>${escape(v.fullName)}</option>`).join("")}</select></label>
<small>One vault per connection: to use another vault in the same app, connect it again.</small></fieldset>`
      : `<input type="hidden" name="vault" value="${escape(o.vault.id)}"><p>Vault <strong>${escape(o.vault.fullName)}</strong>.</p>`;
  // Only an owner can hand out the curator's view of secrets, so only a vault they own shows the choice (the server checks again).
  const curateField = o.vaults.some((v) => v.role === "owner")
    ? `<fieldset><legend>Curating</legend><label><input type="checkbox" name="curate" checked> Let this app run nightly curation (vaults you own)</label>
<small>Curating turns what your agents saved into notes. It shows the app every memory in full, <strong>secret and confidential values included</strong>, so use an app and a provider you trust with them. Turn it off any time under Setup → Connected apps.</small></fieldset>`
    : "";
  return `<h1>Connect ${name} to your vault?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<p>Signed in as <strong>@${escape(o.account.login)}</strong>.</p>
<form method="post">
<input type="hidden" name="handle" value="${escape(o.handle)}">
<input type="hidden" name="account" value="${o.account.id}">
${vaultField}
<p><small>It can read the vault, remember, and update goals. Each agent in the app names itself (say, <code>chatgpt-home-finder</code>) and joins your Agents page with no authority: what it says counts as a rumor until you give it a domain there. Disconnect it from your settings at any time.</small></p>
${curateField}
<p><button name="decision" value="approve">Connect</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
