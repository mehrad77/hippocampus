import { OAuthProvider, getOAuthApi, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { HttpError, errorResponse, json } from "@hippocampus/dashboard";
import type { SqlDriver } from "@hippocampus/index";
import type { KVLike } from "./auth.ts";
import { DASHBOARD_API, DASHBOARD_BASE, WELCOME, isDashboardApi, isDashboardPath, serveAsset, type Assets } from "./dashboard.ts";
import { logEvent, rateLimit, type RateLimiter } from "./hosted/limits.ts";
import { isLive, type AccountStatus, type VaultRecord } from "./hosted/registry.ts";
import { createHostedRoutes, type Caller, type HostedRoutes } from "./hosted/routes.ts";
import { hostedMissing, hostedSettings, type HostedSettings, type HostedVars } from "./hosted/settings.ts";
import { vaultMeta, type DashboardUser, type VaultHosts, type VaultMeta, type VaultStub } from "./hosted/vault-port.ts";
import { AUTHORIZE_PATH, REGISTER_PATH, authorizePage, connectedApps, grantOf, invalidToken, keyProps, providerOptions, type OAuthContext } from "./oauth.ts";
import { page, plain } from "./pages.ts";

// The hosted Worker's request handling, independent of the Workers runtime: the OAuth provider in
// front, then the hosted app's own routes, the consent page, and each vault's Durable Object for
// MCP and the dashboard API. worker.ts builds it from the Worker's bindings, once per isolate.

export interface HostedAppDeps {
  settings: HostedSettings;
  /** OAuth grants and clients, sessions and pending sign-ins (the Worker's OAUTH_KV). */
  kv: KVLike;
  /** The registry database (D1 in the Worker). */
  registry: SqlDriver;
  vaults: VaultHosts;
  /** The built dashboard UI. */
  assets: Assets;
  /** Workers Rate Limiting bindings, each optional: sign-ins and registrations by IP, the API by account, MCP by key or connection. */
  limits?: { signIn?: RateLimiter; api?: RateLimiter; mcp?: RateLimiter; register?: RateLimiter };
  /** GitHub, for tests and the dev fake. */
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

/** What a request handler gets from the runtime: Workers' ExecutionContext, or a stand-in. */
export interface RequestContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface HostedApp {
  fetch(request: Request, ctx: RequestContext): Promise<Response>;
  routes: HostedRoutes;
  oauth: OAuthHelpers;
}

/** How long an isolate trusts what it read about a vault for OAuth requests. Keys are looked up every time. */
const VAULT_TTL_MS = 30_000;
/** Bounds the per-isolate caches; past it they start over. */
const MAX_CACHED = 2000;

interface VaultState {
  vault?: VaultRecord;
  accountStatus?: AccountStatus;
}

export function createHostedApp(deps: HostedAppDeps): HostedApp {
  const { settings } = deps;
  const publicUrl = settings.publicUrl;
  const env = { OAUTH_KV: deps.kv };
  const log = (route: string, started: number, status: number, vault?: string, code?: string) =>
    logEvent({ route, status, ms: Date.now() - started, ...(vault ? { vault } : {}), ...(code ? { code } : {}) }, deps.log);

  // Per isolate. `configured` remembers what each vault's Durable Object was last told, so it's told
  // once per change rather than on every request.
  const configured = new Map<string, string>();
  const states = new Map<string, { until: number; state: VaultState }>();
  const forget = (id: string) => {
    configured.delete(id);
    states.delete(id);
  };

  async function stubFor(meta: VaultMeta): Promise<VaultStub> {
    const stub = deps.vaults.get(meta.vaultId);
    const fingerprint = JSON.stringify(meta);
    if (configured.get(meta.vaultId) !== fingerprint) {
      await stub.configure(meta);
      if (configured.size >= MAX_CACHED) configured.clear();
      configured.set(meta.vaultId, fingerprint);
    }
    return stub;
  }

  async function vaultState(id: string): Promise<VaultState> {
    const hit = states.get(id);
    if (hit && hit.until > Date.now()) return hit.state;
    const vault = await routes.registry.vault(id);
    const account = vault ? await routes.registry.account(vault.accountId) : undefined;
    const state: VaultState = { ...(vault ? { vault } : {}), ...(account ? { accountStatus: account.status } : {}) };
    if (states.size >= MAX_CACHED) states.clear();
    states.set(id, { until: Date.now() + VAULT_TTL_MS, state });
    return state;
  }

  /** A vault's registry row changed: bring its Durable Object in line. */
  async function onVaultChanged(id: string): Promise<void> {
    forget(id);
    const started = Date.now();
    try {
      const vault = await routes.registry.vault(id);
      const stub = deps.vaults.get(id);
      // Gone from the registry: replaced by another repo, keys and all.
      if (!vault) await stub.destroy();
      else if (vault.status === "ready") await stubFor(vaultMeta(vault));
      else if (vault.status === "disconnected") await stub.disconnect(vault.reason ?? "disconnected");
    } catch {
      // The registry already changed, and the Worker checks it before forwarding anything. A ready
      // vault's object is configured on its next request instead, so a failure here loses nothing.
      await log("hook vault-changed", started, 500, id, "INTERNAL");
    }
  }

  const handlers = {
    mcp: (request: Request, ctx: OAuthContext) => mcp(request, ctx),
    site: (request: Request) => site(request),
    resolveKey: async (token: string) => {
      const key = await routes.registry.keyForToken(token);
      return key && isLive(key) ? keyProps(key) : null;
    },
    error: ({ status, code }: { status: number; code: string }) => void log("oauth", Date.now(), status, undefined, code.replace(/[^\w]/g, "").slice(0, 40)),
  };
  const options = providerOptions(publicUrl, handlers);
  const oauth = getOAuthApi(options, env);
  const apps = connectedApps(oauth);
  const routes = createHostedRoutes({
    settings,
    kv: deps.kv,
    registry: deps.registry,
    fetch: deps.fetch,
    now: deps.now,
    log: deps.log,
    apps,
    limits: { signIn: deps.limits?.signIn, api: deps.limits?.api },
    hooks: {
      onVaultChanged,
      revokeOAuthGrants: (accountId) => apps.revokeAll(accountId),
      destroyVault: async (id) => {
        forget(id);
        await deps.vaults.get(id).destroy();
      },
    },
  });
  const provider = new OAuthProvider(options);
  const authorize = authorizePage({ publicUrl, oauth, who: (request) => routes.who(request), vault: (v) => stubFor(vaultMeta(v)) });

  /** `/mcp` with a valid key or OAuth token. */
  async function mcp(request: Request, ctx: OAuthContext): Promise<Response> {
    const started = Date.now();
    const route = `${request.method} mcp`;
    const found = grantOf(ctx.props, ctx.auth?.scope ?? []);
    if (!found) {
      await log(route, started, 401, undefined, "REAUTHORIZE");
      return invalidToken(publicUrl, "This connection was made before vaults were hosted here. Connect it again.");
    }
    const { props, grant } = found;
    const done = async (res: Response, code?: string) => (await log(route, started, res.status, props.vaultId, code), res);
    let meta: VaultMeta;
    let limitKey: string;
    if (props.kind === "key") {
      // The key, its vault and its owner were checked just now (`resolveKey`).
      meta = props.vault;
      limitKey = `mcp:key:${props.keyId}`;
      ctx.waitUntil(routes.registry.touchKey({ id: props.keyId, lastUsed: props.lastUsed }).catch(() => undefined));
    } else {
      const { vault, accountStatus } = await vaultState(props.vaultId);
      if (!vault || vault.accountId !== props.accountId || accountStatus !== "approved")
        return done(invalidToken(publicUrl, "This connection's vault is gone. Connect it again."), "REAUTHORIZE");
      if (vault.status !== "ready")
        return done(json(403, { error: "vault_unavailable", error_description: `This vault is ${vault.status}. Its owner can reconnect it at ${publicUrl}${DASHBOARD_BASE}/setup/` }), "NOT_READY");
      meta = vaultMeta(vault);
      limitKey = `mcp:oauth:${props.accountId}:${ctx.auth?.clientId ?? ""}`;
    }
    if (!(await rateLimit(deps.limits?.mcp, limitKey)))
      return done(json(429, { error: "rate_limited", error_description: "Too many requests; slow down a little." }, { "retry-after": "60" }), "RATE_LIMITED");
    const stub = await stubFor(meta);
    return done(await stub.mcp(withoutCredentials(request), grant));
  }

  /** Everything that isn't the OAuth library's own. */
  async function site(request: Request): Promise<Response> {
    const own = await routes(request);
    if (own) return own;
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === AUTHORIZE_PATH) {
      const started = Date.now();
      const res = await authorize(request);
      await log(`${request.method} authorize`, started, res.status);
      return res;
    }
    if (pathname === "/") return home(request);
    // The hosted routes answer the API until the account has a ready vault; then it's the vault's.
    if (isDashboardApi(pathname)) return dashboardApi(request, url);
    if (isDashboardPath(pathname)) return serveAsset(deps.assets, request);
    return plain(404, "Not found");
  }

  async function home(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed", { allow: "GET, HEAD" });
    const signedIn = !!(await routes.who(request));
    return new Response(null, { status: 302, headers: { location: signedIn ? `${DASHBOARD_BASE}/` : WELCOME, "cache-control": "no-store" } });
  }

  async function dashboardApi(request: Request, url: URL): Promise<Response> {
    const started = Date.now();
    const section = url.pathname.slice(DASHBOARD_API.length + 1).split("/")[0] ?? "";
    const route = `${request.method} api/${section}`.slice(0, 40);
    let vault: string | undefined;
    try {
      const caller = await routes.who(request);
      if (!caller) throw new HttpError(401, "Sign in with GitHub to continue.", "SIGN_IN");
      vault = caller.vault?.id;
      if (caller.vault?.status !== "ready") throw new HttpError(409, "No vault yet: finish setting one up first.", "NO_VAULT");
      if (request.method !== "GET" && request.method !== "HEAD") {
        // Lax cookies ride along on cross-site navigations, so writes also need our own Origin.
        const site = request.headers.get("sec-fetch-site");
        if (request.headers.get("origin") !== publicUrl || (site && site !== "same-origin")) throw new HttpError(403, "Cross-origin request refused", "ORIGIN");
        if (!(await rateLimit(deps.limits?.api, `account:${caller.account.id}`))) throw new HttpError(429, "Too many requests; slow down a little.", "RATE_LIMITED");
      }
      const stub = await stubFor(vaultMeta(caller.vault));
      const res = await stub.dashboard(withoutCredentials(request), dashboardUser(caller));
      await log(route, started, res.status, vault);
      return res;
    } catch (err) {
      const res = errorResponse(err, () => {});
      await log(route, started, res.status, vault, err instanceof HttpError ? err.code : "INTERNAL");
      return res;
    }
  }

  function dashboardUser({ account }: Caller): DashboardUser {
    return { login: account.login, account: { status: account.status === "approved" ? "approved" : "waitlisted", admin: settings.admins.has(account.id) } };
  }

  return {
    routes,
    oauth,
    async fetch(request, ctx) {
      const started = Date.now();
      try {
        // Dynamic client registration is open to anyone, so it's limited by IP before the library sees it.
        if (request.method === "POST" && new URL(request.url).pathname === REGISTER_PATH) {
          const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
          if (!(await rateLimit(deps.limits?.register, `register:${ip}`))) {
            await log("POST register", started, 429, undefined, "RATE_LIMITED");
            return json(429, { error: "temporarily_unavailable", error_description: "Too many registrations; try again in a minute." }, { "retry-after": "60" });
          }
        }
        return await provider.fetch(request, env, ctx as Parameters<typeof provider.fetch>[2]);
      } catch {
        // Messages can name vaults or carry their content, so only the fact of it is logged.
        await log("error", started, 500, undefined, "INTERNAL");
        return plain(500, "Something went wrong. Try again in a moment.");
      }
    },
  };
}

/** The Worker's bindings, by name. */
export const BINDINGS = ["VAULT_HOST", "REGISTRY", "OAUTH_KV", "ASSETS"] as const;

/** A page naming what the operator still has to set, or undefined when the Worker can run. Names only, never values. */
export function configProblem(env: HostedVars & Partial<Record<(typeof BINDINGS)[number], unknown>>): Response | undefined {
  const missing = [...BINDINGS.filter((b) => !env[b]), ...hostedMissing(env)];
  const help = "<p>Bindings go in <code>wrangler.jsonc</code>; the rest are Worker secrets (<code>wrangler secret put NAME</code>). Then deploy again.</p>";
  if (missing.length) return page(503, "Hippocampus isn't set up yet", `<p>This Worker still needs ${missing.map((m) => `<code>${m}</code>`).join(", ")}.</p>${help}`);
  try {
    hostedSettings(env);
  } catch (err) {
    const which = /HIPPO_ADMINS/.test(String(err)) ? "<code>HIPPO_ADMINS</code> must list GitHub user ids (numbers), not logins." : "<code>HIPPO_PUBLIC_URL</code> must be this Worker's https URL.";
    return page(503, "Hippocampus isn't set up yet", `<p>${which}</p>${help}`);
  }
  return undefined;
}

/** The request for a vault's Durable Object: it has the caller's grant, so it needn't see their credentials. */
function withoutCredentials(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  return new Request(request, { headers });
}
