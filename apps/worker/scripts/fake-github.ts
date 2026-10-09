// A pretend GitHub for `wrangler dev`, so the Worker and its dashboard run offline and never touch a real
// vault: the example campaign as `player/vault`, and an OAuth app that signs you in without asking.
//   pnpm --filter @hippocampus/worker exec tsx scripts/fake-github.ts [--port 8786] [--login player]
// Then in .dev.vars: GITHUB_REPO=player/vault, GITHUB_TOKEN=fake, GITHUB_API_URL=http://127.0.0.1:8786,
// and for sign-in GITHUB_OAUTH_URL=http://127.0.0.1:8786, HIPPO_PUBLIC_URL=http://127.0.0.1:8787,
// HIPPO_OWNERS=player, GITHUB_OAUTH_CLIENT_ID=fake and GITHUB_OAUTH_CLIENT_SECRET=fake.
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGitHub } from "@hippocampus/store-github/testing";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const port = Number(flag("--port", "8786"));
const login = flag("--login", "player");
const seed = fileURLToPath(new URL("../../../seeds/example-relocation", import.meta.url));

async function files(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path).split("\\").join("/")] = await readFile(path, "utf8");
  }
  return out;
}

const gh = await FakeGitHub.create(await files(seed), { repo: "player/vault" });
const codes = new Map<string, { challenge: string; redirectUri: string }>();
const tokens = new Set<string>();
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const send = async (response: Response) => {
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };

  if (url.pathname === "/login/oauth/authorize") {
    // Signs in at once, as `--login`, the way GitHub does for an app you've already authorized.
    const code = randomUUID();
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirectUri });
    return send(new Response(null, { status: 302, headers: { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` } }));
  }
  if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
    const { code, code_verifier, redirect_uri } = JSON.parse(body || "{}") as Record<string, string>;
    const grant = codes.get(code ?? "");
    codes.delete(code ?? "");
    if (!grant || grant.redirectUri !== redirect_uri || s256(code_verifier ?? "") !== grant.challenge) return send(Response.json({ error: "bad_verification_code" }));
    const token = `gho_${randomUUID()}`;
    tokens.add(token);
    return send(Response.json({ access_token: token, token_type: "bearer", scope: "" }));
  }
  if (url.pathname === "/user") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    return send(tokens.has(token) ? Response.json({ login, id: 1 }) : Response.json({ message: "Bad credentials" }, { status: 401 }));
  }
  return send(await gh.fetch(url, { method: req.method, body: body || undefined }));
});

server.listen(port, "127.0.0.1", () => process.stderr.write(`fake GitHub with ${gh.repo} on http://127.0.0.1:${port} (signs in as ${login})\n`));
