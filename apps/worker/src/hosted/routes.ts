import { HttpError, capabilities, errorResponse, json, readJson, type HostedSessionInfo } from "@hippocampus/dashboard";
import type { SqlDriver } from "@hippocampus/index";
import { CALLBACK_PATH } from "../github-login.ts";
import { GRANT_ID, confirmDeletion, deleteAccount, type AccountHooks, type ConnectedApps } from "./account.ts";
import { adminRoutes } from "./admin.ts";
import { GitHubApp, GitHubAppError } from "./github-app.ts";
import { logEvent, rateLimit, type RateLimiter } from "./limits.ts";
import { hostedSetup } from "./onboarding.ts";
import { Registry, type Account, type VaultRecord } from "./registry.ts";
import { LOGIN_PATH, LOGOUT_PATH, createSessions, type SessionKV, type Sessions } from "./session.ts";
import { apiUrlOf, type HostedSettings } from "./settings.ts";
import { WEBHOOK_PATH, handleWebhook } from "./webhooks.ts";

// The hosted app's own routes: accounts, onboarding, admin, account settings and GitHub's webhook.
// Everything else (the dashboard pages, a ready vault's API, MCP) falls through to the caller.

export const HOSTED_API = "/dashboard/api";

export interface HostedHooks extends AccountHooks {
  /** A vault's registry row changed (status, name, keys): tell its Durable Object. */
  onVaultChanged?: (vaultId: string) => void | Promise<void>;
}

export interface HostedDeps {
  settings: HostedSettings;
  /** Sign-in state, sessions and pending installations (the Worker's OAUTH_KV, under `hosted:`). */
  kv: SessionKV;
  /** The registry database (D1 in the Worker). */
  registry: SqlDriver;
  fetch?: typeof fetch;
  now?: () => Date;
  hooks?: HostedHooks;
  /** The account's apps connected over OAuth (the Worker's OAuth provider). */
  apps?: ConnectedApps;
  /** Workers Rate Limiting bindings; absent means unlimited. `signIn` is keyed by IP, `api` by account. */
  limits?: { signIn?: RateLimiter; api?: RateLimiter };
  log?: (line: string) => void;
}

/** Who's calling: a live session's account, and its vault if it has one. */
export interface Caller {
  account: Account;
  vault?: VaultRecord;
}

export interface HostedRoutes {
  /** A response for the hosted app's routes; undefined for everything else. */
  (request: Request): Promise<Response | undefined>;
  registry: Registry;
  app: GitHubApp;
  sessions: Sessions;
  /** The caller, looked up once per request: the Worker reuses it to pick the vault's Durable Object. */
  who(request: Request): Promise<Caller | undefined>;
}

/** Sections of `/dashboard/api/` answered here whatever the vault's state. */
const OWN = new Set(["setup", "admin", "account"]);

