import { HttpError, cookie, json, safeEqual, securityHeaders, type Guard } from "@hippocampus/dashboard";
import { hashToken, type KVLike } from "./auth.ts";
import { CALLBACK_PATH, base64url, githubAuthorizeUrl, githubUser, type OAuthSettings } from "./github-login.ts";
import { escape, page } from "./pages.ts";

export const DASHBOARD_BASE = "/dashboard";
export const DASHBOARD_API = `${DASHBOARD_BASE}/api`;
/** A subdirectory of the OAuth app's registered callback, which GitHub accepts without registering it separately. */
export const DASHBOARD_CALLBACK = `${CALLBACK_PATH}/dashboard`;

const LOGIN_TTL = 600;
const SESSION_TTL = 7 * 24 * 3600;

/** Paths the dashboard gate answers. `CALLBACK_PATH` itself stays the connector flow's. */
export function isDashboardPath(pathname: string): boolean {
  return pathname === DASHBOARD_BASE || pathname.startsWith(`${DASHBOARD_BASE}/`) || pathname === DASHBOARD_CALLBACK;
}

export type SessionKV = Pick<KVLike, "get" | "put" | "delete">;

export interface DashboardGateOptions {
  /** Undefined while OAuth is off: pages still load, and the API answers 503 with what's missing. */
  settings?: OAuthSettings;
  /** The settings OAuth still needs (`oauthMissing`), for that 503. */
  missing?: string[];
  /** Sign-in state and sessions (the Worker's OAUTH_KV, under `dashboard:`). */
  kv: SessionKV;
  /** The built UI: the Worker's ASSETS binding. */
  assets: { fetch(request: Request): Promise<Response> };
  /** The dashboard API, built around the gate's guard. */
  api: (guard: Guard) => (request: Request) => Promise<Response>;
}

export interface DashboardGate {
  fetch(request: Request): Promise<Response>;
  /** Who's calling the API: an owner with a live session, or an `HttpError`. */
  guard: Guard;
}

interface Session {
  login: string;
  githubId: number;
  created: string;
}

interface PendingLogin {
  verifier: string;
  return: string;
}

const loginKey = (state: string) => `dashboard:login:${state}`;
const sessionKey = async (id: string) => `dashboard:session:${await hashToken(id)}`;
const randomId = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * The dashboard on the Worker: GitHub sign-in for the vault's owners, a session cookie, the API
 * behind it, and the built UI. The pages are static and hold no vault data, so they load for
 * anyone; everything from the vault comes through the API, which needs an owner's session.
 */
