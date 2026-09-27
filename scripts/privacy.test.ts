import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guards the public code repo against accidentally committed vault content or personal data.
const ROOT = join(import.meta.dirname, "..");

/** Files that would be committed: tracked plus untracked-but-not-ignored. */
function publishable(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((p) => p && existsSync(join(ROOT, p)));
}

const VAULT_CONTENT = [/(^|\/)inbox\/[^/]+\/[^/]+\.md$/, /(^|\/)chronicle\/.+\.md$/, /(^|\/)disputes\/.+\.md$/, /\.age$/, /(^|\/)_hippo\/review\.md$/];

describe("privacy guard", () => {
  it("contains no real vault content (inbox episodes, chronicle, disputes, secrets)", () => {
    const leaks = publishable().filter((p) => !p.startsWith("vault-template/") && VAULT_CONTENT.some((re) => re.test(p)));
    expect(leaks).toEqual([]);
  });

  it("contains none of the terms in the local, untracked .privacy-denylist", () => {
    const denylist = join(ROOT, ".privacy-denylist");
    if (!existsSync(denylist)) return;
    const terms = readFileSync(denylist, "utf8")
      .split("\n")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t && !t.startsWith("#"));
    const hits: string[] = [];
    for (const path of publishable()) {
      if (path === "pnpm-lock.yaml" || path === "LICENSE") continue;
      let text: string;
      try {
        text = readFileSync(join(ROOT, path), "utf8").toLowerCase();
      } catch {
        continue;
      }
      for (const t of terms) if (text.includes(t)) hits.push(`${path}: "${t}"`);
    }
    expect(hits).toEqual([]);
  });
});
