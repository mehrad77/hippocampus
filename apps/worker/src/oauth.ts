import { AuthorizationError, CimdFetchError, type ConsentDescription, type GrantSummary, type OAuthHelpers, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { SCOPES, type Scope } from "@hippocampus/mcp";
import { isScope } from "./auth.ts";
import type { ConnectedApp, ConnectedApps } from "./hosted/account.ts";
import { KIND_SCOPES, agentId, type Account, type KeyGrant, type KeyKind, type VaultRecord } from "./hosted/registry.ts";
import type { Caller } from "./hosted/routes.ts";
import { LOGIN_PATH } from "./hosted/session.ts";
import { vaultMeta, type PartyMember, type VaultGrant, type VaultMeta, type VaultStub } from "./hosted/vault-port.ts";
import { escape, html, page } from "./pages.ts";

// OAuth 2.1 for MCP connectors (Claude.ai, ChatGPT): this Worker is the authorization server and
// the resource. People sign in to the hosted app first, then approve each app on a consent page
// that picks the agent it acts as and what it may do. Vault keys (`hippo_…`) work alongside.

export const MCP_PATH = "/mcp";
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
  agent: string;
}

export type GrantProps = KeyProps | OAuthProps;

/** The OAuth library's user id for an account. It can't hold `:`, which separates the parts of the library's tokens. */
export const oauthUserId = (accountId: number) => `account-${accountId}`;

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
export function grantOf(raw: unknown, tokenScopes: string[]): { props: GrantProps; grant: VaultGrant } | undefined {
  const props = raw as Partial<GrantProps> | undefined;
  if (typeof props?.vaultId !== "string" || !props.vaultId) return undefined;
  if (props.kind === "key" && props.vault && typeof props.keyId === "string") {
    const p = props as KeyProps;
    return { props: p, grant: { ...(p.agent ? { agent: p.agent } : {}), scopes: p.scopes.filter(isScope), via: "key", keyKind: p.keyKind } };
  }
  if (props.kind === "oauth" && typeof props.agent === "string" && typeof props.accountId === "number") {
    const p = props as OAuthProps;
    return { props: p, grant: { agent: p.agent, scopes: tokenScopes.filter(isScope), via: "oauth" } };
  }
  return undefined;
}