export function createHostedRoutes(deps: HostedDeps): HostedRoutes {
  const { settings, kv } = deps;
  const now = deps.now ?? (() => new Date());
  const registry = new Registry(deps.registry, now);
  const app = new GitHubApp({ appId: settings.appId, privateKey: settings.privateKey, apiUrl: apiUrlOf(settings), fetch: deps.fetch, now });
  const sessions = createSessions({ settings, kv, registry, app, fetch: deps.fetch, now });
  const admin = adminRoutes({ registry, admins: settings.admins });
  const hooks = deps.hooks ?? {};

  const memo = new WeakMap<Request, Promise<Caller | undefined>>();
  const who = (request: Request): Promise<Caller | undefined> => {
    let found = memo.get(request);
    if (!found) {
      found = (async () => {
        const signedIn = await sessions.current(request);
        if (!signedIn) return undefined;
        const vault = await registry.vaultOf(signedIn.account.id);
        return { account: signedIn.account, ...(vault ? { vault } : {}) };
      })();
      memo.set(request, found);
    }
    return found;
  };

  const setupSession = ({ account }: Caller): HostedSessionInfo => ({
    mode: "setup",
    user: { login: account.login },
    capabilities: capabilities(undefined, "hosted") as HostedSessionInfo["capabilities"],
    account: { status: account.status === "approved" ? "approved" : "waitlisted", admin: settings.admins.has(account.id) },
  });

  async function accountRoute(request: Request, method: string, sub: string, body: unknown, { account, vault }: Caller): Promise<Response> {
    if (sub === "" && method === "GET") {
      return json(200, { id: account.id, login: account.login, status: account.status, admin: settings.admins.has(account.id), ...(vault ? { vault: { id: vault.id, fullName: vault.fullName, status: vault.status } } : {}) });
    }
    if (sub === "apps" && method === "GET") return json(200, { apps: deps.apps ? await deps.apps.list(account.id) : [] });
    if (sub === "apps/revoke" && method === "POST") {
      const id = (body as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !GRANT_ID.test(id)) throw new HttpError(400, "id: expected a connected app's id", "INVALID");
      if (!deps.apps || !(await deps.apps.revoke(account.id, id))) throw new HttpError(404, "No such app: it may be disconnected already.", "NOT_FOUND");
      return json(200, { ok: true });
    }
    if (sub === "delete" && method === "POST") {
      confirmDeletion(account, body);
      await deleteAccount(account.id, { registry, app, kv, hooks });
      return json(200, { ok: true }, { "set-cookie": await sessions.end(request) });
    }
    throw new HttpError(404, `No such account route: ${method} ${sub}`, "NOT_FOUND");
  }

  async function api(request: Request, url: URL): Promise<Response | undefined> {
    const path = url.pathname.slice(HOSTED_API.length + 1).replace(/\/+$/, "");
    const [section = ""] = path.split("/");
    const method = request.method;
    const started = Date.now();
    let vault: string | undefined;
    const done = async (res: Response, code?: string) => {
      if (OWN.has(section)) await logEvent({ route: routeName(method, path), vault, status: res.status, code, ms: Date.now() - started }, deps.log);
      return res;
    };
    try {
      const caller = await who(request);
      if (!caller) throw new HttpError(401, "Sign in with GitHub to continue.", "SIGN_IN", { login: LOGIN_PATH });
      vault = caller.vault?.id;
      const ready = caller.vault?.status === "ready";
      if (path === "session") {
        if (ready) return undefined;
        if (method !== "GET") throw new HttpError(405, "Method not allowed", "METHOD");
        return json(200, setupSession(caller));
      }
      if (!OWN.has(section)) {
        if (ready) return undefined;
        throw new HttpError(409, "No vault yet: finish setting one up first.", "NO_VAULT");
      }
      if (method !== "GET" && method !== "POST") throw new HttpError(405, "Method not allowed", "METHOD");
      if (method === "POST") {
        // Lax cookies ride along on cross-site navigations, so writes also need our own Origin.
        const site = request.headers.get("sec-fetch-site");
        if (request.headers.get("origin") !== settings.publicUrl || (site && site !== "same-origin")) throw new HttpError(403, "Cross-origin request refused", "ORIGIN");
        if (!(await rateLimit(deps.limits?.api, `account:${caller.account.id}`))) throw new HttpError(429, "Too many requests; slow down a little.", "RATE_LIMITED");
      }
      const body = method === "POST" ? await readJson(request) : undefined;
      const sub = path.slice(section.length).replace(/^\//, "");
      if (section === "account") return done(await accountRoute(request, method, sub, body, caller));
      let result: unknown;
      if (section === "admin") result = await admin(method, sub, body, url, caller.account);
      else {
        const port = hostedSetup({ account: caller.account, settings, registry, app, kv, now, onVaultChanged: hooks.onVaultChanged });
        result = (sub === "" || sub === "status") && method === "GET" ? await port.status() : await port.handle(method, sub, body, url);
      }
      return done(json(200, result ?? { ok: true }));
    } catch (err) {
      const mapped = err instanceof GitHubAppError ? new HttpError(502, err.message, "GITHUB") : err;
      return done(errorResponse(mapped, quiet), mapped instanceof HttpError ? mapped.code : "INTERNAL");
    }
  }

  const handler = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    if (pathname === LOGIN_PATH) {
      if (method !== "GET") return notAllowed("GET");
      if (!(await rateLimit(deps.limits?.signIn, `signin:${request.headers.get("cf-connecting-ip") ?? "unknown"}`))) return json(429, { error: "Too many sign-ins; try again in a minute.", code: "RATE_LIMITED" });
      return sessions.login(request);
    }
    if (pathname === LOGOUT_PATH) return method === "POST" ? sessions.logout(request) : notAllowed("POST");
    if (pathname === CALLBACK_PATH) return method === "GET" ? sessions.callback(request) : notAllowed("GET");
    if (pathname === WEBHOOK_PATH) {
      const started = Date.now();
      const res = await handleWebhook(request, { secret: settings.webhookSecret, registry, onVaultChanged: hooks.onVaultChanged }).catch((err: unknown) => errorResponse(err, quiet));
      const event = (request.headers.get("x-github-event") ?? "").replace(/[^\w.-]/g, "").slice(0, 40);
      await logEvent({ route: `POST webhook ${event}`.trim(), status: res.status, ms: Date.now() - started }, deps.log);
      return res;
    }
    if (pathname === HOSTED_API || pathname.startsWith(`${HOSTED_API}/`)) return api(request, url);
    return undefined;
  };

  return Object.assign(handler, { registry, app, sessions, who });
}

/** Unexpected errors aren't logged: their messages can carry vault names or content. The request's log line records the 500. */
const quiet = () => {};

/** A route's name for logs: its first segments, never ids or queries from the URL. */
const routeName = (method: string, path: string) => `${method} ${path.split("/").slice(0, 2).join("/").slice(0, 40)}`;

const notAllowed = (allow: string) => json(405, { error: "Method not allowed", code: "METHOD" }, { allow });
