import type { HippoService, Overview } from "@hippocampus/core";
import { HttpError, type AgentConnect, type MintedToken, type RemoteSetupStatus, type SetupItem, type SetupPort, type Snippet, type TokenInfo } from "@hippocampus/dashboard";
import { SCOPES } from "@hippocampus/mcp";
import { AGENT_ID, TOKEN_ID, isScope, listTokens, mintToken, type TokenAdmin } from "./auth.ts";
import type { OAuthSettings } from "./github-login.ts";

export interface RemoteSetupOptions {
  /** OAuth settings when it's on; the public URL in every snippet comes from them. */
  settings?: OAuthSettings;
  /** What OAuth still needs (`oauthMissing`), when it's off. */
  oauthMissing?: string[];
  tokens: TokenAdmin;
  repo: { name: string; branch: string; info?: () => Promise<{ private: boolean; head: string }> };
  /** A service for one request: the party, and agents writing without a party note. */
  service: () => HippoService | Promise<HippoService>;
  /** Cheap index health, when there is an index. */
  index?: () => Promise<RemoteSetupStatus["index"]>;
  now?: () => Date;
}

const PLACEHOLDER_URL = "https://hippocampus.<your-subdomain>.workers.dev";

/**
 * Session Zero on the Worker. Nothing here touches Cloudflare's config (secrets and bindings are
 * set with wrangler), so it reports health, hands out connect snippets, and manages agent tokens.
 */
export function remoteSetup(opts: RemoteSetupOptions): SetupPort {
  const now = opts.now ?? (() => new Date());
  const publicUrl = opts.settings?.publicUrl;

  return {
    kind: "remote",

    async status(): Promise<RemoteSetupStatus> {
      const [vault, tokens, repo, index] = await Promise.all([
        Promise.resolve()
          .then(async () => ({ overview: await (await opts.service()).overview() }))
          .catch((err: unknown) => ({ error: messageOf(err) })),
        listTokens(opts.tokens),
        opts.repo.info?.().catch(() => undefined),
        opts.index?.().catch((err: unknown) => ({ lastError: messageOf(err) })) ?? {},
      ]);
      const overview = "overview" in vault ? vault.overview : undefined;
      const oauth = { on: !!opts.settings, owners: opts.settings?.owners.size ?? 0, missing: opts.settings ? [] : (opts.oauthMissing ?? []) };
      const repoStatus = { name: opts.repo.name, branch: opts.repo.branch, head: repo?.head, private: repo?.private };
      const agents: AgentConnect[] = (overview?.party ?? []).map((p) => ({ agent: p.slug, title: p.title, lastSeen: p.lastSeen, snippets: connectSnippets(publicUrl, p.slug, oauth.on) }));
      return {
        kind: "remote",
        items: items({ oauth, repo: repoStatus, index, tokens: tokens.length, overview, vaultError: "error" in vault ? vault.error : undefined }),
        publicUrl,
        oauth,
        repo: repoStatus,
        index,
        agents,
        unknownAgents: overview?.attention.unknownAgents ?? [],
      };
    },

    async handle(method, path, body) {
      if (path === "tokens" && method === "GET") {
        const tokens: TokenInfo[] = (await listTokens(opts.tokens)).map(({ id, agent, scopes, created }) => ({ id, agent, scopes, created }));
        tokens.sort((a, b) => a.agent.localeCompare(b.agent) || (b.created ?? "").localeCompare(a.created ?? ""));
        return { tokens };
      }
      if (path === "tokens" && method === "POST") {
        const { agent, scopes } = tokenRequest(body);
        const grant = { agent, scopes, created: now().toISOString() };
        const { token, id } = await mintToken(opts.tokens, grant);
        const minted: MintedToken = { id, ...grant, token, snippets: bearerSnippets(publicUrl, token) };
        return minted;
      }
      if (path === "tokens/revoke" && method === "POST") {
        const id = (body as { id?: unknown } | undefined)?.id;
        if (typeof id !== "string" || !TOKEN_ID.test(id)) throw new HttpError(400, "id: expected a token id (64 hex characters)", "INVALID");
        if (!(await opts.tokens.get(id))) throw new HttpError(404, "No such token: it may be revoked already.", "NOT_FOUND");
        await opts.tokens.delete(id);
        return { ok: true };
      }
      throw new HttpError(404, `No such setup route: ${method} ${path}`, "NOT_FOUND");
    },
  };
}

