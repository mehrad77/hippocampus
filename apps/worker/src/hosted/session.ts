import { cookie, json, safeEqual, securityHeaders } from "@hippocampus/dashboard";
import { hashToken, type KVLike } from "../auth.ts";
import { CALLBACK_PATH, base64url, githubAuthorizeUrl, githubToken, githubTokenUser, type GitHubClient } from "../github-login.ts";
import { escape, page } from "../pages.ts";
import type { GitHubApp } from "./github-app.ts";
import type { Account, Registry } from "./registry.ts";
import { apiUrlOf, oauthUrlOf, type HostedSettings } from "./settings.ts";

// Accounts sign in with the GitHub App's user authorization. The same callback also receives the
// app's install redirect, which is how a person's installation gets tied to their account.

export const LOGIN_PATH = "/dashboard/auth/login";
export const LOGOUT_PATH = "/dashboard/auth/logout";
/** Where onboarding continues once the app is installed. */
export const SETUP_REPO = "/dashboard/setup/#repo";

const LOGIN_TTL = 600;
const SESSION_TTL = 7 * 24 * 3600;
const INSTALL_TTL = 3600;

export type SessionKV = Pick<KVLike, "get" | "put" | "delete">;

interface Session {
  accountId: number;
  login: string;
  epoch: number;
  created: string;
}

interface PendingLogin {
  verifier: string;
  return: string;
  /** Set when the sign-in was started to confirm who installed the app. */
  installation?: number;
}

/** An installation the person proved is theirs, waiting for them to pick its repo. */
export interface PendingInstallation {
  installationId: number;
  at: string;
}

export interface SignedIn {
  account: Account;
  /** The session's KV key. */
  key: string;
}

const loginKey = (state: string) => `hosted:login:${state}`;
const sessionKey = async (id: string) => `hosted:session:${await hashToken(id)}`;
const installKey = (accountId: number) => `hosted:install:${accountId}`;
const randomId = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export async function pendingInstallation(kv: SessionKV, accountId: number): Promise<PendingInstallation | undefined> {
  const p = (await kv.get(installKey(accountId), "json")) as PendingInstallation | null;
  return typeof p?.installationId === "number" ? p : undefined;
}

export const clearPendingInstallation = (kv: SessionKV, accountId: number) => kv.delete(installKey(accountId));

/**
 * Where to land after signing in: a dashboard page, or the connector consent page (`/authorize?…`),
 * on this origin and nowhere else.
 */
export function safeReturn(value: string | null | undefined, origin: string): string {
  const home = "/dashboard/";
  const allowed = (path: string) => path.startsWith(home) || path === "/authorize";
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return home;
  try {
    const url = new URL(value, origin);
    return url.origin === origin && allowed(url.pathname) ? `${url.pathname}${url.search}${url.hash}` : home;
  } catch {
    return home;
  }
}

