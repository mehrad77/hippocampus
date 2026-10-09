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

/** The slice of a KV namespace the Worker uses (Workers KV, or `MemoryKV` in tests). */
export interface KVLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string }): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
}

/** A token store that can also mint, list and revoke (the dashboard's token page). */
export interface TokenAdmin extends TokenStore {
  /** The grant goes in as the value and as KV metadata, so `list` returns every grant in one call. */
  put(hash: string, value: string, opts: { metadata: Grant }): Promise<void>;
  delete(hash: string): Promise<void>;
  list(opts?: { cursor?: string }): ReturnType<KVLike["list"]>;
}

export const kvTokens = (kv: KVLike): TokenAdmin => ({
  get: (hash) => kv.get(hash, "json"),
  put: (hash, value, opts) => kv.put(hash, value, opts),
  delete: (hash) => kv.delete(hash),
  list: (opts) => kv.list(opts),
});

export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A token's id: the SHA-256 of the token, which is its KV key. */
export const TOKEN_ID = /^[0-9a-f]{64}$/;
export const isScope = (s: unknown): s is Scope => (SCOPES as readonly unknown[]).includes(s);

const TOKEN_PREFIX = "hippo_";

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256, hex. Also used for dashboard session ids, which are stored only hashed too. */
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
  return asGrant(await tokens.get(await hashToken(token)));
}

function asGrant(raw: unknown): Grant | undefined {
  const g = raw as Partial<Grant> | null | undefined;
  if (typeof g?.agent !== "string" || !g.agent) return undefined;
  const scopes = (Array.isArray(g.scopes) ? g.scopes : []).filter(isScope);
  return { agent: g.agent.toLowerCase(), scopes, created: g.created };
}

/** Store a new token for `grant`. Returns the token (show it once) and its id. */
export async function mintToken(admin: TokenAdmin, grant: Grant): Promise<{ token: string; id: string }> {
  const token = newToken();
  const id = await hashToken(token);
  await admin.put(id, JSON.stringify(grant), { metadata: grant });
  return { token, id };
}

/** Every agent token's grant. Keys written before grants were kept as metadata cost one read each. */
export async function listTokens(admin: TokenAdmin): Promise<(Grant & { id: string })[]> {
  const out: (Grant & { id: string })[] = [];
  let cursor: string | undefined;
  do {
    const page = await admin.list(cursor ? { cursor } : {});
    for (const key of page.keys) {
      if (!TOKEN_ID.test(key.name)) continue;
      const grant = asGrant(key.metadata) ?? asGrant(await admin.get(key.name));
      if (grant) out.push({ id: key.name, ...grant });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
