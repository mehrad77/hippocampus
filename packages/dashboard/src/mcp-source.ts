import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { parse } from "yaml";
import { HttpError } from "./http.ts";
import type { DashboardSource, SourceInfo } from "./source.ts";

/** `hippo://dashboard/whoami`, as `@hippocampus/mcp` serves it. */
interface Whoami {
  agent: string | null;
  scopes: string[];
  campaign: string;
  human: string;
}

const WHOAMI = "hippo://dashboard/whoami";

/** Connect to a Hippocampus MCP server over streamable HTTP, e.g. the Worker's `/mcp` with an agent token. */
export async function connectMcp(url: string, opts: { token?: string } = {}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : undefined,
  });
  const client = new Client({ name: "hippocampus-dashboard", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/** MCP errors → the statuses the dashboard API gives the same failures locally. */
async function upstream<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const message = (err instanceof Error ? err.message : String(err)).replace(/^(MCP error -?\d+: )+/, "");
    if (err instanceof McpError && err.code === ErrorCode.InvalidParams) {
      if ((err.data as { code?: string } | undefined)?.code === "VERSION") throw new HttpError(409, message, "VERSION");
      throw new HttpError(400, message, "VAULT");
    }
    throw new HttpError(502, `The MCP server failed: ${message}`, "UPSTREAM");
  }
}

/**
 * A dashboard over an agent's MCP connection (`hippo dashboard --mcp`). It sees what that token sees:
 * reads need the `read` scope, and remembering and quest updates are filed under the token's agent.
 * Rulings and new party members stay unavailable: they are the human's, not an agent's.
 * Async because the token's scopes decide which actions exist.
 */
export async function mcpSource(client: Client, opts: { url?: string } = {}): Promise<DashboardSource> {
  const read = async <T>(uri: string): Promise<T> => {
    const res = await upstream(() => client.readResource({ uri }));
    const content = res.contents[0];
    if (!content || !("text" in content)) throw new HttpError(502, `The MCP server sent no text for ${uri}`, "UPSTREAM");
    return JSON.parse(content.text) as T;
  };
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const res = await upstream(() => client.callTool({ name, arguments: args }));
    const text = (res.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    if (res.isError) throw new HttpError(400, text.replace(/^Error:\s*/, "").replace(/^(MCP error -?\d+: )+/, ""), "VAULT");
    return parse(text) as T;
  };

  // A vault that can't load still gets a (read-only) source, so `/session` can explain what's wrong.
  const me = await read<Whoami>(WHOAMI).catch((err: unknown) => {
    if (err instanceof HttpError && err.status < 500) return undefined;
    throw err;
  });
  // An unbound connection would need an `agent` argument on every write, and the dashboard can't pick one.
  const can = (scope: string) => !!me?.agent && me.scopes.includes(scope);

  return {
    async info(): Promise<SourceInfo> {
      const w = await read<Whoami>(WHOAMI);
      return { mode: "mcp", vault: { kind: "mcp", url: opts.url }, campaign: w.campaign, human: w.human, actor: { kind: "agent", id: w.agent ?? "unbound" } };
    },
    overview: () => read("hippo://dashboard/overview"),
    catalog: () => read("hippo://dashboard/catalog"),
    entity: (ref) => read(`hippo://dashboard/entity/${encodeURIComponent(ref)}`),
    graph: () => read("hippo://dashboard/graph"),
    chronicle: (month) => read(`hippo://dashboard/chronicle/${encodeURIComponent(month || "latest")}`),
    search: (query, limit) => read(`hippo://dashboard/search?q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ""}`),
    remember: can("remember") ? async (input) => (await call<{ stored: { id: string; path: string } }>("remember", { ...input })).stored : undefined,
    quest: can("quest") ? (ref, update) => call("update_quest", { quest: ref, ...update }) : undefined,
  };
}
