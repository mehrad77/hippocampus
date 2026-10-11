import { describe, expect, it } from "vitest";
import { accessOf, CONNECT_APPS, connectSnippet, connectSnippets, curatorSnippets, mcpServerName, speaksAsMany, suggestAgentId, type ConnectAppId } from "./connect.ts";

const t = { url: "https://hippo.test/mcp/01J9Z8D3M0V000000000000001", key: "hippo_secret", server: "hippo-lisbon-vault" };

describe("connecting an app", () => {
  it("gives each app what it needs pasted, with the vault's own address and the key", () => {
    for (const app of CONNECT_APPS) {
      const s = connectSnippet(app.id as ConnectAppId, t);
      expect(s.code, app.id).toContain(t.key);
      expect(s.code, app.id).toContain(t.url);
      if (s.lang === "json") expect(() => JSON.parse(s.code), app.id).not.toThrow();
    }
    expect(connectSnippet("claude-code", t).code).toBe(`claude mcp add --transport http hippo-lisbon-vault ${t.url} --header "Authorization: Bearer hippo_secret"`);
    expect(JSON.parse(connectSnippet("windsurf", t).code).mcpServers["hippo-lisbon-vault"].serverUrl).toBe(t.url);
    expect(JSON.parse(connectSnippet("claude-desktop", t).code).mcpServers["hippo-lisbon-vault"]).toMatchObject({ command: "npx", env: { HIPPO_AUTH: "Bearer hippo_secret" } });
    expect(connectSnippets(t, "cursor")[0]!.label).toMatch(/^Cursor/);
    expect(connectSnippets(t)).toHaveLength(CONNECT_APPS.length);
  });

  it("names servers after the vault, and agents after the app", () => {
    expect(mcpServerName("player/Lisbon Vault")).toBe("hippo-lisbon-vault");
    expect(mcpServerName("player/vault", true)).toBe("hippo-vault-curator");
    expect(suggestAgentId("claude-code")).toBe("claude-code");
    expect(suggestAgentId("cursor", "Work Laptop!")).toBe("cursor-work-laptop");
    // A bot with several personalities shares one key; an app is one agent.
    expect(speaksAsMany("xai-api")).toBe(true);
    expect(speaksAsMany("claude-code")).toBe(false);
  });

  it("puts scopes in plain words", () => {
    expect(accessOf(["read", "remember", "goal"])).toEqual({ title: "Remember and recall", exact: true });
    expect(accessOf(["read", "remember", "quest"])).toEqual({ title: "Remember and recall", exact: true });
    expect(accessOf(["read"])).toEqual({ title: "Only look things up", exact: true });
    expect(accessOf(["read", "curate"]).title).toBe("Curate nightly");
    expect(accessOf(["read", "remember"])).toEqual({ title: "Remember and recall (no goals)", exact: false });
  });

  it("runs the curator three ways, Actions only with a repo", () => {
    expect(curatorSnippets({ ...t, server: "hippo-vault-curator" }).map((s) => s.label)).toEqual([
      "Claude Code (the curator's own server)",
      "Grok (CLI)",
      "A Grok bot (xAI API: a remote MCP tool)",
      "The sleep prompt (for any agent)",
      "Every night at 03:30 (cron)",
    ]);
    const actions = curatorSnippets({ ...t, server: "hippo-vault-curator", repo: "player/vault" }).at(-1)!;
    expect(actions.code).toContain("gh secret set HIPPO_CURATOR_KEY --repo player/vault");
    expect(actions.code).toContain("gh variable set HIPPO_MCP_URL");
  });
});
