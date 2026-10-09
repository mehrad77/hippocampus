import { base64url } from "../github-login.ts";

// The hosted app's GitHub App: its JWT, installation tokens narrowed to one repo, and the few
// App and user endpoints onboarding needs. WebCrypto only, so it runs in Workers and Node alike.

export class GitHubAppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubAppError";
  }
}

const encoder = new TextEncoder();
/** WebCrypto's key type, spelled so it works under both Node's and Workers' type definitions. */
type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const PKCS1 = /-----BEGIN RSA PRIVATE KEY-----/;
const PKCS8 = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/;

/**
 * The app's private key for signing. GitHub hands out PKCS#1 keys, which WebCrypto can't import,
 * so those are refused with the one command that converts them. Secrets pasted with literal `\n`
 * escapes (a common way to fit a PEM in one line) are accepted too.
 */
export async function importAppKey(pem: string): Promise<SigningKey> {
  const text = pem.replace(/\\n/g, "\n").trim();
  if (PKCS1.test(text))
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is a PKCS#1 key (BEGIN RSA PRIVATE KEY), which WebCrypto can't read. Convert it to PKCS#8 and set the secret again: openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem",
    );
  const body = PKCS8.exec(text)?.[1];
  if (!body) throw new Error("GITHUB_APP_PRIVATE_KEY must be a PEM private key (-----BEGIN PRIVATE KEY-----)");
  const der = Uint8Array.from(atob(body.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** The app's JWT (RS256), for `/app/*` calls. Backdated a minute for clock drift; GitHub allows ten minutes, this asks nine. */
export async function appJwt(opts: { appId: string; privateKeyPem: string | SigningKey; now?: Date }): Promise<string> {
  const key = typeof opts.privateKeyPem === "string" ? await importAppKey(opts.privateKeyPem) : opts.privateKeyPem;
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const part = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 9 * 60, iss: opts.appId })}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned)));
  return `${unsigned}.${base64url(signature)}`;
}

export type Access = "read" | "write";
/** Like `{ contents: "write", workflows: "write", metadata: "read" }`. */
export type Permissions = Record<string, Access>;

export interface Narrowing {
  repositoryIds?: number[];
  permissions?: Permissions;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export interface Installation {
  id: number;
  account: { id: number; login: string; type: string };
  permissions: Record<string, string>;
}

export interface InstallationRepo {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface GitHubAppOptions {
  appId: string;
  /** PKCS#8 PEM. */
  privateKey: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const PER_PAGE = 100;
const MAX_PAGES = 10;
/** Installation tokens last an hour; one this close to expiring is replaced rather than handed out. */
const TOKEN_MARGIN_MS = 5 * 60_000;

interface RepoJson {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
}

const toRepo = (r: RepoJson): InstallationRepo => ({ id: r.id, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch });

export class GitHubApp {
  readonly apiUrl: string;
  readonly fetch: typeof fetch;
  private key?: Promise<SigningKey>;
  private cachedJwt?: { value: string; until: number };

  constructor(private readonly opts: GitHubAppOptions) {
    this.apiUrl = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** The app's JWT, reused for most of its nine minutes. */
  async jwt(): Promise<string> {
    const now = this.now().getTime();
    if (this.cachedJwt && this.cachedJwt.until > now) return this.cachedJwt.value;
    this.key ??= importAppKey(this.opts.privateKey).catch((err: unknown) => {
      this.key = undefined;
      throw err;
    });
    const value = await appJwt({ appId: this.opts.appId, privateKeyPem: await this.key, now: new Date(now) });
    this.cachedJwt = { value, until: now + 7 * 60_000 };
    return value;
  }

  /**
   * A token for one installation, narrowed to the repos and permissions given: a vault's token
   * reaches its own repo and nothing else the person installed the app on.
   */
  async installationToken(installationId: number, narrow: Narrowing = {}): Promise<InstallationToken> {
    const body = {
      ...(narrow.repositoryIds ? { repository_ids: narrow.repositoryIds } : {}),
      ...(narrow.permissions ? { permissions: narrow.permissions } : {}),
    };
    const res = await this.call("POST", `/app/installations/${installationId}/access_tokens`, await this.jwt(), body);
    if (res.status === 404) throw new GitHubAppError(404, `The GitHub App isn't installed there anymore (installation ${installationId}).`);
    if (res.status === 422) throw new GitHubAppError(422, `GitHub won't grant that token: ${await message(res)}`);
    const json = (await ok(res, APP_AUTH)) as { token: string; expires_at: string };
    return { token: json.token, expiresAt: new Date(json.expires_at) };
  }

  /** A token function for `GitHubStore`: mints on first use, reuses until near expiry, mints again when asked to refresh. */
  tokenSource(installationId: number, narrow: Narrowing = {}): (opts?: { refresh?: boolean }) => Promise<string> {
    let current: InstallationToken | undefined;
    return async (opts) => {
      if (!current || opts?.refresh || current.expiresAt.getTime() - TOKEN_MARGIN_MS <= this.now().getTime()) current = await this.installationToken(installationId, narrow);
      return current.token;
    };
  }

  /** Uninstall the app (account deletion). Already gone counts as done. */
  async deleteInstallation(installationId: number): Promise<void> {
    const res = await this.call("DELETE", `/app/installations/${installationId}`, await this.jwt());
    if (res.status === 404) return;
    await ok(res, APP_AUTH);
  }

  /** The repos an installation token reaches. */
  async installationRepositories(installationToken: string): Promise<InstallationRepo[]> {
    return (await this.pages("/installation/repositories", installationToken, (b) => (b as { repositories?: RepoJson[] }).repositories ?? [])).map(toRepo);
  }

  /** The app's installations a signed-in user can see (with a user token from the app's sign-in). */
  async userInstallations(userToken: string): Promise<Installation[]> {
    return this.pages("/user/installations", userToken, (b) => (b as { installations?: Installation[] }).installations ?? []);
  }

  /** The repos of one installation, as a signed-in user sees them. */
  async installationRepos(userToken: string, installationId: number): Promise<InstallationRepo[]> {
    const repos = await this.pages(`/user/installations/${installationId}/repositories`, userToken, (b) => (b as { repositories?: RepoJson[] }).repositories ?? []);
    return repos.map(toRepo);
  }

  private async pages<T>(path: string, token: string, pick: (body: unknown) => T[]): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = pick(await ok(await this.call("GET", `${path}?per_page=${PER_PAGE}&page=${page}`, token)));
      out.push(...items);
      if (items.length < PER_PAGE) break;
    }
    return out;
  }

  private call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
    return this.fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "hippocampus",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

async function message(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text;
  }
}

const APP_AUTH = " Check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.";

async function ok(res: Response, authHint = ""): Promise<unknown> {
  if (res.status === 401) throw new GitHubAppError(401, `GitHub refused the credentials (401): ${await message(res)}.${authHint}`);
  if (!res.ok) throw new GitHubAppError(res.status, `GitHub answered ${res.status}: ${await message(res)}`);
  return res.status === 204 ? undefined : res.json();
}

/** Whether a webhook body carries GitHub's `X-Hub-Signature-256` for `secret`. WebCrypto's verify is constant-time. */
export async function verifyWebhook(secret: string, rawBody: string, signatureHeader: string | null | undefined): Promise<boolean> {
  const hex = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader?.trim() ?? "")?.[1];
  if (!secret || !hex) return false;
  const signature = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(rawBody));
}
