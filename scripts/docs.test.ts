import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Agents find their way around this repo through AGENTS.md, README and DESIGN. Nothing else reads
// those, so a renamed file, a new MCP tool or a pinned version only goes stale silently. These checks
// keep the docs pointing at what's really there.

const ROOT = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The text from `heading` (a line starting with it) up to the next heading of the same level. */
function section(text: string, heading: string): string {
  const level = /^#+ /.exec(heading)![0];
  const start = text.split("\n").findIndex((l) => l.startsWith(heading));
  if (start < 0) return "";
  const lines = text.split("\n").slice(start + 1);
  const end = lines.findIndex((l) => l.startsWith(level));
  return lines.slice(0, end < 0 ? undefined : end).join("\n");
}

const backticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

// ── AGENTS.md's project map ──────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".astro", ".turbo", ".wrangler"]);
const walked = new Map<string, string[]>();
/** Every file and directory under `dir` (relative to it), skipping build output and dependencies. */
function walk(dir: string): string[] {
  if (walked.has(dir)) return walked.get(dir)!;
  const out: string[] = [];
  const visit = (abs: string) => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(d.name)) continue;
      const p = join(abs, d.name);
      out.push(relative(dir, p));
      if (d.isDirectory()) visit(p);
    }
  };
  if (existsSync(dir)) visit(dir);
  walked.set(dir, out);
  return out;
}

/** `{a,b}.ts` → `a.ts`, `b.ts`; `a.ts/b.ts` (two file names) → both. */
function expand(token: string): string[][] {
  const brace = /\{([^}]+)\}/.exec(token);
  if (brace) return brace[1]!.split(",").map((alt) => [token.replace(brace[0], alt.trim())]);
  const parts = token.split("/");
  if (parts.length > 1 && parts.every((p) => /\.[a-z]+$/.test(p))) return parts.map((p) => [p]);
  return [[token]];
}

const EXT = /\.(ts|tsx|js|mjs|cjs|json|jsonc|md|mdx|css|astro|ya?ml|sql|toml|txt)$/;
/** A repo file or directory name, not an identifier, command, env var, URL, glob, placeholder or home path. */
function isPathLike(token: string): boolean {
  if (/[\s*<>=:()@$]/.test(token) || /^[/~]/.test(token)) return false;
  return token.endsWith("/") || token.includes("/") || EXT.test(token);
}

/** The row's own paths; `presets/<name>/` searches all of `presets/`. */
const rowPaths = (cell: string) => backticked(cell).map((p) => p.replace(/<[^>]+>.*$/, "").replace(/\/$/, ""));

function resolves(token: string, bases: string[]): boolean {
  const t = token.replace(/\/$/, "");
  // Vault paths (`_hippo/schema/`) are relative to a vault: the template is one.
  if (existsSync(join(ROOT, t)) || existsSync(join(ROOT, "vault-template", t))) return true;
  return bases.some((base) => existsSync(join(ROOT, base, t)) || walk(join(ROOT, base)).some((p) => p === t || p.endsWith(`/${t}`)));
}

describe("AGENTS.md", () => {
  const agents = read("AGENTS.md");

  it("maps only paths that exist", () => {
    const rows = section(agents, "## Project map")
      .split("\n")
      .filter((l) => l.startsWith("| `"))
      .map((l) => l.split(/(?<!\\)\|/).slice(1, -1));
    expect(rows.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const [first, second] of rows) {
      const bases = rowPaths(first!);
      for (const b of bases) if (!existsSync(join(ROOT, b))) missing.push(`AGENTS.md map has a row for ${b}, but it doesn't exist`);
      for (const token of backticked(second ?? "").filter(isPathLike)) {
        const ok = expand(token).every((alts) => alts.some((t) => resolves(t, bases)));
        if (!ok) missing.push(`AGENTS.md map mentions ${token} under ${bases.join(", ")}, but it doesn't exist`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("names every skill the plugin ships", () => {
    const skills = readdirSync(join(ROOT, "plugins/hippocampus/skills"), { withFileTypes: true }).filter((d) => d.isDirectory());
    const named = new Set(backticked(agents));
    expect(skills.map((s) => s.name).filter((s) => !named.has(s) && !named.has(`/hippocampus:${s}`))).toEqual([]);
  });
});

// ── MCP tools in README and DESIGN ───────────────────────────────────────────

/** Old names kept for clients that still call them: DESIGN mentions them, README needn't. */
const ALIASES = new Set(["update_quest"]);

describe("the MCP tools", () => {
  // The server's own source, so a tool added there fails here until the docs follow.
  const tools = [...read("packages/mcp/src/server.ts").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  const mentions = (text: string, tool: string) => new RegExp(`\`${tool}[\`(]`).test(text);

  it("are found in the server", () => {
    expect(tools).toContain("remember");
  });

  it("are all in the README", () => {
    const readme = read("README.md");
    expect(tools.filter((t) => !ALIASES.has(t) && !mentions(readme, t))).toEqual([]);
  });

  it("are all in DESIGN.md's section 3", () => {
    const design = section(read("DESIGN.md"), "## 3.");
    expect(design).not.toBe("");
    expect(tools.filter((t) => !mentions(design, t))).toEqual([]);
  });
});

// ── Version pins ─────────────────────────────────────────────────────────────

describe("docs and ops files", () => {
  it("pin the CLI to its major version, never a minor one", () => {
    const files = execFileSync("git", ["ls-files", "*.md", "*.mdx", "ops/*"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !f.endsWith("CHANGELOG.md"));
    expect(files.length).toBeGreaterThan(0);
    const pinned = files.flatMap((f) =>
      read(f)
        .split("\n")
        .flatMap((line, i) => (/@mehrad77\/hippocampus@0\.\d/.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(pinned).toEqual([]);
  });
});
