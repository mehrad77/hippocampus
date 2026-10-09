import { oauthSettings, type OAuthSettings } from "../github-login.ts";

// Computed here rather than imported, so a broken PKCE in the code under test can't agree with itself.
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const s256 = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));

/** GitHub's OAuth endpoints, enough to sign someone in: checks the app's secret, PKCE and the redirect URI. */
export function fakeGitHubOAuth() {
  const codes = new Map<string, { challenge: string; redirectUri: string; login: string; id: number }>();
  const tokens = new Map<string, { login: string; id: number }>();
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.href === "https://github.test/login/oauth/access_token") {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      const grant = codes.get(body.code!);
      codes.delete(body.code!);
      const ok =
        grant &&
        body.client_id === "gh-client" &&
        body.client_secret === "gh-secret" &&
        body.redirect_uri === grant.redirectUri &&
        (await s256(body.code_verifier!)) === grant.challenge;
      if (!ok) return Response.json({ error: "bad_verification_code" });
      const token = `gho_${crypto.randomUUID()}`;
      tokens.set(token, { login: grant.login, id: grant.id });
      return Response.json({ access_token: token, token_type: "bearer", scope: "" });
    }
    if (url.href === "https://api.github.test/user") {
      const user = tokens.get(new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "");
      return user ? Response.json(user) : new Response("{}", { status: 401 });
    }
    return new Response("not found", { status: 404 });
  };
  /** The user signs in at GitHub, which redirects back with a code. */
  const signIn = (authorizeUrl: string, login: string) => {
    const u = new URL(authorizeUrl);
    const code = `gh-${crypto.randomUUID()}`;
    const redirectUri = u.searchParams.get("redirect_uri")!;
    codes.set(code, { challenge: u.searchParams.get("code_challenge")!, redirectUri, login, id: login.length * 1000 });
    return `${redirectUri}?code=${code}&state=${u.searchParams.get("state")}`;
  };
  return { fetch, signIn };
}

/** OAuth settings for `origin`, signing in against `fakeGitHubOAuth`. The owner is `player`. */
export function testOAuthSettings(origin: string, upstream: { fetch: unknown }, owners = "Player"): OAuthSettings {
  return {
    ...oauthSettings({
      HIPPO_PUBLIC_URL: origin,
      HIPPO_OWNERS: owners,
      GITHUB_OAUTH_CLIENT_ID: "gh-client",
      GITHUB_OAUTH_CLIENT_SECRET: "gh-secret",
      GITHUB_OAUTH_URL: "https://github.test",
      GITHUB_API_URL: "https://api.github.test",
    })!,
    fetch: upstream.fetch as typeof fetch,
  };
}

/** A browser: keeps cookies (by name, ignoring path and domain), doesn't follow redirects. */
export function browser(send: (request: Request) => Promise<Response>) {
  const jar = new Map<string, string>();
  const visit = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await send(new Request(url, { ...init, headers, redirect: "manual" }));
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [name, value] = pair!.split(/=(.*)/s) as [string, string];
      if (!value || attrs.some((a) => /max-age=0/i.test(a.trim()))) jar.delete(name.trim());
      else jar.set(name.trim(), value);
    }
    return res;
  };
  return Object.assign(visit, { jar });
}