export function createDashboardGate(opts: DashboardGateOptions): DashboardGate {
  const { settings, kv } = opts;
  // Local `wrangler dev` runs on plain http, where browsers refuse `Secure` and `__Host-` cookies.
  const secure = !settings || new URL(settings.publicUrl).protocol === "https:";
  const names = { session: secure ? "__Host-hippo_session" : "hippo_session", login: secure ? "__Host-hippo_login" : "hippo_login" };
  const setCookie = (name: string, value: string, sameSite: "Strict" | "Lax", maxAge: number) =>
    `${name}=${value}; HttpOnly;${secure ? " Secure;" : ""} SameSite=${sameSite}; Path=/; Max-Age=${maxAge}`;
  const needs = opts.missing?.length ? opts.missing : ["HIPPO_PUBLIC_URL", "HIPPO_OWNERS", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"];
  const offMessage = `Sign-in isn't set up on this Worker yet. Set ${needs.join(", ")} as Worker secrets and redeploy.`;

  const session = async (request: Request): Promise<Session | undefined> => {
    const id = cookie(request, names.session);
    if (!id) return undefined;
    const s = (await kv.get(await sessionKey(id), "json")) as Session | null;
    return typeof s?.login === "string" ? s : undefined;
  };

  const guard: Guard = async (request) => {
    if (!settings) throw new HttpError(503, offMessage, "OAUTH_OFF", { needs });
    if (request.method !== "GET" && request.method !== "HEAD") {
      // Strict cookies and JSON-only bodies already stop cross-site writes; this is the third lock.
      const site = request.headers.get("sec-fetch-site");
      if (request.headers.get("origin") !== settings.publicUrl || (site && site !== "same-origin")) throw new HttpError(403, "Cross-origin request refused", "ORIGIN");
    }
    const s = await session(request);
    // Owners are re-checked every time, so removing someone from HIPPO_OWNERS locks them out at once.
    if (!s || !settings.owners.has(s.login.toLowerCase())) throw new HttpError(401, "Sign in with GitHub to open the vault.", "SIGN_IN", { login: `${DASHBOARD_BASE}/auth/login` });
    return { user: { login: s.login } };
  };

  const api = opts.api(guard);

  const offPage = () => page(503, "Sign-in isn't set up yet", `<p>Set ${needs.map((n) => `<code>${escape(n)}</code>`).join(", ")} as Worker secrets, then redeploy.</p>`);

  async function login(request: Request): Promise<Response> {
    if (!settings) return offPage();
    const url = new URL(request.url);
    // The cookie has to live on the origin GitHub sends the owner back to.
    if (url.origin !== settings.publicUrl) return redirect(`${settings.publicUrl}${url.pathname}${url.search}`);
    const state = randomId();
    const verifier = randomId();
    const pending: PendingLogin = { verifier, return: safeReturn(url.searchParams.get("return"), settings.publicUrl) };
    await kv.put(loginKey(state), JSON.stringify(pending), { expirationTtl: LOGIN_TTL });
    const location = await githubAuthorizeUrl(settings, { redirectUri: `${settings.publicUrl}${DASHBOARD_CALLBACK}`, state, verifier });
    return redirect(location, [setCookie(names.login, state, "Lax", LOGIN_TTL)]);
  }

  async function callback(request: Request): Promise<Response> {
    if (!settings) return offPage();
    const url = new URL(request.url);
    const clear = setCookie(names.login, "", "Lax", 0);
    const fail = (status: number, title: string, body: string) =>
      page(status, title, `${body}<p><a href="${DASHBOARD_BASE}/auth/login">Sign in again</a></p>`, new Headers({ "set-cookie": clear }));
    // The state must come back to the browser that started the sign-in, not just exist.
    const state = url.searchParams.get("state") ?? "";
    if (!state || !safeEqual(state, cookie(request, names.login) ?? "")) return fail(400, "This sign-in can't continue", "<p>It was started in another browser, or it has expired.</p>");
    const pending = (await kv.get(loginKey(state), "json")) as PendingLogin | null;
    await kv.delete(loginKey(state));
    if (!pending?.verifier) return fail(400, "This sign-in has expired", "<p>Sign-in links last ten minutes and work once.</p>");
    const code = url.searchParams.get("code");
    if (!code) return fail(400, "GitHub sign-in was cancelled", "");
    const user = await githubUser(settings, code, pending.verifier, `${settings.publicUrl}${DASHBOARD_CALLBACK}`);
    if (!user) return fail(400, "GitHub sign-in failed", "");
    if (!settings.owners.has(user.login.toLowerCase()))
      return fail(403, "Not an owner of this vault", `<p><strong>@${escape(user.login)}</strong> isn't listed in <code>HIPPO_OWNERS</code>. Sign in with the account that owns the vault.</p>`);

    const id = randomId();
    const s: Session = { login: user.login, githubId: user.id, created: new Date().toISOString() };
    await kv.put(await sessionKey(id), JSON.stringify(s), { expirationTtl: SESSION_TTL });
    return redirect(safeReturn(pending.return, settings.publicUrl), [clear, setCookie(names.session, id, "Strict", SESSION_TTL)]);
  }

  async function logout(request: Request): Promise<Response> {
    const origin = request.headers.get("origin");
    if (settings && origin && origin !== settings.publicUrl) return json(403, { error: "Cross-origin request refused", code: "ORIGIN" });
    const id = cookie(request, names.session);
    if (id) await kv.delete(await sessionKey(id));
    const headers = new Headers({ "cache-control": "no-store", ...securityHeaders() });
    headers.append("set-cookie", setCookie(names.session, "", "Strict", 0));
    // A plain form post goes back to the dashboard; `fetch` gets an empty answer.
    if (!wantsHtml(request)) return new Response(null, { status: 204, headers });
    headers.set("location", `${DASHBOARD_BASE}/`);
    return new Response(null, { status: 303, headers });
  }

  async function asset(request: Request): Promise<Response> {
    let res = await opts.assets.fetch(request);
    if (res.status === 404) res = await notFound(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(securityHeaders())) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  /** The UI's own 404 page, wherever the build put it (`404.html` or `404/index.html`). */
  async function notFound(request: Request): Promise<Response> {
    for (const path of [`${DASHBOARD_BASE}/404/`, `${DASHBOARD_BASE}/404`, `${DASHBOARD_BASE}/404.html`]) {
      const res = await opts.assets.fetch(new Request(new URL(path, request.url), { method: request.method, headers: { accept: "text/html" } }));
      if (res.ok) return new Response(res.body, { status: 404, headers: res.headers });
    }
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  return {
    guard,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const method = request.method;
      if (pathname === DASHBOARD_API || pathname.startsWith(`${DASHBOARD_API}/`)) {
        if (!settings) return json(503, { error: offMessage, code: "OAUTH_OFF", needs });
        return api(request);
      }
      if (pathname === `${DASHBOARD_BASE}/auth/login`) return method === "GET" ? login(request) : notAllowed("GET");
      if (pathname === DASHBOARD_CALLBACK) return method === "GET" ? callback(request) : notAllowed("GET");
      if (pathname === `${DASHBOARD_BASE}/auth/logout`) return method === "POST" ? logout(request) : notAllowed("POST");
      if (pathname.startsWith(`${DASHBOARD_BASE}/auth/`)) return json(404, { error: "Not found", code: "NOT_FOUND" });
      return method === "GET" || method === "HEAD" ? asset(request) : notAllowed("GET, HEAD");
    },
  };
}

/** Where to land after signing in: a dashboard page on this origin, never anywhere else. */
export function safeReturn(value: string | null | undefined, origin: string): string {
  const home = `${DASHBOARD_BASE}/`;
  if (!value?.startsWith(home) || value.startsWith("//")) return home;
  try {
    const url = new URL(value, origin);
    return url.origin === origin && url.pathname.startsWith(home) ? `${url.pathname}${url.search}${url.hash}` : home;
  } catch {
    return home;
  }
}

const wantsHtml = (request: Request) => /\btext\/html\b/i.test(request.headers.get("accept") ?? "");

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store", ...securityHeaders() });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

const notAllowed = (allow: string) => json(405, { error: "Method not allowed", code: "METHOD" }, { allow });
