// Packs the publishable CLI and fails if the tarball contains anything that looks like real vault data.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "hippo-pack-"));
execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: "apps/cli", stdio: "inherit" });
const tarball = join(out, readdirSync(out).find((f) => f.endsWith(".tgz")));
const files = execFileSync("tar", ["tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean);

const allowed = /^package\/(dist\/|vault-template\/|seeds\/|package\.json$|README\.md$|LICENSE$)/;
const vaultData = [/\/inbox\/[^/]+\/[^/]+\.md$/, /\/chronicle\/.+\.md$/, /\/disputes\/.+\.md$/, /\.age$/, /review\.md$/];
const bad = files.filter((f) => !allowed.test(f) || vaultData.some((re) => re.test(f)));
if (bad.length) {
  console.error(`✗ unexpected files in package:\n${bad.join("\n")}`);
  process.exit(1);
}
// `hippo dashboard` serves the UI from the package; without it the command only shows a "not built" page.
if (!files.includes("package/dist/dashboard/index.html")) {
  console.error("✗ package/dist/dashboard/index.html is missing: the dashboard UI wasn't built into the package");
  process.exit(1);
}
console.log(`✓ ${files.length} files, no vault data (${tarball})`);
