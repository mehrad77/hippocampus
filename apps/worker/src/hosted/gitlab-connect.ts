import { securityHeaders } from "@hippocampus/dashboard";
import { base64url } from "../github-login.ts";
import { page } from "../pages.ts";
import { GITLAB_CALLBACK_PATH, GitLabAuthError, type GitLabAccess } from "./gitlab.ts";
import { SETUP_REPO, type SessionKV, type Sessions } from "./session.ts";

// Connecting GitLab, from the setup page: send the person to GitLab to authorize the Hippocampus
// application, and take them back to pick their project. The person is already signed in (with
// GitHub); the state ties the callback to that account, and the session cookie to that browser.

const STATE_TTL = 600;
const stateKey = (state: string) => `hosted:gitlab:${state}`;
const randomId = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

interface PendingConnect {
  accountId: number;
  verifier: string;
}

export interface GitLabConnectDeps {
  publicUrl: string;
  kv: SessionKV;
  access: GitLabAccess;
  sessions: Pick<Sessions, "current">;
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...securityHeaders() } });
const fail = (status: number, title: string, body: string) => page(status, title, `${body}<p><a href="/dashboard/setup/">Back to setup</a></p>`);

export function gitlabConnect(deps: GitLabConnectDeps) {
  const { publicUrl, kv, access, sessions } = deps;
  const redirectUri = `${publicUrl}${GITLAB_CALLBACK_PATH}`;

  return {
    /** `GET /dashboard/setup/gitlab/connect`: on to GitLab's consent page. */
    async start(request: Request): Promise<Response> {
      const signedIn = await sessions.current(request);
      if (!signedIn) return redirect(`/dashboard/auth/login?return=${encodeURIComponent("/dashboard/setup/")}`);
      if (signedIn.account.status !== "approved") return fail(403, "Not approved yet", "<p>An admin has to approve your account before you can connect GitLab.</p>");
      const state = randomId();
      const verifier = randomId();
      const pending: PendingConnect = { accountId: signedIn.account.id, verifier };
      await kv.put(stateKey(state), JSON.stringify(pending), { expirationTtl: STATE_TTL });
      return redirect(await access.client.authorizeUrl({ redirectUri, state, verifier }));
    },

    /** `GET /oauth/gitlab/callback`: GitLab sends the person back with a code. */
    async callback(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const state = url.searchParams.get("state") ?? "";
      const pending = state ? ((await kv.get(stateKey(state), "json")) as PendingConnect | null) : null;
      if (state) await kv.delete(stateKey(state));
      if (!pending?.verifier) return fail(400, "This GitLab connection can't continue", "<p>The link expired or was already used. Start again from the setup page.</p>");
      const signedIn = await sessions.current(request);
      if (!signedIn || signedIn.account.id !== pending.accountId) return fail(403, "Different account", "<p>This connection was started by another account, or you're signed out. Sign in and start again from the setup page.</p>");
      const code = url.searchParams.get("code");
      if (!code) return fail(400, "GitLab connection cancelled", "<p>GitLab didn't authorize Hippocampus.</p>");
      try {
        const tokens = await access.client.exchange(code, { redirectUri, verifier: pending.verifier });
        if (!tokens) return fail(400, "GitLab connection failed", "<p>GitLab refused the authorization. Start again from the setup page.</p>");
        const user = await access.client.user(tokens.access);
        await access.connect(signedIn.account.id, tokens, user);
      } catch (err) {
        if (err instanceof GitLabAuthError) return fail(400, "GitLab connection failed", "<p>GitLab refused the authorization. Start again from the setup page.</p>");
        return fail(502, "GitLab didn't answer", "<p>Try connecting again in a minute.</p>");
      }
      return redirect(SETUP_REPO);
    },
  };
}
