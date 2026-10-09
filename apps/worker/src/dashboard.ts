import { json, securityHeaders } from "@hippocampus/dashboard";

// The dashboard's built UI, served from the Worker's asset store. Pages are static and hold no
// vault data: everything from a vault comes through `/dashboard/api/`, behind a session.

export const DASHBOARD_BASE = "/dashboard";
export const DASHBOARD_API = `${DASHBOARD_BASE}/api`;
/** Where `/` sends someone who isn't signed in. */
export const WELCOME = `${DASHBOARD_BASE}/welcome/`;

export const isDashboardPath = (pathname: string) => pathname === DASHBOARD_BASE || pathname.startsWith(`${DASHBOARD_BASE}/`);
export const isDashboardApi = (pathname: string) => pathname === DASHBOARD_API || pathname.startsWith(`${DASHBOARD_API}/`);

/** The Worker's ASSETS binding, or a stand-in. */
export interface Assets {
  fetch(request: Request): Promise<Response>;
}

/**
 * A file of the built UI with the headers every dashboard page carries. Script and style rules
 * come from Astro's own `<meta>` CSP (hashes per build), so only framing is restricted here. HTML
 * changes with each deploy and is revalidated; the hashed `_astro/*` files never reach the Worker.
 */
export async function serveAsset(assets: Assets, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "Method not allowed", code: "METHOD" }, { allow: "GET, HEAD" });
  let res = await assets.fetch(request);
  if (res.status === 404) res = await notFound(assets, request);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(securityHeaders())) headers.set(k, v);
  if (/^text\/html\b/i.test(headers.get("content-type") ?? "")) headers.set("cache-control", "no-cache");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** The UI's own 404 page, wherever the build put it (`404.html` or `404/index.html`). */
async function notFound(assets: Assets, request: Request): Promise<Response> {
  for (const path of [`${DASHBOARD_BASE}/404/`, `${DASHBOARD_BASE}/404`, `${DASHBOARD_BASE}/404.html`]) {
    const res = await assets.fetch(new Request(new URL(path, request.url), { method: request.method, headers: { accept: "text/html" } }));
    if (res.ok) return new Response(res.body, { status: 404, headers: res.headers });
  }
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}
