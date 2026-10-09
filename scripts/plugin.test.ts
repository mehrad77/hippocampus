import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The Claude Code plugin is plain files that nothing else loads in CI: a typo in its JSON, a skill
// without frontmatter or a renamed MCP tool would only show up once someone installs it.

const ROOT = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;

interface Marketplace {
  name?: string;
  owner?: { name?: string };
  plugins?: { name?: string; source?: string }[];
}

const marketplace = json(".claude-plugin/marketplace.json") as Marketplace;
const entry = marketplace.plugins?.find((p) => p.name === "hippocampus");
const pluginDir = entry?.source?.replace(/^\.\//, "") ?? "plugins/hippocampus";

/** A SKILL.md's YAML frontmatter, or undefined when it has none. */
function frontmatter(text: string): Record<string, unknown> | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  return m ? (parse(m[1]!) as Record<string, unknown>) : undefined;
}

describe("the Claude Code plugin", () => {
  it("has a marketplace listing its plugin", () => {
    expect(marketplace.name).toBeTruthy();
    expect(marketplace.owner?.name).toBeTruthy();
    expect(marketplace.plugins?.length).toBeGreaterThan(0);
    for (const p of marketplace.plugins ?? []) {
      expect(p.name).toMatch(/^[a-z0-9-]+$/);
      expect(p.source).toMatch(/^\.\//);
      expect(existsSync(join(ROOT, p.source!)), `${p.source} exists`).toBe(true);
    }
    expect(entry).toBeDefined();
  });

  it("has a manifest named like its marketplace entry", () => {
    const plugin = json(`${pluginDir}/.claude-plugin/plugin.json`);
    expect(plugin.name).toBe(entry?.name);
    expect(plugin.description).toBeTruthy();
  });

  it("gives every skill a name matching its folder and a description", () => {
    const skills = readdirSync(join(ROOT, pluginDir, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(skills.map((s) => s.name).sort()).toEqual(["memory", "sleep"]);
    for (const skill of skills) {
      const fm = frontmatter(read(`${pluginDir}/skills/${skill.name}/SKILL.md`));
      expect(fm, `${skill.name}/SKILL.md frontmatter`).toBeDefined();
      expect(fm!.name).toBe(skill.name);
      expect(typeof fm!.description === "string" && fm!.description.trim().length > 0, `${skill.name} description`).toBe(true);
    }
  });

  it("connects over HTTP with the person's own URL and key, never a literal one", () => {
    const { mcpServers } = json(`${pluginDir}/.mcp.json`) as { mcpServers: Record<string, { type?: string; url?: string; headers?: Record<string, string> }> };
    expect(Object.keys(mcpServers)).toEqual(["hippocampus"]);
    const server = mcpServers.hippocampus!;
    expect(server.type).toBe("http");
    expect(server.url).toBe("${HIPPO_MCP_URL}");
    expect(server.headers).toEqual({ Authorization: "Bearer ${HIPPO_KEY}" });
  });

  it("names every sleep tool the MCP server has in the sleep skill", () => {
    // The server's own source, so a tool added or renamed there fails here until the skill follows.
    const tools = [...read("packages/mcp/src/server.ts").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    const sleepTools = tools.filter((t) => t.startsWith("sleep_"));
    expect(sleepTools).toEqual(expect.arrayContaining(["sleep_start", "sleep_answer", "sleep_skip", "sleep_status", "sleep_abort"]));
    const skill = read(`${pluginDir}/skills/sleep/SKILL.md`);
    for (const t of sleepTools) expect(skill, `sleep skill mentions ${t}`).toContain(`\`${t}\``);
  });
});
