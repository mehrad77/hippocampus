import { SCOPES, type Scope } from "@hippocampus/mcp";

/** What a bearer token lets its holder do, and as whom. */
export interface Grant {
  agent: string;
  scopes: Scope[];
  created?: string;
}

/** Token hash → grant. Only hashes are stored, so a leaked store doesn't leak tokens. */
export interface TokenStore {
  get(hash: string): Promise<unknown>;
}

const TOKEN_PREFIX = "hippo_";

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The grant for the request's bearer token, or undefined if it has none or an unknown one. */
export async function authenticate(request: Request, tokens: TokenStore): Promise<Grant | undefined> {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  return token ? lookupToken(token, tokens) : undefined;
}

/** The grant for one of our own agent tokens. Anything else (an OAuth token, say) is undefined. */
export async function lookupToken(token: string, tokens: TokenStore): Promise<Grant | undefined> {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const raw = (await tokens.get(await hashToken(token))) as Partial<Grant> | null;
  if (!raw?.agent) return undefined;
  const scopes = (raw.scopes ?? []).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  return { agent: raw.agent.toLowerCase(), scopes, created: raw.created };
}
