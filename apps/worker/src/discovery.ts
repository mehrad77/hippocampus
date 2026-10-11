import { SERVER_VERSION } from "@hippocampus/mcp";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { DEVICE_GRANT, DEVICE_PATH, DEVICE_TOKEN_PATH, DEVICE_VERIFY_PAGE } from "./hosted/device.ts";

// What this instance tells agents about itself before anyone signs in, in the conventions agents look
// for. docs/AGENT-STANDARDS.md lists each one, how settled it is, and when to look at it again.
//
//   /llms.txt                        llmstxt.org: what this is, and how an agent connects or guides a person to
//   /mcp/server-card                 MCP Server Card (SEP-2127): where to connect, which protocol versions
//   /.well-known/ai-catalog.json     AI Catalog: points at the server card, for domain-level discovery
//
// OAuth's own discovery (RFC 9728 protected resource, RFC 8414 authorization server) is the OAuth
// library's. Nothing here names a person or a vault: it's the same for everyone.

export const LLMS_PATH = "/llms.txt";
export const SERVER_CARD_PATH = "/mcp/server-card";
export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";
const REPO = "https://github.com/mehrad77/hippocampus";

/** CORS and caching for public, read-only discovery documents (the Server Card extension asks for these). */
export const DISCOVERY_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET",
  "access-control-allow-headers": "Content-Type, If-None-Match",
  "access-control-expose-headers": "ETag",
  "cache-control": "public, max-age=3600",
};

export function serverCard(publicUrl: string) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: `${new URL(publicUrl).host}/hippocampus`,
    version: SERVER_VERSION,
    title: "Hippocampus",
    description: "Shared, curated memory for a person's AI agents. Each connection serves one vault.",
    websiteUrl: publicUrl,
    repository: { url: REPO, source: "github" },
    remotes: [
      {
        type: "streamable-http",
        // The plain address works with any key (the key decides the vault); each vault also has its own, /mcp/<vault id>.
        url: `${publicUrl}/mcp`,
        headers: [{ name: "Authorization", description: "Bearer and a key from the dashboard, or sign in with OAuth (discovered from a 401)", isRequired: false, isSecret: true }],
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      },
    ],
  };
}

export function aiCatalog(publicUrl: string) {
  return {
    specVersion: "1.0",
    entries: [{ identifier: `urn:air:${new URL(publicUrl).host}:mcp:hippocampus`, type: "application/mcp-server-card+json", url: `${publicUrl}${SERVER_CARD_PATH}` }],
  };
}

/** /llms.txt: for an agent that lands here, whether it connects itself or helps a person do it. */
export function llmsTxt(publicUrl: string): string {
  const guide = (slug: string) => `${publicUrl}/dashboard/guides/${slug}/`;
  return `# Hippocampus

> Shared, curated memory for one person's AI agents, kept as Markdown notes in a private Git repository they own. Agents read and remember through MCP; a curator agent consolidates new memories into notes each night; the person settles disagreements on a dashboard.

This is a hosted Hippocampus at ${publicUrl}. A person signs in with GitHub and keeps one or more vaults here. Every MCP connection serves exactly one vault: a key opens only its own vault, and at another vault's address (\`/mcp/<vault id>\`) it is refused (403 \`wrong_vault\`).

Rules for agents:

- Never ask the person to paste a key into a chat. Keys go into an app's settings, or come to you through device sign-in (below), which the person approves.
- One key per app, shared by the agents in it. Each agent names itself on every call with the \`agent\` argument: \`<platform>-<role>\`, lowercase letters, digits and dashes (\`claude-code-home-finder\`), the same every session. An id another connection holds is refused.
- An unknown agent calls \`introduce\` once and joins at once, with no authority: its memories count as rumors until the person makes it responsible for a domain.
- The curator (the \`curate\` scope) sees every new memory in full, secrets included. Suggest a separate bot that only curates.

## Connect yourself (device sign-in)

The person approves on the dashboard; you never see their password. The shapes are those of the OAuth device grant (RFC 8628), and what you get is a key for one vault.

1. \`POST ${publicUrl}${DEVICE_PATH}\` with \`client_name\` (your app's name), and optionally \`access\` (\`remember\`, the default; \`read\`, which also takes an \`agent\` id, since a read-only key is for one agent; or \`curate\`). JSON or a form. You get \`device_code\`, \`user_code\`, \`verification_uri_complete\`, \`interval\` and \`expires_in\` (10 minutes).
2. Show the person \`user_code\` and \`verification_uri_complete\` (${publicUrl}${DEVICE_VERIFY_PAGE}?code=…). They sign in, pick the vault, and approve.
3. \`POST ${publicUrl}${DEVICE_TOKEN_PATH}\` with \`grant_type=${DEVICE_GRANT}\` and \`device_code\`, every \`interval\` seconds. You get \`authorization_pending\`, \`slow_down\`, \`access_denied\` or \`expired_token\`, then once: \`access_token\` (the key), \`mcp_url\`, \`server_name\`, \`vault\`, \`agent\` (for a read-only key), and \`claude_code\` (a ready \`claude mcp add\` line).
4. Configure your MCP client with \`mcp_url\` and the header \`Authorization: Bearer <access_token>\`, then call \`onboard\` with your agent id.

## Guide a person to connect an app

1. They open ${publicUrl}/dashboard/setup/ and sign in with GitHub (new accounts may wait for an admin, unless someone invited them).
2. In **Connected apps**, **Connect an app**: pick the app (Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Grok, a Grok bot, another MCP app, a script). That's all it asks.
3. They paste the snippet it shows into that app. The key is shown once.
4. Apps that sign in themselves (Claude.ai, ChatGPT) add a custom connector with ${publicUrl}/mcp and sign in (beta); the person picks the vault.

## MCP

- [Server card](${publicUrl}${SERVER_CARD_PATH}): where to connect and which protocol versions (MCP Server Cards).
- Address: \`${publicUrl}/mcp/<vault id>\` (or \`${publicUrl}/mcp\`, where the key decides the vault). Streamable HTTP. Auth: \`Authorization: Bearer <key>\`, or OAuth 2.1 discovered from the 401 (RFC 9728).
- Tools: \`onboard\`, \`recall\`, \`get\`, \`neighbors\`, \`ask_canon\`, \`briefing\`, \`remember\`, \`introduce\`, \`update_goal\`; curators also get \`sleep_start\`, \`sleep_answer\`, \`sleep_skip\`, \`sleep_status\`, \`sleep_abort\`.

## Guides

- [Connecting agents](${guide("connecting-agents")}): keys, apps, what each may do.
- [The nightly sleep](${guide("nightly-sleep")}): setting up the curator.
- [How it works](${guide("how-it-works")}): the loop, in plain words.

## Optional

- [Source and docs](${REPO}): the code, docs/USAGE.md, SECURITY.md.
- [Claude Code plugin](${REPO}#readme): \`claude plugin marketplace add mehrad77/hippocampus\`, then \`claude plugin install hippocampus@hippocampus\`; skills \`/hippocampus:connect\`, \`/hippocampus:memory\`, \`/hippocampus:sleep\`, \`/hippocampus:sleep-setup\`.
`;
}
