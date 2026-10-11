import type { Snippet } from "./setup.ts";

// Connecting an app to a hosted vault: which apps there are, what each needs pasted, and the plain
// words for what a connection may do. Pure and dependency-free: the Worker sends these snippets with
// a new key, the demo fakes them, and the dashboard (`@hippocampus/dashboard/connect`) shows them.

/**
 * Apps that connect with a key: one key each, whatever agents run in them (they name themselves).
 * Sign-in apps (Claude.ai, ChatGPT) use the sign-in address alone.
 */
export const CONNECT_APPS: readonly { id: string; name: string; where: string }[] = [
  { id: "claude-code", name: "Claude Code", where: "In a terminal" },
  { id: "claude-desktop", name: "Claude Desktop", where: "claude_desktop_config.json" },
  { id: "cursor", name: "Cursor", where: "~/.cursor/mcp.json" },
  { id: "vscode", name: "VS Code", where: ".vscode/mcp.json" },
  { id: "windsurf", name: "Windsurf", where: "~/.codeium/windsurf/mcp_config.json" },
  { id: "grok", name: "Grok (CLI)", where: "grok mcp add" },
  { id: "xai-api", name: "A Grok bot (xAI API)", where: "The bot's tools list" },
  { id: "other", name: "Another MCP app", where: "Its MCP settings (HTTP)" },
  { id: "script", name: "A script or automation", where: "Environment variables" },
];

export type ConnectAppId = "claude-code" | "claude-desktop" | "cursor" | "vscode" | "windsurf" | "grok" | "xai-api" | "other" | "script";

/** What a connection may do, in plain words, with the exact scopes behind each. */
export const ACCESS = {
  remember: { title: "Remember and recall", help: "Reads the memory, adds what it learns, and updates goals. Most apps want this.", scopes: ["read", "remember", "goal"] },
  read: { title: "Only look things up", help: "Reads and searches the memory; can't add to it.", scopes: ["read"] },
  curate: { title: "Curate nightly", help: "Runs sleep: turns new memories into notes. It sees secret memories in full.", scopes: ["read", "curate"] },
} as const;

export type Access = keyof typeof ACCESS;

/** The words for a connection's scopes, the closest match (a custom set reads as what it allows). */
/** The goal scope's old name, which older keys and grants still carry. */
const OLD_GOAL_SCOPE = "quest";

export function accessOf(scopes: readonly string[]): { title: string; exact: boolean } {
  const current = scopes.map((s) => (s === OLD_GOAL_SCOPE ? "goal" : s));
  const has = (s: string) => current.includes(s);
  for (const a of Object.values(ACCESS)) if (a.scopes.length === new Set(current).size && a.scopes.every(has)) return { title: a.title, exact: true };
  if (has("curate")) return { title: ACCESS.curate.title, exact: false };
  if (has("remember")) return { title: has("goal") ? ACCESS.remember.title : "Remember and recall (no goals)", exact: false };
  return { title: has("goal") ? "Look things up and update goals" : ACCESS.read.title, exact: false };
}

/** The MCP server's name in an app's config: the vault's repo name, so each vault gets its own (`hippo-lisbon-vault`). */
export function mcpServerName(vaultFullName: string, curator = false): string {
  const repo = vaultFullName.split("/").pop() ?? "";
  const slug =
    repo
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "vault";
  return `hippo-${slug}${curator ? "-curator" : ""}`;
}