/** `{ agent, scopes }` for a new token: a valid agent id, known scopes, and `read` among them. */
function tokenRequest(body: unknown): { agent: string; scopes: (typeof SCOPES)[number][] } {
  const b = (body ?? {}) as { agent?: unknown; scopes?: unknown };
  const agent = typeof b.agent === "string" ? b.agent.trim().toLowerCase() : "";
  if (!AGENT_ID.test(agent)) throw new HttpError(400, "agent: use lowercase letters, digits and dashes, like home-finder", "INVALID");
  if (!Array.isArray(b.scopes)) throw new HttpError(400, `scopes: expected a list from ${SCOPES.join(", ")}`, "INVALID");
  const unknown = b.scopes.filter((s) => !isScope(s));
  if (unknown.length) throw new HttpError(400, `scopes: unknown ${unknown.map(String).join(", ")}; choose from ${SCOPES.join(", ")}`, "INVALID");
  if (!b.scopes.includes("read")) throw new HttpError(400, "scopes: every token needs read", "INVALID");
  return { agent, scopes: SCOPES.filter((s) => (b.scopes as unknown[]).includes(s)) };
}

function items(s: {
  oauth: RemoteSetupStatus["oauth"];
  repo: { name: string; branch: string; private?: boolean };
  index: RemoteSetupStatus["index"];
  tokens: number;
  overview?: Overview;
  vaultError?: string;
}): SetupItem[] {
  const out: SetupItem[] = [];
  out.push(
    s.oauth.on
      ? { id: "oauth", title: "Sign-in (OAuth)", state: "done", detail: `GitHub sign-in for ${plural(s.oauth.owners, "owner")}; connectors can sign in`, how: "guided" }
      : { id: "oauth", title: "Sign-in (OAuth)", state: "todo", detail: `Set ${s.oauth.missing.join(", ") || "the OAuth secrets"} with wrangler secret put`, how: "guided" },
  );
  const where = `${s.repo.name}@${s.repo.branch}`;
  out.push(
    s.repo.private === true
      ? { id: "repo", title: "Private vault repo", state: "done", detail: `${where} is private`, how: "guided" }
      : s.repo.private === false
        ? { id: "repo", title: "Private vault repo", state: "error", detail: `${where} is public: anyone can read this memory. Make the repo private on GitHub.`, how: "guided" }
        : { id: "repo", title: "Private vault repo", state: "warn", detail: `Couldn't check ${where}'s visibility with this token`, how: "guided" },
  );
  if (s.vaultError) out.push({ id: "party", title: "Party", state: "error", detail: `The vault doesn't load: ${s.vaultError}`, how: "performed" });
  else if (s.overview) {
    const unknown = s.overview.attention.unknownAgents;
    const party = s.overview.party.length;
    out.push({
      id: "party",
      title: "Party",
      state: unknown.length ? "warn" : party ? "done" : "todo",
      detail: `${plural(party, "party member")}${unknown.length ? `; writing without a party note: ${unknown.join(", ")}` : ""}`,
      how: "performed",
    });
    const seen = s.overview.party.filter((p) => p.lastSeen).length;
    out.push({ id: "agents", title: "Connect agents", state: seen ? "done" : "todo", detail: party ? `${seen} of ${party} seen at work` : "Add party members first", how: "guided" });
  }
  out.push({
    id: "tokens",
    title: "Agent tokens",
    state: s.tokens ? "done" : s.oauth.on ? "optional" : "todo",
    detail: s.tokens ? `${plural(s.tokens, "token")} issued` : s.oauth.on ? "Connectors sign in with OAuth; mint tokens for agents that use a bearer token" : "Mint a token for each agent",
    how: "performed",
  });
  const semantic = s.index.embedder ? `semantic recall with ${s.index.embedder}` : "keyword search (no embedder)";
  // The index catches up with the vault on the next search, so a fresh deploy reads as empty until then.
  const size = s.index.entities === undefined ? "" : s.index.entities ? `${plural(s.index.entities, "entity", "entities")} indexed; ` : "Fills on the first search; ";
  out.push(
    s.index.lastError
      ? { id: "index", title: "Search index", state: "warn", detail: `${semantic}, falling back to keywords: ${s.index.lastError}`, how: "guided" }
      : { id: "index", title: "Search index", state: "done", detail: `${size}${semantic}`, how: "guided" },
  );
  return out;
}

/** How a party member connects. Tokens are shown once, so these carry a placeholder until one is minted. */
function connectSnippets(publicUrl: string | undefined, agent: string, oauth: boolean): Snippet[] {
  const snippets = bearerSnippets(publicUrl, "<token>").map((s) => ({ ...s, note: `Mint a token for ${agent} under Tokens and paste it here; it's shown only once.` }));
  if (oauth) snippets.push({ label: "Claude.ai or ChatGPT (custom connector)", lang: "text", code: `${publicUrl}/mcp`, note: `Add a custom connector with this URL, then enter ${agent} as the agent on the consent page.` });
  return snippets;
}

function bearerSnippets(publicUrl: string | undefined, token: string): Snippet[] {
  const mcp = `${publicUrl ?? PLACEHOLDER_URL}/mcp`;
  return [
    { label: "Claude Code", lang: "bash", code: `claude mcp add --transport http hippocampus ${mcp} --header "Authorization: Bearer ${token}"` },
    { label: "Any MCP client over HTTP (.mcp.json)", lang: "json", code: JSON.stringify({ mcpServers: { hippocampus: { type: "http", url: mcp, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) },
  ];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
