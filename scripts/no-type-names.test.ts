import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Code checks capabilities (goal, actor, arc), never type names: a vault may call its goals
// anything. The v1 names live only in schema-registry.ts's legacy map (as object keys, so not literals)
// and in the format migrations (packages/core/src/migrations/).
const ROOT = join(import.meta.dirname, "..");
const LITERAL = /(["'`])(quest|party|campaign)\1/g;

/**
 * Literals that aren't type checks. Each entry is a file and a fragment of the offending line.
 * Keep it short: a new entry needs a reason a type name can't do the job.
 */
const ALLOWED: { file: string; line: string; why: string }[] = [
  // The `quest` key scope and `update_quest` tool keep their wire names (rollback-safe; `goal` arrives alongside).
  { file: "packages/core/src/audit.ts", line: 'can("quest")', why: "key scope name" },
  { file: "packages/mcp/src/server.ts", line: "export const SCOPES", why: "key scope names" },
  { file: "packages/mcp/src/server.ts", line: '"quest",', why: "key scope name in the tool's scope table" },
  { file: "apps/worker/src/hosted/registry.ts", line: "KEY_SCOPES", why: "key scope names" },
  { file: "apps/worker/src/hosted/registry.ts", line: '["read", "remember", "quest"]', why: "key scope names" },
  { file: "packages/dashboard/src/mcp-source.ts", line: 'can("quest")', why: "key scope name" },
  { file: "packages/dashboard/src/demo-hosted.ts", line: '"remember", "quest"]', why: "key scope names" },
  // Config keys and values of the v1 format (renamed in v2), not entity types.
  { file: "packages/core/src/schema.ts", line: 'name: z.coerce.string().default("campaign")', why: "the vault name's v1 default" },
  { file: "packages/core/src/bootstrap.ts", line: '!doc.has("campaign") ? "name" : "campaign"', why: "v1 config key `campaign` (the vault's name)" },
  { file: "packages/core/src/config.ts", line: 'folder: "party"', why: "the default config's agent folder (data; party keeps its name in v2)" },
  // A Session Zero step id shown to the human, not a type.
  { file: "packages/dashboard/src/demo-setup.ts", line: '{ id: "party", title: "Party"', why: "setup step id" },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Test support and fixtures build vaults with v1 names on purpose; format migrations convert them.
      if (!["node_modules", "__fixtures__", "testing", "migrations"].includes(entry.name)) out.push(...sources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".gen.ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("no type names in code", () => {
  it("has no quest/party/campaign string literals outside the legacy map and the allow-list", () => {
    const roots = [...readdirSync(join(ROOT, "packages")).map((p) => join(ROOT, "packages", p, "src")), join(ROOT, "apps/worker/src")];
    const hits: string[] = [];
    for (const root of roots) {
      let files: string[];
      try {
        files = sources(root);
      } catch {
        continue;
      }
      for (const path of files) {
        const file = relative(ROOT, path);
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((text, i) => {
            if (!text.match(LITERAL)) return;
            // Comments may name the scope or the v1 types.
            if (/^(\/\/|\/?\*)/.test(text.trimStart())) return;
            if (ALLOWED.some((a) => a.file === file && text.includes(a.line))) return;
            hits.push(`${file}:${i + 1}: ${text.trim()}`);
          });
      }
    }
    expect(hits).toEqual([]);
  });

  it("keeps every allow-list entry in use", () => {
    const used = (a: (typeof ALLOWED)[number]) =>
      readFileSync(join(ROOT, a.file), "utf8")
        .split("\n")
        .some((l) => l.includes(a.line) && !!l.match(LITERAL));
    expect(ALLOWED.filter((a) => !used(a))).toEqual([]);
  });
});
