import { HippoService } from "@hippocampus/core";
import { createDashboardApi, serviceSource } from "@hippocampus/dashboard";
import { createEmbedder, embedConfigFromEnv, type AiLike } from "@hippocampus/embeddings";
import { HippoIndex, d1 } from "@hippocampus/index";
import { GitHubStore, MemoryBlobCache, SnapshotCache } from "@hippocampus/store-github";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { DurableObject } from "cloudflare:workers";
import { createApp, createMcpHandler, type McpOptions } from "./app.ts";
import { kvTokens, type TokenAdmin } from "./auth.ts";
import { DASHBOARD_API, createDashboardGate } from "./dashboard.ts";
import { oauthMissing } from "./github-login.ts";
import { createOAuthProvider, oauthSettings, type OAuthSettings, type OAuthVars } from "./oauth.ts";
import { remoteSetup } from "./remote-setup.ts";
import { ScribeQueue, ScribeStore, type CommitRequest, type CommitResult } from "./scribe.ts";

export interface Env extends OAuthVars {
  SCRIBE: DurableObjectNamespace<Scribe>;
  INDEX: D1Database;
  TOKENS: KVNamespace;
  /** `owner/name` of the private vault repo (a secret, to keep it out of the public config). */
  GITHUB_REPO: string;
  GITHUB_BRANCH?: string;
  /** Fine-grained token with Contents read and write on the vault repo (a secret). */
  GITHUB_TOKEN: string;
  /** Only for local development against a fake GitHub. */
  GITHUB_API_URL?: string;
  /** Workers AI, for semantic recall with HIPPO_EMBED_PROVIDER=workers-ai. Other HIPPO_EMBED_* settings work as in the CLI. */
  AI?: AiLike;
  HIPPO_EMBED_PROVIDER?: string;
  /** OAuth grants and clients (used once HIPPO_PUBLIC_URL turns OAuth on), and dashboard sessions. */
  OAUTH_KV: KVNamespace;
  /** The built dashboard UI (`assets` in wrangler.jsonc). */
  ASSETS: Fetcher;
}

// Per isolate, shared by its requests. Both caches are keyed by immutable git ids.
const blobs = new MemoryBlobCache();
const snapshots = new SnapshotCache();
let index: Promise<HippoIndex> | undefined;
let embedder: string | undefined;
let handler: ((request: Request, ctx: ExecutionContext) => Promise<Response>) | undefined;

const github = (env: Env) =>
  new GitHubStore({ repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH || undefined, token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL || undefined, cache: blobs, snapshots });

function openIndex(env: Env): Promise<HippoIndex> {
  if (!index) {
    const embed = embedConfigFromEnv({ ...env });
    const opts = embed ? { embedder: createEmbedder(embed, { ai: env.AI }), minSimilarity: embed.minSimilarity } : {};
    embedder = opts.embedder?.id;
    index = HippoIndex.open(d1(env.INDEX), opts).catch((err: unknown) => {
      index = undefined;
      throw err;
    });
  }
  return index;
}

/** The single writer for the vault repo: every commit made through the Worker goes through here, one at a time. */
export class Scribe extends DurableObject<Env> {
  private readonly queue: ScribeQueue;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.queue = new ScribeQueue(github(env));
  }

  commit(request: CommitRequest): Promise<CommitResult> {
    return this.queue.commit(request);
  }
}

/** Agent tokens only, or OAuth (which also accepts agent tokens) once HIPPO_PUBLIC_URL is set. Both serve the dashboard. */
function createHandler(env: Env): (request: Request, ctx: ExecutionContext) => Promise<Response> {
  const tokens = kvTokens(env.TOKENS);
  const mcp: McpOptions = {
    service: async () => {
      // A fresh store per request keeps its reads pinned to one commit while other requests move on.
      const scribe = env.SCRIBE.get(env.SCRIBE.idFromName(env.GITHUB_REPO));
      return new HippoService(new ScribeStore(github(env), scribe), { searcher: (await openIndex(env)).searcher });
    },
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  };
  const settings = oauthSettings(env);
  const dashboard = createDashboard(env, settings, mcp, tokens);
  if (!settings) {
    const app = createApp({ ...mcp, tokens, dashboard });
    return (request) => app(request);
  }
  const provider = createOAuthProvider(settings, { mcp: createMcpHandler(mcp), tokens, dashboard });
  return (request, ctx) => provider.fetch(request, env, ctx);
}

/** The dashboard: GitHub sign-in for the owners, its API over a fresh service per request (like MCP), and the built UI. */
function createDashboard(env: Env, settings: OAuthSettings | undefined, mcp: McpOptions, tokens: TokenAdmin) {
  const branch = env.GITHUB_BRANCH || "main";
  const missing = oauthMissing(env);
  const setup = remoteSetup({
    settings,
    oauthMissing: missing,
    tokens,
    repo: { name: env.GITHUB_REPO, branch, info: () => github(env).info() },
    service: mcp.service,
    index: async () => {
      const idx = await openIndex(env);
      const [row] = await idx.db.all<{ n: number }>("SELECT count(*) AS n FROM docs WHERE kind = 'entity'");
      return { entities: row?.n, embedder, lastError: idx.lastEmbedError?.message };
    },
  });
  const gate = createDashboardGate({
    settings,
    missing,
    kv: env.OAUTH_KV,
    assets: env.ASSETS,
    api: (guard) =>
      createDashboardApi({
        basePath: DASHBOARD_API,
        source: async () => serviceSource(await mcp.service(), { mode: "worker", vault: { kind: "github", repo: env.GITHUB_REPO, branch } }),
        setup,
        guard,
      }),
  });
  return (request: Request) => gate.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return new Response("GITHUB_REPO and GITHUB_TOKEN must be configured\n", { status: 500 });
    handler ??= createHandler(env);
    return handler(request, ctx);
  },
} satisfies ExportedHandler<Env>;
