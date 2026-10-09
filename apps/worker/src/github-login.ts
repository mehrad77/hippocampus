// Signing the owner in with GitHub, shared by the connector OAuth flow and the dashboard. No Workers APIs.

export interface OAuthSettings {
  /** Public origin of this Worker, e.g. `https://hippocampus.you.workers.dev`. */
  publicUrl: string;
  github: { clientId: string; clientSecret: string; oauthUrl: string; apiUrl: string };
  /** GitHub logins allowed to connect apps: the vault's owners. */
  owners: Set<string>;
  fetch?: typeof fetch;
}

export interface OAuthVars {
  HIPPO_PUBLIC_URL?: string;
  HIPPO_OWNERS?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** Only for local development against a fake GitHub. */
  GITHUB_OAUTH_URL?: string;
  GITHUB_API_URL?: string;
}

/** The GitHub OAuth app's registered callback. GitHub also accepts subdirectories of it (the dashboard's). */
export const CALLBACK_PATH = "/oauth/github/callback";

const REQUIRED = ["HIPPO_PUBLIC_URL", "HIPPO_OWNERS", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"] as const;

/** The settings OAuth still needs, for telling the owner what to set. Empty when it's on. */
export function oauthMissing(env: OAuthVars): string[] {
  return REQUIRED.filter((k) => !env[k]?.trim());
}

/** OAuth settings, or undefined when OAuth is off (no HIPPO_PUBLIC_URL): then only agent tokens work. */
export function oauthSettings(env: OAuthVars): OAuthSettings | undefined {
  if (!env.HIPPO_PUBLIC_URL) return undefined;
  const missing = (["HIPPO_OWNERS", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"] as const).filter((k) => !env[k]);
  if (missing.length) throw new Error(`OAuth is on (HIPPO_PUBLIC_URL is set) but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} missing`);
  // Fail closed: no owners would mean nobody can connect, so refuse to start rather than guess.
  const owners = new Set(env.HIPPO_OWNERS!.split(/[\s,]+/).filter(Boolean).map((l) => l.toLowerCase()));
  if (!owners.size) throw new Error("HIPPO_OWNERS must list at least one GitHub login");
  return {
    publicUrl: new URL(env.HIPPO_PUBLIC_URL).origin,
    github: {
      clientId: env.GITHUB_OAUTH_CLIENT_ID!,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET!,
      oauthUrl: (env.GITHUB_OAUTH_URL || "https://github.com").replace(/\/$/, ""),
      apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, ""),
    },
    owners,
  };
}

/** Where to send the owner to sign in. No `scope`: signing in only needs the public profile, to learn who this is. */
export async function githubAuthorizeUrl(settings: OAuthSettings, opts: { redirectUri: string; state: string; verifier: string }): Promise<string> {
  const github = new URL(`${settings.github.oauthUrl}/login/oauth/authorize`);
  for (const [k, v] of Object.entries({
    client_id: settings.github.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    code_challenge: await s256(opts.verifier),
    code_challenge_method: "S256",
    allow_signup: "false",
  }))
    github.searchParams.set(k, v);
  return github.href;
}

/** Who signed in. The GitHub token is used for this one lookup and not kept. */
export async function githubUser(settings: OAuthSettings, code: string, verifier: string, redirectUri: string): Promise<{ login: string; id: number } | undefined> {
  const f = settings.fetch ?? fetch;
  const exchange = await f(`${settings.github.oauthUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: settings.github.clientId,
      client_secret: settings.github.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const { access_token } = (await exchange.json().catch(() => ({}))) as { access_token?: string };
  if (!exchange.ok || !access_token) return undefined;
  const res = await f(`${settings.github.apiUrl}/user`, {
    headers: { authorization: `Bearer ${access_token}`, accept: "application/vnd.github+json", "user-agent": "hippocampus" },
  });
  if (!res.ok) return undefined;
  const user = (await res.json()) as { login?: string; id?: number };
  return user.login && user.id ? { login: user.login, id: user.id } : undefined;
}

export const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** PKCE's S256 code challenge. */
export async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