export interface ConnectTarget {
  /** The vault's own MCP address (`…/mcp/<vault id>`). */
  url: string;
  /** The key, shown once. */
  key: string;
  /** The server's name in the app's config (`mcpServerName`). */
  server: string;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** What to paste into one app. Every snippet carries the key, so it's shown once, with it. */
export function connectSnippet(app: ConnectAppId, t: ConnectTarget): Snippet {
  const auth = `Bearer ${t.key}`;
  switch (app) {
    case "claude-code":
      return { label: "Claude Code", lang: "bash", code: `claude mcp add --transport http ${t.server} ${t.url} --header "Authorization: ${auth}"`, note: "Run it in a terminal. Add --scope user to use it in every project." };
    case "claude-desktop":
      return {
        label: "Claude Desktop (claude_desktop_config.json)",
        lang: "json",
        code: json({ mcpServers: { [t.server]: { command: "npx", args: ["-y", "mcp-remote", t.url, "--header", "Authorization:${HIPPO_AUTH}"], env: { HIPPO_AUTH: auth } } } }),
        note: "Settings → Developer → Edit Config, merge this in, then restart Claude Desktop. It needs Node.js (for npx).",
      };
    case "cursor":
      return { label: "Cursor (~/.cursor/mcp.json)", lang: "json", code: json({ mcpServers: { [t.server]: { url: t.url, headers: { Authorization: auth } } } }) };
    case "vscode":
      return { label: "VS Code (.vscode/mcp.json)", lang: "json", code: json({ servers: { [t.server]: { type: "http", url: t.url, headers: { Authorization: auth } } } }) };
    case "windsurf":
      return { label: "Windsurf (~/.codeium/windsurf/mcp_config.json)", lang: "json", code: json({ mcpServers: { [t.server]: { serverUrl: t.url, headers: { Authorization: auth } } } }) };
    case "grok":
      return { label: "Grok (CLI)", lang: "bash", code: `grok mcp add --transport http ${t.server} ${t.url} --header "Authorization: ${auth}"`, note: `Then check it with: grok mcp doctor ${t.server}` };
    case "xai-api":
      return {
        label: "A Grok bot (xAI API: a remote MCP tool)",
        lang: "json",
        code: json({ type: "mcp", server_url: t.url, server_label: t.server, server_description: "The person's Hippocampus memory (one vault)", authorization: auth }),
        note: "Add it to the tools of the bot's Responses API calls (POST https://api.x.ai/v1/responses). Keep the key in the bot's environment, not its code.",
      };
    case "other":
      return { label: "Any MCP client over HTTP (.mcp.json)", lang: "json", code: json({ mcpServers: { [t.server]: { type: "http", url: t.url, headers: { Authorization: auth } } } }) };
    case "script":
      return {
        label: "A script (environment variables)",
        lang: "bash",
        code: `export HIPPO_MCP_URL=${t.url}\nexport HIPPO_KEY=${t.key}`,
        note: "Send MCP requests over HTTP to HIPPO_MCP_URL with the header Authorization: Bearer $HIPPO_KEY. The Claude Code plugin reads these two too.",
      };
  }
}

/** Every key app's snippet, `first` first. */
export function connectSnippets(t: ConnectTarget, first?: ConnectAppId): Snippet[] {
  const order = (CONNECT_APPS.map((a) => a.id) as ConnectAppId[]).sort((a, b) => Number(b === first) - Number(a === first));
  return order.map((app) => connectSnippet(app, t));
}

/**
 * Where the nightly curator can run, cheapest first: the same three the `sleep-setup` skill offers, in
 * the same words. An agent the person already has costs nothing new; Actions needs Claude paid for.
 */
export const CURATION_PLACES = [
  {
    id: "schedule",
    title: "One of your agents",
    help: "An agent you already use (Claude Code, a Grok bot, …) runs sleep on a schedule or when you ask. No new charge. Best as a bot of its own that only curates.",
  },
  { id: "elsewhere", title: "A script or cron line", help: "Your own machine runs Claude Code (or any agent) every night from a cron line." },
  { id: "actions", title: "GitHub Actions", help: "Runs nightly on GitHub, so nothing of yours stays on, but it needs Claude paid for: a subscription token or an API key. GitHub vaults only." },
] as const;

export type CurationPlace = (typeof CURATION_PLACES)[number]["id"];

/** How to run the curator with a new curator key, for each place. `repo` is the vault's repo, for the Actions secrets. */
/** What to ask a curator agent, wherever it runs (a scheduled task's prompt, a bot's message). */
export const SLEEP_PROMPT = "Run the Hippocampus sleep as this vault's curator: call sleep_start with your model name, then answer its questions with sleep_answer (or sleep_skip) until the run is done. Never repeat a secret value outside the answers.";

export function curatorSnippets(t: ConnectTarget & { repo?: string }): Snippet[] {
  const out: Snippet[] = [
    { label: "Claude Code (the curator's own server)", lang: "bash", code: `claude mcp add --transport http ${t.server} ${t.url} --header "Authorization: Bearer ${t.key}"`, note: "Then run /hippocampus:sleep, or /hippocampus:sleep-setup to schedule it." },
    { label: "Grok (CLI)", lang: "bash", code: `grok mcp add --transport http ${t.server} ${t.url} --header "Authorization: Bearer ${t.key}"`, note: "Then ask it the sleep prompt below, or schedule that." },
    {
      label: "A Grok bot (xAI API: a remote MCP tool)",
      lang: "json",
      code: json({ type: "mcp", server_url: t.url, server_label: t.server, server_description: "Hippocampus curation (sleep_* tools)", authorization: `Bearer ${t.key}` }),
      note: "Add it to the bot's tools, and send it the sleep prompt below once a night.",
    },
    { label: "The sleep prompt (for any agent)", lang: "text", code: SLEEP_PROMPT },
    {
      label: "Every night at 03:30 (cron)",
      lang: "bash",
      code: `30 3 * * * HIPPO_MCP_URL=${t.url} HIPPO_KEY=${t.key} claude -p "/hippocampus:sleep" --allowedTools "mcp__hippocampus__*"`,
      note: "Needs the Claude Code plugin (claude plugin install hippocampus@hippocampus).",
    },
  ];
  if (t.repo)
    out.push({
      label: "GitHub Actions secrets (for the nightly workflow)",
      lang: "bash",
      code: `gh secret set HIPPO_CURATOR_KEY --repo ${t.repo} --body "${t.key}"\ngh variable set HIPPO_MCP_URL --repo ${t.repo} --body "${t.url}"`,
      note: "The workflow also needs Claude: a subscription token (claude setup-token, then gh secret set CLAUDE_CODE_OAUTH_TOKEN) or an API key (gh secret set ANTHROPIC_API_KEY).",
    });
  return out;
}

/**
 * The snippets that come with a new key (the Worker's and the demo's): for a curator key, how to run
 * the curator; for any other, every app's, `app` first, then the sign-in apps' address.
 */
export function keySnippets(o: { publicUrl: string; token: string; kind: "agent" | "bound" | "curator"; vault: { id: string; fullName: string; provider?: string }; app?: ConnectAppId }): Snippet[] {
  const url = `${o.publicUrl}/mcp/${o.vault.id}`;
  const curator = o.kind === "curator";
  const t = { url, key: o.token, server: mcpServerName(o.vault.fullName, curator) };
  if (curator) return curatorSnippets({ ...t, ...((o.vault.provider ?? "github") === "github" ? { repo: o.vault.fullName } : {}) });
  return [
    ...connectSnippets(t, o.app),
    { label: "Claude.ai or ChatGPT (sign-in, beta)", lang: "text", code: `${o.publicUrl}/mcp`, note: "These apps sign in with your account instead of a key: add a custom connector with this address, and pick this vault when asked. Still in beta: if signing in fails, use a key with another app." },
  ];
}

export const isConnectApp = (v: unknown): v is ConnectAppId => CONNECT_APPS.some((a) => a.id === v);
