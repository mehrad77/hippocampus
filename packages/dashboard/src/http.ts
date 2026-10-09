import { StoreConflictError, VaultError, VaultVersionError } from "@hippocampus/core";
import { ZodError } from "zod";

/** An error with an HTTP status and a stable `code` the UI can branch on. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "ERROR",
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const MAX_BODY = 64 * 1024;

/** Headers for every dashboard response, HTML or JSON. The page CSP itself comes from the Astro build (script and style hashes). */
export function securityHeaders(): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...securityHeaders(), ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json(err.status, { error: err.message, code: err.code, ...err.extra });
  if (err instanceof ZodError) return json(400, { error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), code: "INVALID" });
  if (err instanceof VaultVersionError) return json(409, { error: err.message, code: "VERSION" });
  if (err instanceof StoreConflictError) return json(409, { error: "The vault changed while saving. Reload and try again.", code: "CONFLICT" });
  if (err instanceof VaultError) return json(400, { error: err.message, code: "VAULT" });
  console.error(err);
  return json(500, { error: "Something went wrong on the server; see its log.", code: "INTERNAL" });
}

/**
 * Parse a JSON POST body. Requiring `application/json` makes every cross-site write a CORS
 * preflight, which this API never answers, so other sites can't post here with your cookies.
 */
export async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) throw new HttpError(415, "Send JSON (content-type: application/json)", "UNSUPPORTED_MEDIA_TYPE");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new HttpError(413, "Request body too large", "TOO_LARGE");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Request body too large", "TOO_LARGE");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "Body is not valid JSON", "INVALID");
  }
}

export function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Constant-time string comparison, so a token can't be guessed byte by byte from response times. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Who the guard let in. Throw an `HttpError` to refuse. */
export interface GuardResult {
  user?: { login: string };
}

export type Guard = (request: Request) => GuardResult | Promise<GuardResult>;

export const LOCAL_COOKIE = "hippo_local";

export interface LocalGuardOptions {
  port: number;
  /** The launch token. Absent: no cookie needed (only for the demo in `astro dev`). */
  token?: string;
}

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Only this machine's browser: a loopback Host (DNS rebinding), same-origin writes, and the launch token's cookie. */
export function localGuard(opts: LocalGuardOptions): Guard {
  const hosts = new Set(LOOPBACK.map((h) => `${h}:${opts.port}`));
  return (request) => {
    const host = request.headers.get("host") ?? "";
    if (!hosts.has(host)) throw new HttpError(421, `This dashboard only answers on 127.0.0.1:${opts.port}`, "MISDIRECTED");
    if (request.method !== "GET" && request.headers.get("origin") !== `http://${host}`) throw new HttpError(403, "Cross-origin request refused", "ORIGIN");
    if (opts.token && !safeEqual(cookie(request, LOCAL_COOKIE) ?? "", opts.token))
      throw new HttpError(401, "Open the link printed by `hippo dashboard` to sign in on this browser.", "LOCAL_TOKEN");
    return {};
  };
}

/** `GET <base>/auth/local?token=…`: trade the launch token for a cookie, then get it out of the address bar. */
export function localSignIn(request: Request, opts: { token: string; basePath: string; maxAgeDays?: number }): Response {
  const url = new URL(request.url);
  const given = url.searchParams.get("token") ?? "";
  if (!safeEqual(given, opts.token)) return json(401, { error: "That link is out of date. Use the one `hippo dashboard` printed.", code: "LOCAL_TOKEN" });
  const next = url.searchParams.get("next") ?? "";
  const target = next.startsWith(`${opts.basePath}/`) && !next.startsWith("//") ? next : `${opts.basePath}/`;
  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      "set-cookie": `${LOCAL_COOKIE}=${encodeURIComponent(opts.token)}; HttpOnly; SameSite=Strict; Path=${opts.basePath}; Max-Age=${(opts.maxAgeDays ?? 30) * 86400}`,
      "cache-control": "no-store",
      ...securityHeaders(),
    },
  });
}
