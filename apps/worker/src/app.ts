import type { HippoService } from "@hippocampus/core";
import { createHippoServer } from "@hippocampus/mcp";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { authenticate, type Grant, type TokenStore } from "./auth.ts";
import { DASHBOARD_BASE, isDashboardPath } from "./dashboard.ts";

export interface McpOptions {
  /** A service for one request (fresh reads, shared caches). */
  service: () => HippoService | Promise<HippoService>;
  jsonSchemaValidator?: jsonSchemaValidator;
}

export interface AppOptions extends McpOptions {
  tokens: TokenStore;
  /** The dashboard gate, for `/dashboard/*` and its sign-in callback. */
  dashboard?: (request: Request) => Promise<Response>;
}

export const plain = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

export const HOME = "Hippocampus MCP server. Connect an MCP client to /mcp.";

/** `/`: a browser goes on to the dashboard (when there is one); anything else learns where MCP is. */
export function home(request: Request, dashboard: boolean): Response {
  if (dashboard && /\btext\/html\b/i.test(request.headers.get("accept") ?? "")) return new Response(null, { status: 302, headers: { location: `${DASHBOARD_BASE}/` } });
  return plain(200, HOME);
}

/** MCP over HTTP for a caller who is already authenticated, whichever way. */
export function createMcpHandler(opts: McpOptions): (request: Request, grant: Grant) => Promise<Response> {
  return async (request, grant) => {
    // Stateless: no sessions, so no server-initiated streams to hold open (GET) or close (DELETE).
    if (request.method !== "POST") return plain(405, "Method not allowed", { allow: "POST" });
    const server = createHippoServer({ service: await opts.service(), agent: grant.agent, scopes: grant.scopes, jsonSchemaValidator: opts.jsonSchemaValidator });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}

/** The remote MCP endpoint with bearer tokens only (no OAuth), independent of the Workers runtime. */
export function createApp(opts: AppOptions): (request: Request) => Promise<Response> {
  const mcp = createMcpHandler(opts);
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (opts.dashboard && isDashboardPath(pathname)) return opts.dashboard(request);
    if (pathname === "/") return home(request, !!opts.dashboard);
    if (pathname !== "/mcp") return plain(404, "Not found");
    const grant = await authenticate(request, opts.tokens);
    if (!grant) return plain(401, "Missing or unknown bearer token", { "www-authenticate": 'Bearer realm="hippocampus"' });
    return mcp(request, grant);
  };
}
