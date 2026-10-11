import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { DurableObject } from "cloudflare:workers";
import { hostedEmbedding } from "./embed-cap.ts";
import type { HostedEnv } from "./env.ts";
import { d1 } from "@hippocampus/index";
import { GitHubApp } from "./github-app.ts";
import { GitLabAccess } from "./gitlab.ts";
import { Registry } from "./registry.ts";
import { hostedSettings } from "./settings.ts";
import { HostedVault, type DashboardUser, type GitLabDeps, type HostDeps, type VaultGrant, type VaultMeta } from "./vault-runtime.ts";

const gitlabDeps = (gl: { url: string }, access: GitLabAccess): { gitlab: GitLabDeps } => ({
  gitlab: { apiUrl: access.client.apiUrl, webUrl: gl.url, tokenFor: (accountId) => access.tokenFor(accountId) },
});

export type { DashboardUser, VaultGrant, VaultMeta } from "./vault-runtime.ts";

/**
 * One vault's Durable Object, named by its vault id. The Worker authenticates every caller and
 * forwards here; this object is the vault's single writer, and holds its caches, index and sleep
 * run in its own SQLite. A thin shell: `HostedVault` (vault-runtime.ts) does the work.
 */
export class VaultHost extends DurableObject<HostedEnv> {
  private readonly host: HostedVault;

  constructor(ctx: DurableObjectState, env: HostedEnv) {
    super(ctx, env);
    let deps: HostDeps | undefined;
    // Built on first use: a missing secret then fails the calls that need it, not the object.
    this.host = new HostedVault(ctx.storage, () => {
      if (deps) return deps;
      const s = hostedSettings(env);
      deps = {
        app: new GitHubApp({ appId: s.appId, privateKey: s.privateKey, apiUrl: s.apiUrl }),
        apiUrl: s.apiUrl,
        webUrl: s.oauthUrl,
        // The object reads the account's sealed GitLab tokens from the registry, and refreshes them there.
        ...(s.gitlab ? gitlabDeps(s.gitlab, new GitLabAccess(s.gitlab, new Registry(d1(env.REGISTRY)))) : {}),
        embedding: hostedEmbedding(env, { ai: env.AI }),
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      };
      return deps;
    });
  }

  /** Serve this vault (idempotent). Also reconnects a disconnected vault, and forgets the token when the repo or installation changed. */
  configure(meta: VaultMeta): Promise<void> {
    return this.host.configure(meta);
  }

  /** MCP for an authenticated grant. 503 until configured and while disconnected. */
  mcp(request: Request, grant: VaultGrant): Promise<Response> {
    return this.host.mcp(request, grant);
  }

  /** The dashboard API (`/dashboard/api/...`) for the vault's owner, acting as the human. 503 until configured and while disconnected. */
  dashboard(request: Request, user: DashboardUser): Promise<Response> {
    return this.host.dashboard(request, user);
  }

  /** The party's agents, for the OAuth consent page. Throws `VAULT_NOT_CONFIGURED: …` or `VAULT_DISCONNECTED: …` when not serving. */
  party(): Promise<{ id: string; title: string }[]> {
    return this.host.party();
  }

  /** Seat an agent as the human; `via` is recorded in the commit (e.g. `@login`). */
  addParty(input: { id: string; title: string; lane?: string; authority?: string[] }, via: string): Promise<{ slug: string }> {
    return this.host.addParty(input, via);
  }

  /** Link (or unlink, with `null`) a person's logins to one of the vault's humans; `create` adds the human. */
  linkHuman(id: string, logins: { github?: string | null; gitlab?: string | null }, via: string, create?: { domains?: string[] }): Promise<{ changed: boolean }> {
    return this.host.linkHuman(id, logins, via, create);
  }

  /** Connections were revoked: free the agent names they held. */
  releaseClaims(credentials: string[]): Promise<number> {
    return this.host.releaseClaims(credentials);
  }

  /** Stop serving; storage stays until `destroy`. */
  disconnect(reason: string): Promise<void> {
    return this.host.disconnect(reason);
  }

  /** Forget everything: caches, index, tokens, sleep runs. */
  destroy(): Promise<void> {
    return this.host.destroy();
  }

  /** Finishes a sleep run whose lease passed, and garbage-collects cached blobs. */
  override alarm(): Promise<void> {
    return this.host.alarm();
  }
}
