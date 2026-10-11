import { base64url } from "../github-login.ts";
import type { Registry } from "./registry.ts";
import type { GitLabSettings } from "./settings.ts";
import { open, seal } from "./token-box.ts";

// Connecting a person's GitLab account (OAuth, scope `api`) so their vault can live in one of their
// GitLab projects. Unlike the GitHub App, GitLab has no per-repo installation tokens: the token
// reaches everything the person can. It is sealed in the registry, used only to read and write the
// vault project, and revoked on account deletion.

/** GitLab's registered redirect: where it sends the person back after they authorize. */
export const GITLAB_CALLBACK_PATH = "/oauth/gitlab/callback";
export const GITLAB_CONNECT_PATH = "/dashboard/setup/gitlab/connect";

/** Access tokens last two hours; one this close to expiring is refreshed first. */
const MARGIN_MS = 5 * 60_000;
const SCOPE = "api";

/** Why a GitLab call failed in a way the person can act on: not connected, or the connection was revoked or expired. */
export class GitLabAuthError extends Error {
  constructor(
    message: string,
    readonly reason: "not_connected" | "revoked",
  ) {
    super(message);
    this.name = "GitLabAuthError";
  }
}

/** GitLab answered, but not with what we asked for (404: the project is gone or the person lost access). */
export class GitLabApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

export interface GitLabTokens {
  access: string;
  refresh: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface GitLabUser {
  id: number;
  username: string;
}

export interface GitLabProject {
  id: number;
  fullName: string;
  visibility: "private" | "internal" | "public";
  defaultBranch: string;
  empty: boolean;
  namespace: { id: number; kind: "user" | "group"; fullPath: string };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  created_at?: number;
}

const s256 = async (v: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));

