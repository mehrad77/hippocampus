import type { AiLike } from "@hippocampus/embeddings";
import type { RateLimiter } from "./limits.ts";
import type { VaultHost } from "./vault-host.ts";

/** The hosted Worker's bindings and vars (wrangler.jsonc), shared by the Worker entry and each vault's Durable Object. */
export interface HostedEnv {
  VAULT_HOST: DurableObjectNamespace<VaultHost>;
  REGISTRY: D1Database;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  RL_SIGNIN?: RateLimiter;
  RL_API?: RateLimiter;
  RL_MCP?: RateLimiter;
  RL_REGISTER?: RateLimiter;
  /** Workers AI, for semantic recall with HIPPO_EMBED_PROVIDER=workers-ai. */
  AI?: AiLike;
  HIPPO_PUBLIC_URL: string;
  HIPPO_ADMINS: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_WEBHOOK_SECRET: string;
  /** Only for local development against a fake GitHub. */
  GITHUB_API_URL?: string;
  GITHUB_OAUTH_URL?: string;
  HIPPO_EMBED_PROVIDER?: string;
  HIPPO_EMBED_MODEL?: string;
  HIPPO_EMBED_BASE_URL?: string;
  HIPPO_EMBED_API_KEY?: string;
  /** Texts embedded per vault per UTC day; past it, search falls back to keywords until tomorrow. */
  HIPPO_EMBED_DAILY_LIMIT?: string;
}