/** What the OAuth library's handlers receive as their context. */
export interface OAuthContext {
  waitUntil(promise: Promise<unknown>): void;
  props?: unknown;
  auth?: { scope?: string[]; clientId?: string; userId?: string };
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
  return {
    apiRoute: MCP_PATH,
    apiHandler: { fetch: (request: Request, _env: unknown, ctx: OAuthContext) => handlers.mcp(request, ctx) },
    defaultHandler: { fetch: (request: Request) => handlers.site(request) },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    scopesSupported: [...SCOPES],
    requiredScopes: ["read"],
    resourceMetadata: { resource, authorization_servers: [publicUrl], resource_name: "Hippocampus", bearer_methods_supported: ["header"] },
    // Vault keys are ours too, just not issued through OAuth.
    resolveExternalToken: async ({ token }: { token: string }) => {
      const props = await handlers.resolveKey(token);
      return props ? { props, audience: resource } : null;
    },
    // Instead of the library's own log line, whose descriptions can quote what a client sent.
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
export function connectedApps(oauth: OAuthHelpers): ConnectedApps & { revokeAll(accountId: number): Promise<void> } {
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
  const view = async (g: GrantSummary): Promise<ConnectedApp> => {
    const meta = (g.metadata ?? {}) as { label?: unknown; agent?: unknown };
    const client = typeof meta.label === "string" && meta.label ? meta.label : ((await oauth.lookupClient(g.clientId).catch(() => null))?.clientName ?? g.clientId);
    return { id: g.id, client, scopes: g.scope, ...(typeof meta.agent === "string" ? { agent: meta.agent } : {}), created: new Date(g.createdAt * 1000).toISOString() };
  };
  return {
    async list(accountId) {
      const apps = await Promise.all((await grants(accountId)).map(view));
      return apps.sort((a, b) => b.created.localeCompare(a.created));
    },
    async revoke(accountId, id) {
      if (!(await grants(accountId)).some((g) => g.id === id)) return false;
      await oauth.revokeGrant(id, oauthUserId(accountId));
      return true;
    },
    async revokeAll(accountId) {
      for (const g of await grants(accountId)) await oauth.revokeGrant(g.id, oauthUserId(accountId));
    },
  };
}

// ── /authorize ────────────────────────────────────────────────────────────────

export interface AuthorizeDeps {
  publicUrl: string;
  oauth: OAuthHelpers;
  /** The signed-in caller (the hosted session), and their vault. */
  who(request: Request): Promise<Caller | undefined>;
  /** The vault's Durable Object, configured. */
  vault(vault: VaultRecord): Promise<VaultStub>;
}

/**
 * `GET /authorize` signs the person in (or sends them to), then asks which agent the app acts as
 * and what it may do; `POST /authorize` grants that, for the signed-in account's vault.
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
    const vault = caller.vault!;
    const details = await oauth.describeConsent(authRequest);
    // Without the party the form still works: a new id typed in.
    const party = await deps
      .vault(vault)
      .then((stub) => stub.party())
      .catch(() => undefined);
    const consent = await oauth.beginConsent(authRequest);
    return html(200, consentPage({ details, handle: consent.handle, account: caller.account, vault, party }), consent.headers);
  }

  async function decide(request: Request): Promise<Response> {
    // The library binds the form to this browser; this keeps other sites from posting it at all.
    const site = request.headers.get("sec-fetch-site");
    if (request.headers.get("origin") !== publicUrl || (site && site !== "same-origin")) return page(403, "Cross-origin request refused", "<p>Start again from the app you were connecting.</p>");
    const caller = await deps.who(request);
    if (!caller) return page(401, "You're signed out", "<p>Start connecting again from the app; you'll be asked to sign in.</p>");
    const blocked = notReady(caller);
    if (blocked) return blocked;
    const vault = caller.vault!;
    const form = await request.formData();
    // Signed out and in as someone else since the page loaded: this approval isn't theirs to give.
    if (String(form.get("account") ?? "") !== String(caller.account.id)) return page(400, "You've switched accounts", "<p>Start again from the app you were connecting.</p>");
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      denied.headers.set("Location", denied.redirectTo);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    // Checked before approving, so going back and fixing the form still works.
    const typed = String(form.get("new_agent") ?? "").trim();
    let agent: string;
    try {
      agent = agentId(typed || form.get("agent"));
    } catch (err) {
      return page(400, "Check the agent id", `<p>${escape((err as Error).message)}. Go back and try again.</p>`);
    }
    const scope = SCOPES.filter((s) => form.getAll("scope").includes(s));
    if (!scope.includes("read")) return page(400, "Choose what it may do", "<p>Every app needs read. Go back and tick it.</p>");

    if (typed && form.get("add_to_party")) {
      const title = String(form.get("new_title") ?? "").trim().slice(0, 80) || agent;
      try {
        const stub = await deps.vault(vault);
        if (!(await stub.party()).some((p) => p.id === agent)) await stub.addParty({ id: agent, title }, `@${caller.account.login}`);
      } catch (err) {
        return page(400, "Couldn't add it to the party", `<p>${escape((err as Error).message)}</p><p>Go back and pick another id, or connect without adding it.</p>`);
      }
    }

    const approved = await oauth.approveConsent(request, handle, { scope });
    const client = await oauth.lookupClient(approved.request.clientId).catch(() => null);
    const props: OAuthProps = { kind: "oauth", vaultId: vault.id, accountId: caller.account.id, agent };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: oauthUserId(caller.account.id),
      metadata: { label: client?.clientName?.slice(0, 80) ?? "", vaultId: vault.id, agent },
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

/** Connecting needs an approved account with a ready vault. */
function notReady({ account, vault }: Caller): Response | undefined {
  const setup = `<p>Finish setting up at <a href="${SETUP_PAGE}">${SETUP_PAGE}</a>, then connect again from the app.</p>`;
  if (account.status !== "approved") return page(403, "Your account isn't approved yet", `<p>An admin has to approve <strong>@${escape(account.login)}</strong> before apps can connect.</p>${setup}`);
  if (vault?.status !== "ready") return page(409, vault ? "Your vault isn't ready" : "You don't have a vault yet", setup);
  return undefined;
}

const SCOPE_LABELS: Record<Scope, string> = {
  read: "Read the vault: recall, look up notes, briefings",
  remember: "Remember: add new memories to its inbox",
  quest: "Update quests: objectives, status, clocks",
  curate: "Curate: run sleep, consolidating the inbox into notes",
};
/** Pre-ticked whatever the app asks for: the rest is the person's call. */
const DEFAULT_SCOPES = new Set<Scope>(["read", "remember"]);

function consentPage(o: { details: ConsentDescription; handle: string; account: Account; vault: VaultRecord; party?: PartyMember[] }): string {
  const { details } = o;
  const name = escape(details.clientName);
  const origin = details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : "This app registered itself; its name is not verified.";
  const party = o.party ?? [];
  const suggested = details.clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "connector";
  const members = party.map((p) => `<option value="${escape(p.id)}">${escape(p.title)} (${escape(p.id)})</option>`).join("");
  const scopes = SCOPES.map(
    (s) =>
      `<label><input type="checkbox" name="scope" value="${s}"${DEFAULT_SCOPES.has(s) ? " checked" : ""}> ${escape(SCOPE_LABELS[s])}</label>` +
      (s === "curate" ? `<p class="warn"><small>Curating shows the app every new memory in full, <strong>secret memories in plain text</strong>. Allow it only for an app you trust with them.</small></p>` : ""),
  ).join("\n");
  return `<h1>Connect ${name} to your vault?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<p>Vault <strong>${escape(o.vault.fullName)}</strong>, as <strong>@${escape(o.account.login)}</strong>.</p>
<form method="post">
<input type="hidden" name="handle" value="${escape(o.handle)}">
<input type="hidden" name="account" value="${o.account.id}">
<fieldset><legend>It acts as</legend>
${party.length ? `<label>A party member <select name="agent">${members}</select></label>\n<p><small>Or a new agent (this wins if filled in):</small></p>` : ""}
<label>New agent id <input name="new_agent" value="${party.length ? "" : escape(suggested)}" pattern="[a-z0-9][a-z0-9\\-]{0,62}"${party.length ? "" : " required"}></label>
<label>Its name <input name="new_title" value="${name}" maxlength="80"></label>
<label><input type="checkbox" name="add_to_party" value="1"${o.party && !party.length ? " checked" : ""}> Add the new agent to the party now</label>
<small>Its memories are filed under <code>inbox/&lt;agent&gt;/</code>. A party member's id gives it that member's lane.</small>
</fieldset>
<fieldset><legend>It may</legend>
${scopes}
</fieldset>
<p><button name="decision" value="approve">Connect</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
