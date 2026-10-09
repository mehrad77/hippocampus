// A pretend GitHub for running the hosted Worker offline with `wrangler dev`, so it never touches a
// real account or vault: a GitHub App, two users with an empty private repo each (`player`, the
// admin, and `game-master`, to check one account never sees another's vault), and the app's sign-in
// and install pages, which go straight through as `--login`.
//
//   pnpm --filter @hippocampus/worker dev:github --dev-vars > apps/worker/.dev.vars    # once: settings for this fake
//   pnpm --filter @hippocampus/worker dev:github [--port 8786] [--login player] [--choose] [--public-url http://127.0.0.1:8787]
//   pnpm --filter @hippocampus/worker dev                                              # in another terminal
//
// `--choose` asks which user to be at each sign-in and install instead (use two browser profiles).
// App JWTs aren't checked, so any PKCS#8 key works as GITHUB_APP_PRIVATE_KEY. Nothing is saved:
// restarting the fake empties the repos, while the Worker's local registry keeps its vaults.
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { FakeGitHub } from "@hippocampus/store-github/testing";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const port = Number(flag("--port", "8786"));
const publicUrl = flag("--public-url", "http://127.0.0.1:8787").replace(/\/$/, "");
const choose = args.includes("--choose");
const USERS = [
  { login: "player", id: 4242, repo: 9001 },
  { login: "game-master", id: 7, repo: 9002 },
];
const login = flag("--login", "player");
if (!USERS.some((u) => u.login === login)) throw new Error(`--login: one of ${USERS.map((u) => u.login).join(", ")}`);
const APP = { id: "1", slug: "hippocampus-dev", clientId: "Iv1.fake-hippocampus", clientSecret: "fake-client-secret", webhookSecret: "fake-webhook-secret" };
const self = `http://127.0.0.1:${port}`;

if (args.includes("--dev-vars")) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const lines = [
    "# For `wrangler dev` against scripts/fake-github.ts only: none of these work anywhere else.",
    `HIPPO_PUBLIC_URL=${publicUrl}`,
    `HIPPO_ADMINS=${USERS[0]!.id}`,
    `GITHUB_APP_ID=${APP.id}`,
    `GITHUB_APP_SLUG=${APP.slug}`,
    `GITHUB_APP_CLIENT_ID=${APP.clientId}`,
    `GITHUB_APP_CLIENT_SECRET=${APP.clientSecret}`,
    `GITHUB_APP_WEBHOOK_SECRET=${APP.webhookSecret}`,
    `GITHUB_APP_PRIVATE_KEY="${privateKey.trim().replace(/\n/g, "\\n")}"`,
    `GITHUB_API_URL=${self}`,
    `GITHUB_OAUTH_URL=${self}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(0);
}

const gh = await FakeGitHub.create({}, { repo: `${USERS[0]!.login}/vault`, empty: true, id: USERS[0]!.repo });
for (const u of USERS.slice(1)) await gh.addRepo({ fullName: `${u.login}/vault`, id: u.repo, empty: true });
for (const u of USERS) gh.addUser({ login: u.login, id: u.id });
gh.requireAuth = true;

/** Codes GitHub would hand back, by code: who signed in, and the PKCE challenge and redirect it was bound to. */
const codes = new Map<string, { login: string; challenge?: string; redirectUri?: string }>();
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body: string) => new Response(`<!doctype html><meta charset="utf-8"><title>Fake GitHub</title><body style="font:16px system-ui;margin:3rem">${body}`, { headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

/** Who's signing in: `--login`, or with `--choose`, whoever was picked (a page to pick otherwise). */
function who(url: URL): string | Response {
  if (!choose) return login;
  const picked = url.searchParams.get("as");
  if (picked && USERS.some((u) => u.login === picked)) return picked;
  const links = USERS.map((u) => {
    const next = new URL(url);
    next.searchParams.set("as", u.login);
    return `<p><a href="${escape(next.pathname + next.search)}">Continue as @${escape(u.login)}</a></p>`;
  });
  return html(`<h1>Fake GitHub</h1>${links.join("")}`);
}

async function handle(url: URL, method: string, headers: Headers, body: string): Promise<Response> {
  if (url.pathname === "/login/oauth/authorize") {
    // Signs in at once, the way GitHub does for an app you've already authorized.
    const user = who(url);
    if (user instanceof Response) return user;
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const code = randomUUID();
    codes.set(code, { login: user, challenge: url.searchParams.get("code_challenge") ?? undefined, redirectUri });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    return redirect(back.href);
  }
  if (url.pathname === "/login/oauth/access_token" && method === "POST") {
    const params = (() => {
      try {
        return JSON.parse(body || "{}") as Record<string, string | undefined>;
      } catch {
        return Object.fromEntries(new URLSearchParams(body));
      }
    })();
    const grant = codes.get(params.code ?? "");
    codes.delete(params.code ?? "");
    const ok =
      grant &&
      params.client_id === APP.clientId &&
      (!grant.redirectUri || params.redirect_uri === grant.redirectUri) &&
      (!grant.challenge || s256(params.code_verifier ?? "") === grant.challenge);
    if (!ok) return Response.json({ error: "bad_verification_code" });
    const token = `ghu_fake${randomUUID().replace(/-/g, "")}`;
    gh.tokens.set(token, { user: grant.login });
    return Response.json({ access_token: token, token_type: "bearer", scope: "" });
  }
  const install = /^\/apps\/([^/]+)\/installations\/new$/.exec(url.pathname);
  if (install) {
    // Installed on the user's own `vault` repo, then back to the app's callback with a code, as with
    // "Request user authorization (OAuth) during installation" on.
    const user = who(url);
    if (user instanceof Response) return user;
    const account = USERS.find((u) => u.login === user)!;
    const existing = [...gh.installations.values()].find((i) => i.account.id === account.id);
    const installation = existing ?? gh.addInstallation({ account: { id: account.id, login: account.login, type: "User" }, repos: [`${account.login}/vault`] });
    const code = randomUUID();
    codes.set(code, { login: user });
    return redirect(`${publicUrl}/oauth/github/callback?${new URLSearchParams({ installation_id: String(installation.id), setup_action: existing ? "update" : "install", code })}`);
  }
  if (url.pathname === "/new") return html(`<h1>Fake GitHub</h1><p>Each user already has an empty private repo: ${USERS.map((u) => `<code>${u.login}/vault</code>`).join(", ")}.</p>`);
  return gh.fetch(url, { method, headers, body: body || undefined });
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", self);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  try {
    const response = await handle(url, req.method ?? "GET", headers, Buffer.concat(chunks).toString("utf8"));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`fake GitHub: ${(err as Error).message}\n`);
  }
});

server.listen(port, "127.0.0.1", () =>
  process.stderr.write(
    `fake GitHub on ${self}: app ${APP.slug}, users ${USERS.map((u) => `${u.login} (${u.id})`).join(", ")}, ${choose ? "asking who signs in" : `signing in as ${login}`}; the Worker is at ${publicUrl}\n`,
  ),
);
