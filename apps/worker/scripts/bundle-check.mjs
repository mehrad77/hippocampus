// Builds the Worker exactly as `wrangler deploy` would, without deploying: bundling, bindings,
// Durable Object migrations and the asset directory are all checked, and the bundle has to fit
// Cloudflare's size limit. Needs no Cloudflare account; credentials are dropped from the env so a
// dry run can't turn into a real one.
//
//   pnpm --filter @hippocampus/dashboard-ui build    # the assets wrangler reads
//   pnpm --filter @hippocampus/worker bundle:check
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const WORKER_DIR = resolve(import.meta.dirname, "..");
const WRANGLER = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin/wrangler.js");
// Workers Free allows 3 MiB gzipped (Paid, 10 MiB). Staying under the free limit keeps self-hosting free.
const LIMIT = 3 * 1024 * 1024;

if (!existsSync(resolve(WORKER_DIR, "../dashboard/dist/dashboard/index.html"))) {
  console.error("✗ the dashboard UI isn't built: run `pnpm --filter @hippocampus/dashboard-ui build` first");
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), "hippo-bundle-"));
const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(out, "logs") };
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CLOUDFLARE_ACCOUNT_ID", "CF_API_TOKEN", "CF_ACCOUNT_ID"]) delete env[k];

/** Undefined when the bundle is fine, else what's wrong. */
function problem() {
  const r = spawnSync(process.execPath, [WRANGLER, "deploy", "--dry-run", "--outdir", join(out, "dist")], { cwd: WORKER_DIR, env, encoding: "utf8" });
  if (r.status !== 0) return `wrangler deploy --dry-run exited with ${r.status}\n${r.stdout}\n${r.stderr}`;
  const bundle = join(out, "dist", "worker.js");
  if (!existsSync(bundle)) return "no worker.js in the dry run's output";
  const gz = gzipSync(readFileSync(bundle)).length;
  if (gz > LIMIT) return `the Worker is ${kib(gz)} gzipped, over the ${kib(LIMIT)} limit`;
  console.log(`✓ wrangler deploy --dry-run: worker.js is ${kib(gz)} gzipped (limit ${kib(LIMIT)})`);
  return undefined;
}

const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;
let failure;
try {
  failure = problem();
} finally {
  rmSync(out, { recursive: true, force: true });
}
if (failure) {
  console.error(`✗ ${failure}`);
  process.exit(1);
}