export interface SessionDeps {
  settings: HostedSettings;
  kv: SessionKV;
  registry: Registry;
  app: GitHubApp;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface Sessions {
  /** `GET /dashboard/auth/login?return=…` */
  login(request: Request): Promise<Response>;
  /** `GET /oauth/github/callback`: a sign-in coming back, or the app's install redirect. */
  callback(request: Request): Promise<Response>;
  /** `POST /dashboard/auth/logout` */
  logout(request: Request): Promise<Response>;
  /** The signed-in account, if the session is live: the account exists, isn't denied or deleted, and its epoch hasn't moved. */
  current(request: Request): Promise<SignedIn | undefined>;
  /** End the request's session (account deletion); returns the cookie that clears it. */
  end(request: Request): Promise<string>;
}

export function createSessions(deps: SessionDeps): Sessions {
  const { settings, kv, registry, app } = deps;
  const now = deps.now ?? (() => new Date());
  const client: GitHubClient = {
    github: { clientId: settings.clientId, clientSecret: settings.clientSecret, oauthUrl: oauthUrlOf(settings), apiUrl: apiUrlOf(settings) },
    fetch: deps.fetch,
  };
  const callbackUrl = `${settings.publicUrl}${CALLBACK_PATH}`;
  // Local `wrangler dev` runs on plain http, where browsers refuse `Secure` and `__Host-` cookies.
  const secure = new URL(settings.publicUrl).protocol === "https:";
  const names = { session: secure ? "__Host-hippo_session" : "hippo_session", login: secure ? "__Host-hippo_login" : "hippo_login" };
  // Lax, not Strict: GitHub's install redirect is a cross-site navigation, and it has to arrive signed in.
  const setCookie = (name: string, value: string, maxAge: number) => `${name}=${value}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  const clearLogin = setCookie(names.login, "", 0);
  const clearSession = setCookie(names.session, "", 0);

  const fail = (status: number, title: string, body: string, cookies: string[] = []) => {
    const headers = new Headers();
    for (const c of cookies) headers.append("set-cookie", c);
    return page(status, title, `${body}<p><a href="${LOGIN_PATH}">Sign in again</a> · <a href="/dashboard/">Dashboard</a></p>`, headers);
  };

  async function current(request: Request): Promise<SignedIn | undefined> {
    const id = cookie(request, names.session);
    if (!id) return undefined;
    const key = await sessionKey(id);
    const s = (await kv.get(key, "json")) as Session | null;
    if (typeof s?.accountId !== "number") return undefined;
    const account = await registry.account(s.accountId);
    if (!account || account.status === "denied" || account.status === "deleted" || account.epoch !== s.epoch) {
      await kv.delete(key);
      return undefined;
    }
    return { account, key };
  }

  async function startLogin(ret: string, installation?: number, extra: string[] = []): Promise<Response> {
    const state = randomId();
    const verifier = randomId();
    const pending: PendingLogin = { verifier, return: safeReturn(ret, settings.publicUrl), ...(installation ? { installation } : {}) };
    await kv.put(loginKey(state), JSON.stringify(pending), { expirationTtl: LOGIN_TTL });
    const location = await githubAuthorizeUrl(client, { redirectUri: callbackUrl, state, verifier });
    return redirect(location, [...extra, setCookie(names.login, state, LOGIN_TTL)]);
  }

  async function login(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The cookie has to live on the origin GitHub sends the person back to.
    if (url.origin !== settings.publicUrl) return redirect(`${settings.publicUrl}${url.pathname}${url.search}`);
    return startLogin(url.searchParams.get("return") ?? "/dashboard/");
  }

  async function newSession(account: Account): Promise<string> {
    const id = randomId();
    const s: Session = { accountId: account.id, login: account.login, epoch: account.epoch, created: now().toISOString() };
    await kv.put(await sessionKey(id), JSON.stringify(s), { expirationTtl: SESSION_TTL });
    return setCookie(names.session, id, SESSION_TTL);
  }

  /**
   * Tie an installation to the account, after checking with the person's own GitHub token that
   * they can see it and that it's on their personal account. The token is used here and dropped.
   */
  async function adoptInstallation(userToken: string, account: Account, installationId: number, cookies: string[]): Promise<Response> {
    if (account.status !== "approved")
      return fail(403, "Your account isn't approved yet", "<p>An admin has to approve your account before the app can set up a vault. You'll be able to continue from the dashboard once it is.</p>", cookies);
    const installations = await app.userInstallations(userToken).catch(() => undefined);
    if (!installations) return fail(502, "Couldn't check the installation", "<p>GitHub didn't answer. Try installing again in a minute.</p>", cookies);
    const installation = installations.find((i) => i.id === installationId);
    if (!installation) return fail(403, "That installation isn't yours", "<p>Your GitHub account can't see that installation of the app. Install it from the dashboard's setup page.</p>", cookies);
    if (installation.account.type !== "User" || installation.account.id !== account.id)
      return fail(
        403,
        "Personal accounts only",
        `<p>The app was installed on <strong>@${escape(installation.account.login)}</strong>. Hippocampus keeps vaults in personal accounts: install it on <strong>@${escape(account.login)}</strong> and pick a repo there.</p>`,
        cookies,
      );
    const pending: PendingInstallation = { installationId, at: now().toISOString() };
    await kv.put(installKey(account.id), JSON.stringify(pending), { expirationTtl: INSTALL_TTL });
    return redirect(SETUP_REPO, cookies);
  }

  async function finishLogin(request: Request, url: URL): Promise<Response> {
    // The state must come back to the browser that started the sign-in, not just exist.
    const state = url.searchParams.get("state") ?? "";
    if (!state || !safeEqual(state, cookie(request, names.login) ?? "")) return fail(400, "This sign-in can't continue", "<p>It was started in another browser, or it has expired.</p>", [clearLogin]);
    const pending = (await kv.get(loginKey(state), "json")) as PendingLogin | null;
    await kv.delete(loginKey(state));
    if (!pending?.verifier) return fail(400, "This sign-in has expired", "<p>Sign-in links last ten minutes and work once.</p>", [clearLogin]);
    const code = url.searchParams.get("code");
    if (!code) return fail(400, "GitHub sign-in was cancelled", "", [clearLogin]);
    const token = await githubToken(client, code, { verifier: pending.verifier, redirectUri: callbackUrl });
    const user = token ? await githubTokenUser(client, token) : undefined;
    if (!token || !user) return fail(400, "GitHub sign-in failed", "", [clearLogin]);
    const account = await registry.signIn(user, { admin: settings.admins.has(user.id) });
    if (account.status === "denied") return fail(403, "No access", "<p>Access to this Hippocampus wasn't granted for this GitHub account.</p>", [clearLogin]);
    const cookies = [clearLogin, await newSession(account)];
    if (pending.installation) return adoptInstallation(token, account, pending.installation, cookies);
    return redirect(safeReturn(pending.return, settings.publicUrl), cookies);
  }

  /**
   * GitHub's redirect after installing the app: `installation_id`, `setup_action`, and (with
   * "request user authorization during installation" on) a `code`. The query alone proves nothing,
   * so the code's user must be the signed-in account. Without a session or a code, the person signs
   * in first and the installation is checked with that sign-in's token instead: a code that wasn't
   * started from this browser never creates a session.
   */
  async function install(request: Request, url: URL): Promise<Response> {
    const raw = url.searchParams.get("installation_id") ?? "";
    if (!/^\d{1,15}$/.test(raw)) return fail(400, "That install link is broken", "<p>It has no installation id.</p>");
    const installationId = Number(raw);
    if (url.searchParams.get("setup_action") === "request")
      return fail(202, "Install requested", "<p>An organization owner has to approve that request. Hippocampus keeps vaults in personal accounts: install the app on your own account instead.</p>");
    const signedIn = await current(request);
    const code = url.searchParams.get("code");
    if (!signedIn || !code) return startLogin(SETUP_REPO, installationId);
    const token = await githubToken(client, code, { redirectUri: callbackUrl });
    const user = token ? await githubTokenUser(client, token) : undefined;
    if (!token || !user) return fail(400, "GitHub sign-in failed", "<p>Install the app again from the dashboard's setup page.</p>");
    if (user.id !== signedIn.account.id)
      return fail(
        403,
        "Different GitHub account",
        `<p>The app was installed as <strong>@${escape(user.login)}</strong>, but you're signed in here as <strong>@${escape(signedIn.account.login)}</strong>. Sign out, then sign in as @${escape(user.login)}.</p>`,
      );
    return adoptInstallation(token, signedIn.account, installationId, []);
  }

  async function callback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    return url.searchParams.has("installation_id") ? install(request, url) : finishLogin(request, url);
  }

  async function end(request: Request): Promise<string> {
    const id = cookie(request, names.session);
    if (id) await kv.delete(await sessionKey(id));
    return clearSession;
  }

  async function logout(request: Request): Promise<Response> {
    const origin = request.headers.get("origin");
    if (origin && origin !== settings.publicUrl) return json(403, { error: "Cross-origin request refused", code: "ORIGIN" });
    const headers = new Headers({ "cache-control": "no-store", ...securityHeaders() });
    headers.append("set-cookie", await end(request));
    // A plain form post goes back to the dashboard; `fetch` gets an empty answer.
    if (!/\btext\/html\b/i.test(request.headers.get("accept") ?? "")) return new Response(null, { status: 204, headers });
    headers.set("location", "/dashboard/");
    return new Response(null, { status: 303, headers });
  }

  return { login, callback, logout, current, end };
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store", ...securityHeaders() });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}
