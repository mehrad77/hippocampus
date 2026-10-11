import { HttpError, VAULT_HEADER, capabilities, errorResponse, json, readJson, type HostedSessionInfo, type HostedVaults } from "@hippocampus/dashboard";
import type { SqlDriver } from "@hippocampus/index";
import { CALLBACK_PATH } from "../github-login.ts";
import { GRANT_ID, confirmDeletion, deleteAccount, type AccountHooks, type ConnectedApps } from "./account.ts";
import { adminRoutes } from "./admin.ts";
import { GitHubApp, GitHubAppError } from "./github-app.ts";
import { GITLAB_CALLBACK_PATH, GITLAB_CONNECT_PATH, GitLabAccess } from "./gitlab.ts";
import { gitlabConnect } from "./gitlab-connect.ts";
import { checkGitLabVaults } from "./gitlab-health.ts";
import { logEvent, rateLimit, type RateLimiter } from "./limits.ts";
import { hostedSetup, hostedVault } from "./onboarding.ts";
import type { AgentClaim } from "./agent-claims.ts";
import { MAX_VAULTS_PER_USER, Registry, type Account, type MemberVault } from "./registry.ts";
import { sharing } from "./sharing.ts";
import { LOGIN_PATH, LOGOUT_PATH, createSessions, type SessionKV, type Sessions } from "./session.ts";
import { apiUrlOf, type HostedSettings } from "./settings.ts";
import { WEBHOOK_PATH, handleWebhook } from "./webhooks.ts";
import { DEVICE_PATH, DEVICE_TOKEN_PATH, DeviceRequests } from "./device.ts";
import { deviceRoutes } from "./device-routes.ts";

// The hosted app's own routes: accounts, onboarding, admin, account settings and GitHub's webhook.
// Everything else (the dashboard pages, a ready vault's API, MCP) falls through to the caller.

export const HOSTED_API = "/dashboard/api";

