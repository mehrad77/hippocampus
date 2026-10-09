import type { HippoService } from "@hippocampus/core";
import { createHippoServer } from "@hippocampus/mcp";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { authenticate, type TokenStore } from "./auth.ts";

export interface AppOptions {
  tokens: TokenStore;
  /** A service for one request (fresh reads, shared caches). */
  service: () => HippoService | Promise<HippoService>;
  jsonSchemaValidator?: jsonSchemaValidator;
}

const plain = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

/** The remote MCP endpoint, independent of the Workers runtime so it can be tested anywhere. */
export function createApp(opts: AppOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return plain(200, "Hippocampus MCP server. Connect an MCP client to /mcp with a bearer token.");
    if (pathname !== "/mcp") return plain(404, "Not found");
    const grant = await authenticate(request, opts.tokens);
    if (!grant) return plain(401, "Missing or unknown bearer token", { "www-authenticate": 'Bearer realm="hippocampus"' });
    // Stateless: no sessions, so no server-initiated streams to hold open (GET) or close (DELETE).
    if (request.method !== "POST") return plain(405, "Method not allowed", { allow: "POST" });

    const server = createHippoServer({ service: await opts.service(), agent: grant.agent, scopes: grant.scopes, jsonSchemaValidator: opts.jsonSchemaValidator });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
