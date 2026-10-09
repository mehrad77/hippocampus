import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createDashboardApi, localGuard, localSignIn, securityHeaders, type SetupPort } from "@hippocampus/dashboard";
import { sendResponse, serveStatic, toRequest } from "@hippocampus/dashboard/node";
import type { DashboardRuntime } from "./runtime.ts";

export const BASE = "/dashboard";
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

export interface DashboardServerOptions {
  /** 0 picks a free port. Otherwise, when it's taken, the next few are tried. */
  port: number;
  tries?: number;
  /** The launch token: the sign-in link trades it for a cookie. */
  token: string;
  runtime: DashboardRuntime;
  setup?: SetupPort;
  /** The built UI (see `dashboardRoot`); undefined serves a page explaining how to build it. */
  staticRoot?: string;
}

export interface DashboardServer {
  server: Server;
  port: number;
  origin: string;
  /** Open this once per browser: it sets the cookie and lands on the dashboard. */
  signInUrl: string;
  close(): Promise<void>;
}

const page = (status: number, title: string, body: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1>${body}</body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...securityHeaders() },
  });

const notBuilt = () =>
  page(
  503,
  "The dashboard isn't built",
  "<p>This copy of Hippocampus runs from source and the UI hasn't been built yet. From the repo, run:</p><pre>pnpm --filter @hippocampus/dashboard-ui build</pre><p>then reload. (Or <code>pnpm dev:dashboard</code> for the live dev server.)</p>",
);

async function notFound(root: string | undefined): Promise<Response> {
  const file = root && join(root, "404.html");
  if (file && existsSync(file)) {
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...securityHeaders() },
    });
  }
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...securityHeaders() } });
}

async function listen(server: Server, port: number, tries: number): Promise<number> {
  for (let i = 0; ; i++) {
    const p = port === 0 ? 0 : port + i;
    try {
      await new Promise<void>((done, fail) => {
        server.once("error", fail);
        server.listen(p, "127.0.0.1", () => {
          server.off("error", fail);
          done();
        });
      });
      return (server.address() as AddressInfo).port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || port === 0 || i + 1 >= tries)
        throw (err as NodeJS.ErrnoException).code === "EADDRINUSE" ? new Error(`ports ${port}–${port + i} are all taken; choose one with --port`) : err;
    }
  }
}

/**
 * The dashboard on 127.0.0.1 only: the built UI under `/dashboard/`, its API under
 * `/dashboard/api/`, and the sign-in link. Every request must carry a loopback Host (DNS rebinding).
 */
export async function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServer> {
  let handler: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
  let hosts = new Set<string>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "";
    if (!hosts.has(host)) {
      res.writeHead(421, { "content-type": "text/plain; charset=utf-8" }).end("This dashboard only answers on 127.0.0.1.\n");
      return;
    }
    handler(toRequest(req, `http://${host}`))
      .then((response) => sendResponse(res, response))
      .catch((err: unknown) => {
        console.error(err);
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Internal error\n");
      });
  });

  const port = await listen(server, opts.port, opts.tries ?? 10);
  hosts = new Set(LOOPBACK.map((h) => `${h}:${port}`));
  const api = createDashboardApi({
    basePath: `${BASE}/api`,
    source: () => opts.runtime.current,
    setup: opts.setup,
    guard: localGuard({ port, token: opts.token }),
  });

  handler = async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return new Response(null, { status: 302, headers: { location: `${BASE}/`, ...securityHeaders() } });
    if (pathname === `${BASE}/auth/local`) return localSignIn(request, { token: opts.token, basePath: BASE });
    if (pathname === `${BASE}/api` || pathname.startsWith(`${BASE}/api/`)) return api(request);
    if (pathname === BASE || pathname.startsWith(`${BASE}/`)) {
      if (!opts.staticRoot) return notBuilt();
      return (await serveStatic(opts.staticRoot, BASE, request)) ?? notFound(opts.staticRoot);
    }
    return notFound(undefined);
  };

  const origin = `http://127.0.0.1:${port}`;
  return {
    server,
    port,
    origin,
    signInUrl: `${origin}${BASE}/auth/local?token=${encodeURIComponent(opts.token)}`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

/**
 * The launch token, kept in `<configDir>/dashboard-token` (0600) so the sign-in link and the
 * browser's cookie survive restarts. Delete the file to sign every browser out.
 */
export async function launchToken(file: string): Promise<string> {
  if (existsSync(file)) {
    const saved = (await readFile(file, "utf8")).trim();
    if (/^[A-Za-z0-9_-]{43,}$/.test(saved)) return saved;
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return token;
}
