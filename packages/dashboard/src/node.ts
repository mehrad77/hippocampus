import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { securityHeaders } from "./http.ts";

/** node:http request → web `Request`, so the same handlers run under Node and on Workers. */
export function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // Required by undici for streamed request bodies.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

export async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") return;
    headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serve the built dashboard from `root` for paths under `basePath`. Directory URLs get their
 * `index.html`; nothing outside `root` is ever read. Returns undefined when there is no such file.
 */
export async function serveStatic(root: string, basePath: string, request: Request): Promise<Response | undefined> {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const { pathname } = new URL(request.url);
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return undefined;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(basePath.length));
  } catch {
    return undefined;
  }
  if (rel.includes("\0")) return undefined;
  const base = normalize(root);
  const candidates = rel.endsWith("/") || rel === "" ? [join(rel, "index.html")] : [rel, join(rel, "index.html")];
  for (const candidate of candidates) {
    const file = normalize(join(base, candidate));
    if (file !== base && !file.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) return undefined;
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) continue;
    const ext = extname(file);
    const immutable = rel.startsWith("/_astro/");
    const headers = {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "content-length": String(info.size),
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      ...securityHeaders(),
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { status: 200, headers });
  }
  return undefined;
}
