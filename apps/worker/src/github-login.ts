// Signing people in with GitHub (the hosted app's GitHub App, through its user authorization). No Workers APIs.

/** The GitHub App's registered callback: sign-ins and the app's install redirect both come back here. */
export const CALLBACK_PATH = "/oauth/github/callback";

/** What signing someone in with GitHub needs: the app's OAuth client and where GitHub is. */
export interface GitHubClient {
  github: { clientId: string; clientSecret: string; oauthUrl: string; apiUrl: string };
  fetch?: typeof fetch;
}

/** Where to send someone to sign in. No `scope`: signing in only needs the public profile, to learn who this is. */
export async function githubAuthorizeUrl(settings: GitHubClient, opts: { redirectUri: string; state: string; verifier: string }): Promise<string> {
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

/**
 * Trade a sign-in code for the user's GitHub token, for callers that need more than who it is
 * (the hosted app checks the user's installations with it). Don't keep it. A GitHub App's
 * install redirect carries a code that was never PKCE-bound, so `verifier` is optional.
 */
export async function githubToken(settings: GitHubClient, code: string, opts: { verifier?: string; redirectUri?: string } = {}): Promise<string | undefined> {
  const f = settings.fetch ?? fetch;
  const exchange = await f(`${settings.github.oauthUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: settings.github.clientId,
      client_secret: settings.github.clientSecret,
      code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier,
    }),
  });
  const { access_token } = (await exchange.json().catch(() => ({}))) as { access_token?: string };
  return exchange.ok && access_token ? access_token : undefined;
}

/** Whose GitHub token this is. */
export async function githubTokenUser(settings: GitHubClient, token: string): Promise<{ login: string; id: number } | undefined> {
  const f = settings.fetch ?? fetch;
  const res = await f(`${settings.github.apiUrl}/user`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "hippocampus" },
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
