import { HippoService } from "@hippocampus/core";
import { createEmbedder, embedConfigFromEnv, type AiLike } from "@hippocampus/embeddings";
import { HippoIndex, d1 } from "@hippocampus/index";
import { GitHubStore, MemoryBlobCache, SnapshotCache } from "@hippocampus/store-github";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { DurableObject } from "cloudflare:workers";
import { createApp, createMcpHandler, type McpOptions } from "./app.ts";
import type { TokenStore } from "./auth.ts";
import { createOAuthProvider, oauthSettings, type OAuthVars } from "./oauth.ts";
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
  /** OAuth grants and clients (used once HIPPO_PUBLIC_URL turns OAuth on). */
  OAUTH_KV: KVNamespace;
}

// Per isolate, shared by its requests. Both caches are keyed by immutable git ids.
const blobs = new MemoryBlobCache();
const snapshots = new SnapshotCache();
let index: Promise<HippoIndex> | undefined;
let handler: ((request: Request, ctx: ExecutionContext) => Promise<Response>) | undefined;

const github = (env: Env) =>
  new GitHubStore({ repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH || undefined, token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL || undefined, cache: blobs, snapshots });

function openIndex(env: Env): Promise<HippoIndex> {
  if (!index) {
    const embed = embedConfigFromEnv({ ...env });
    const opts = embed ? { embedder: createEmbedder(embed, { ai: env.AI }), minSimilarity: embed.minSimilarity } : {};
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

/** Agent tokens only, or OAuth (which also accepts agent tokens) once HIPPO_PUBLIC_URL is set. */
function createHandler(env: Env): (request: Request, ctx: ExecutionContext) => Promise<Response> {
  const tokens: TokenStore = { get: (hash) => env.TOKENS.get(hash, "json") };
  const mcp: McpOptions = {
    service: async () => {
      // A fresh store per request keeps its reads pinned to one commit while other requests move on.
      const scribe = env.SCRIBE.get(env.SCRIBE.idFromName(env.GITHUB_REPO));
      return new HippoService(new ScribeStore(github(env), scribe), { searcher: (await openIndex(env)).searcher });
    },
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  };
  const settings = oauthSettings(env);
  if (!settings) {
    const app = createApp({ ...mcp, tokens });
    return (request) => app(request);
  }
  const provider = createOAuthProvider(settings, { mcp: createMcpHandler(mcp), tokens });
  return (request, ctx) => provider.fetch(request, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return new Response("GITHUB_REPO and GITHUB_TOKEN must be configured\n", { status: 500 });
    handler ??= createHandler(env);
    return handler(request, ctx);
  },
} satisfies ExportedHandler<Env>;
