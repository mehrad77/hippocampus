import { SCOPES, type Scope } from "@hippocampus/mcp";

/** The slice of a KV namespace the Worker uses (Workers KV, or `MemoryKV` in tests). */
export interface KVLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string }): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
}

/** A key's id: the SHA-256 of the key. */
export const TOKEN_ID = /^[0-9a-f]{64}$/;
export const isScope = (s: unknown): s is Scope => (SCOPES as readonly unknown[]).includes(s);

const TOKEN_PREFIX = "hippo_";

/** A new vault key: `hippo_` and 32 random bytes. Shown once; only its hash is kept. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256, hex. Also used for session ids, which are stored only hashed too. */
export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