export interface HostedHooks extends AccountHooks {
  /** A vault's registry row changed (status, name, keys): tell its Durable Object. */
  onVaultChanged?: (vaultId: string) => void | Promise<void>;
  /** Link (or unlink, `null`) a GitHub login to one of a vault's humans, in its config (someone joining or leaving). */
  linkHuman?: (vault: MemberVault, human: string, login: string | null, via: string, create?: { domains?: string[] }) => Promise<void>;
  /** Seat an agent in a vault's party as `via` (a connection made for a new agent). */
  seatAgent?: (vault: MemberVault, agent: { id: string; title: string }, via: string) => Promise<void>;
  /** Connections to a vault were revoked (`key:<hash>`, `oauth:<grant>`): free the agent names they held. */
  releaseCredentials?: (vaultId: string, credentials: string[]) => Promise<void>;
  /** Which connection holds which agent name in a vault. */
  claims?: (vault: MemberVault) => Promise<AgentClaim[]>;
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

/** Who's calling: a live session's account, its vaults, and the one this request is about. */
export interface Caller {
  account: Account;
  /** Every vault the person has (owns or was let into), oldest first, with their role. */
  vaults: MemberVault[];
  /** The vault VAULT_HEADER names, else the one used last, else the oldest. */
  vault?: MemberVault;
  /** VAULT_HEADER named a vault that isn't theirs (or is gone). */
  unknownVault?: boolean;
}

/** Which of `vaults` a request means: the one it names, else the one used last, else the oldest. */
export function pickVault<V extends { id: string }>(vaults: readonly V[], asked: string | null, last?: string): { vault?: V; unknownVault?: boolean } {
  if (asked) {
    const vault = vaults.find((v) => v.id === asked);
    return vault ? { vault } : { unknownVault: true };
  }
  const vault = vaults.find((v) => v.id === last) ?? vaults[0];
  return vault ? { vault } : {};
}

export interface HostedRoutes {
  /** A response for the hosted app's routes; undefined for everything else. */
  (request: Request): Promise<Response | undefined>;
  registry: Registry;
  app: GitHubApp;
  /** Set when the instance has GitLab set up. */
  gitlab?: GitLabAccess;
  /** Check every GitLab vault against GitLab (a Cron Trigger runs this). */
  checkGitLab(): Promise<string[]>;
  sessions: Sessions;
  /** The caller, looked up once per request: the Worker reuses it to pick the vault's Durable Object. */
  who(request: Request): Promise<Caller | undefined>;
}

/** Sections of `/dashboard/api/` answered here whatever the vault's state. */
const OWN = new Set(["setup", "admin", "account", "vaults", "invites", "connect"]);

export function createHostedRoutes(deps: HostedDeps): HostedRoutes {
  const { settings, kv } = deps;
  const now = deps.now ?? (() => new Date());
  const registry = new Registry(deps.registry, now);
  const app = new GitHubApp({ appId: settings.appId, privateKey: settings.privateKey, apiUrl: apiUrlOf(settings), fetch: deps.fetch, now });
  const sessions = createSessions({ settings, kv, registry, app, fetch: deps.fetch, now });
  const gitlab = settings.gitlab ? new GitLabAccess(settings.gitlab, registry, { fetch: deps.fetch, now }) : undefined;
  const connect = gitlab ? gitlabConnect({ publicUrl: settings.publicUrl, kv, access: gitlab, sessions }) : undefined;
  const hooks = deps.hooks ?? {};
  const admin = adminRoutes({ registry, admins: settings.admins, onVaultChanged: hooks.onVaultChanged });

  const device = deviceRoutes({ db: new DeviceRequests(deps.registry, now), registry, settings });

  const memo = new WeakMap<Request, Promise<Caller | undefined>>();
  const who = (request: Request): Promise<Caller | undefined> => {
    let found = memo.get(request);
    if (!found) {
      found = (async () => {
        const signedIn = await sessions.current(request);
        if (!signedIn) return undefined;
        const { account } = signedIn;
        const vaults = await registry.vaultsOf(account);
        const asked = request.headers.get(VAULT_HEADER)?.trim() || null;
        const picked = pickVault(vaults, asked, account.lastVault);
        // Remember an explicit choice, so a new tab (or the consent page) opens the same vault.
        if (asked && picked.vault && account.lastVault !== picked.vault.id) await registry.setLastVault(account.user, picked.vault.id);
        return { account, vaults, ...picked };
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

  async function accountRoute(request: Request, method: string, sub: string, body: unknown, { account, vault, vaults }: Caller): Promise<Response> {
    if (sub === "" && method === "GET") {
      return json(200, {
        id: account.id,
        login: account.login,
        status: account.status,
        admin: settings.admins.has(account.id),
        identities: await registry.identities(account.user),
        ...(vault ? { vault: { id: vault.id, fullName: vault.fullName, status: vault.status } } : {}),
        vaults: vaults.map((v) => ({ id: v.id, fullName: v.fullName, status: v.status })),
      });
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
      await deleteAccount(account, { registry, app, gitlab, kv, hooks });
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
      if (caller.unknownVault) throw new HttpError(404, "That vault isn't one of yours, or it was removed.", "NO_VAULT");
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
      const share = () => sharing({ caller, registry, settings, now, linkHuman: hooks.linkHuman, revokeVaultGrants: hooks.revokeVaultGrants, releaseCredentials: hooks.releaseCredentials });
      if (section === "vaults") {
        if (sub !== "") return done(json(200, (await share().vaults(method, sub, body)) ?? { ok: true }));
        if (method !== "GET") throw new HttpError(404, `No such route: ${method} ${path}`, "NOT_FOUND");
        const found: HostedVaults = { vaults: caller.vaults.map((v) => hostedVault(v, settings)), ...(caller.vault ? { current: caller.vault.id } : {}), limit: MAX_VAULTS_PER_USER };
        return done(json(200, found));
      }
      if (section === "invites") return done(json(200, (await share().invites(method, sub, body)) ?? { ok: true }));
      if (section === "connect") return done(json(200, await device.dashboard(method, sub, body, url, caller)));
      let result: unknown;
      if (section === "admin") result = await admin(method, sub, body, url, caller.account);
      else {
        const port = hostedSetup({ caller, settings, registry, app, gitlab, kv, now, onVaultChanged: hooks.onVaultChanged, destroyVault: hooks.destroyVault, revokeVaultGrants: hooks.revokeVaultGrants, releaseCredentials: hooks.releaseCredentials, seatAgent: hooks.seatAgent, claims: hooks.claims });
        result = (sub === "" || sub === "status") && method === "GET" ? await port.status(url) : await port.handle(method, sub, body, url);
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
    if (pathname === GITLAB_CALLBACK_PATH || pathname === GITLAB_CONNECT_PATH) {
      if (method !== "GET") return notAllowed("GET");
      if (!connect) return json(404, { error: "This Hippocampus isn't set up for GitLab.", code: "NO_GITLAB" });
      return pathname === GITLAB_CALLBACK_PATH ? connect.callback(request) : connect.start(request);
    }
    if (pathname === WEBHOOK_PATH) {
      const started = Date.now();
      const res = await handleWebhook(request, { secret: settings.webhookSecret, registry, onVaultChanged: hooks.onVaultChanged }).catch((err: unknown) => errorResponse(err, quiet));
      const event = (request.headers.get("x-github-event") ?? "").replace(/[^\w.-]/g, "").slice(0, 40);
      await logEvent({ route: `POST webhook ${event}`.trim(), status: res.status, ms: Date.now() - started }, deps.log);
      return res;
    }
    if (pathname === DEVICE_PATH || pathname === DEVICE_TOKEN_PATH) {
      const started = Date.now();
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      // Starting is open to anyone, so it's limited like sign-ins; polling every few seconds isn't.
      if (pathname === DEVICE_PATH && !(await rateLimit(deps.limits?.signIn, `device:${ip}`))) return json(429, { error: "slow_down", error_description: "Too many requests; try again in a minute." });
      const res = await (pathname === DEVICE_PATH ? device.start(request) : device.token(request)).catch((err: unknown) => errorResponse(err, quiet));
      await logEvent({ route: `${method} ${pathname.slice(1)}`, status: res.status, ms: Date.now() - started }, deps.log);
      return res;
    }
    if (pathname === HOSTED_API || pathname.startsWith(`${HOSTED_API}/`)) return api(request, url);
    return undefined;
  };

  const checkGitLab = async (): Promise<string[]> => (gitlab ? checkGitLabVaults({ registry, access: gitlab, onVaultChanged: hooks.onVaultChanged }) : []);

  return Object.assign(handler, { registry, app, gitlab, checkGitLab, sessions, who });
}

/** Unexpected errors aren't logged: their messages can carry vault names or content. The request's log line records the 500. */
const quiet = () => {};

/** A route's name for logs: its first segments, never ids or queries from the URL. */
const routeName = (method: string, path: string) => `${method} ${path.split("/").slice(0, 2).join("/").slice(0, 40)}`;

const notAllowed = (allow: string) => json(405, { error: "Method not allowed", code: "METHOD" }, { allow });