export class GitLabClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(
    readonly settings: GitLabSettings,
    opts: { fetch?: typeof fetch; now?: () => Date } = {},
  ) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? (() => new Date());
  }

  get apiUrl(): string {
    return `${this.settings.url}/api/v4`;
  }

  async authorizeUrl(o: { redirectUri: string; state: string; verifier: string }): Promise<string> {
    const u = new URL(`${this.settings.url}/oauth/authorize`);
    for (const [k, v] of Object.entries({
      client_id: this.settings.clientId,
      redirect_uri: o.redirectUri,
      response_type: "code",
      state: o.state,
      scope: SCOPE,
      code_challenge: await s256(o.verifier),
      code_challenge_method: "S256",
    }))
      u.searchParams.set(k, v);
    return u.href;
  }

  /** Trade the authorization code for tokens; undefined when GitLab refuses it. */
  exchange(code: string, o: { redirectUri: string; verifier: string }): Promise<GitLabTokens | undefined> {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: o.redirectUri, code_verifier: o.verifier });
  }

  /** New tokens for a refresh token (GitLab rotates it); undefined when GitLab refuses it. Throws on a GitLab outage. */
  refresh(refreshToken: string): Promise<GitLabTokens | undefined> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async token(grant: Record<string, string>): Promise<GitLabTokens | undefined> {
    const res = await this.fetch(`${this.settings.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: this.settings.clientId, client_secret: this.settings.clientSecret, ...grant }),
    });
    if (res.status >= 500) throw new Error(`GitLab token endpoint failed (${res.status})`);
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !body.access_token || !body.refresh_token) return undefined;
    // `created_at` is when GitLab issued it; the clock here may differ, so count from now.
    return { access: body.access_token, refresh: body.refresh_token, expiresAt: this.now().getTime() + (body.expires_in ?? 7200) * 1000 };
  }

  /** Best effort: the tokens are forgotten either way. */
  async revoke(token: string): Promise<void> {
    await this.fetch(`${this.settings.url}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.settings.clientId, client_secret: this.settings.clientSecret, token }),
    }).catch(() => undefined);
  }

  private async api<T>(token: string, path: string): Promise<T> {
    const res = await this.fetch(`${this.apiUrl}/${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "hippocampus" } });
    if (res.status === 401) throw new GitLabAuthError("GitLab rejected the connection (401).", "revoked");
    if (!res.ok) throw new GitLabApiError(`GitLab ${path.split("?")[0]} failed (${res.status})`, res.status);
    return (await res.json()) as T;
  }

  user(token: string): Promise<GitLabUser> {
    return this.api<GitLabUser>(token, "user");
  }

  /** Projects the person can push to (Developer or better) and that sit in their personal namespace, most recent first. */
  async projects(token: string, user: GitLabUser): Promise<GitLabProject[]> {
    const rows = await this.api<RawProject[]>(token, "projects?membership=true&min_access_level=30&order_by=last_activity_at&per_page=100");
    return rows.map(toProject).filter((p) => p.namespace.kind === "user" && p.namespace.fullPath.toLowerCase() === user.username.toLowerCase());
  }

  async project(token: string, id: number): Promise<GitLabProject> {
    return toProject(await this.api<RawProject>(token, `projects/${id}`));
  }
}

interface RawProject {
  id: number;
  path_with_namespace: string;
  visibility: GitLabProject["visibility"];
  default_branch?: string | null;
  empty_repo?: boolean;
  namespace: { id: number; kind: "user" | "group"; full_path: string };
}

const toProject = (p: RawProject): GitLabProject => ({
  id: p.id,
  fullName: p.path_with_namespace,
  visibility: p.visibility,
  defaultBranch: p.default_branch ?? "main",
  empty: !!p.empty_repo,
  namespace: { id: p.namespace.id, kind: p.namespace.kind, fullPath: p.namespace.full_path },
});

/** The sealed-token side: connect an account, and hand out tokens that refresh themselves. */
export class GitLabAccess {
  readonly client: GitLabClient;
  /** One refresh at a time per account in this isolate; across isolates the registry's compare-and-set decides. */
  private readonly refreshing = new Map<number, Promise<string>>();

  constructor(
    readonly settings: GitLabSettings,
    private readonly registry: Registry,
    private readonly opts: { fetch?: typeof fetch; now?: () => Date } = {},
  ) {
    this.client = new GitLabClient(settings, opts);
  }

  get fetch(): typeof fetch | undefined {
    return this.opts.fetch;
  }

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  /** Save a fresh connection for the account (after the OAuth callback). */
  async connect(accountId: number, tokens: GitLabTokens, user: GitLabUser): Promise<void> {
    await this.registry.saveGitLabCredential({ accountId, gitlabUserId: user.id, gitlabLogin: user.username, secret: await seal(this.settings.tokenKey, aad(accountId), tokens) });
  }

  async login(accountId: number): Promise<string | undefined> {
    return (await this.registry.gitlabCredential(accountId))?.gitlabLogin;
  }

  /** A token function for `GitLabStore` and the API calls: refreshes before expiry, and again on request after a 401. */
  tokenFor(accountId: number): (opts?: { refresh?: boolean }) => Promise<string> {
    return async (opts) => {
      const cred = await this.registry.gitlabCredential(accountId);
      if (!cred) throw new GitLabAuthError("GitLab isn't connected: connect it again from the setup page.", "not_connected");
      const tokens = await open<GitLabTokens>(this.settings.tokenKey, aad(accountId), cred.secret);
      if (!tokens) throw new GitLabAuthError("The stored GitLab connection can't be read: connect GitLab again.", "revoked");
      if (!opts?.refresh && tokens.expiresAt - MARGIN_MS > this.now()) return tokens.access;
      let pending = this.refreshing.get(accountId);
      if (!pending) {
        pending = this.rotate(accountId, cred.version, tokens).finally(() => this.refreshing.delete(accountId));
        this.refreshing.set(accountId, pending);
      }
      return pending;
    };
  }

  private async rotate(accountId: number, version: number, old: GitLabTokens): Promise<string> {
    const fresh = await this.client.refresh(old.refresh);
    if (fresh) {
      if (await this.registry.rotateGitLabSecret(accountId, version, await seal(this.settings.tokenKey, aad(accountId), fresh))) return fresh.access;
    }
    // Refused, or another isolate refreshed first (its token works; ours, now spent, doesn't): look again.
    const cred = await this.registry.gitlabCredential(accountId);
    const tokens = cred && cred.version !== version ? await open<GitLabTokens>(this.settings.tokenKey, aad(accountId), cred.secret) : undefined;
    if (tokens) return tokens.access;
    throw new GitLabAuthError("GitLab no longer accepts the connection: connect GitLab again from the setup page.", "revoked");
  }

  /** Revoke at GitLab and forget the connection. */
  async disconnect(accountId: number): Promise<void> {
    const cred = await this.registry.gitlabCredential(accountId);
    const tokens = cred && (await open<GitLabTokens>(this.settings.tokenKey, aad(accountId), cred.secret));
    if (tokens) {
      await this.client.revoke(tokens.access);
      await this.client.revoke(tokens.refresh);
    }
    await this.registry.deleteGitLabCredential(accountId);
  }
}

const aad = (accountId: number) => `gitlab:${accountId}`;
