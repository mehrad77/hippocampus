// Deploys the hosted app to the official instance from CI (the `deploy` job in .github/workflows/ci.yml),
// and to it by hand when bootstrapping (docs/DEVELOPING.md, "The official instance").
//
//   node scripts/deploy.mjs config   stamp HIPPO_HOST, CF_REGISTRY_DATABASE_ID and CF_OAUTH_KV_ID into
//                                    apps/worker/wrangler.deploy.json (gitignored); wrangler then reads it with `-c`
//   node scripts/deploy.mjs probe    check https://$HIPPO_HOST answers like a configured, migrated Worker
//
// apps/worker/wrangler.jsonc stays generic for self-hosters: the instance's host and resource ids live in
// the repo's `production` environment. The stamped file sits next to it, so its relative paths still resolve.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";

const WORKER = join(import.meta.dirname, "../apps/worker");

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KV_ID = /^[0-9a-f]{32}$/;
/** wrangler.jsonc's placeholders are one digit repeated. */
const placeholder = (id) => /^(\w)(\1|-)*$/.test(id);

/** The Worker's config for the official instance: its resource ids, and its custom domain as the only origin. */
export function deployConfig(config, { host, registryId, oauthKvId }) {
  if (!HOST.test(host ?? "")) throw new Error("HIPPO_HOST must be a bare hostname, like hippo.example.com");
  if (!UUID.test(registryId ?? "") || placeholder(registryId)) throw new Error("CF_REGISTRY_DATABASE_ID must be the registry's D1 database id");
  if (!KV_ID.test(oauthKvId ?? "") || placeholder(oauthKvId)) throw new Error("CF_OAUTH_KV_ID must be the OAUTH_KV namespace id");
  const has = (list, binding) => (list ?? []).some((b) => b.binding === binding);
  if (!has(config.d1_databases, "REGISTRY")) throw new Error("wrangler.jsonc has no REGISTRY database");
  if (!has(config.kv_namespaces, "OAUTH_KV")) throw new Error("wrangler.jsonc has no OAUTH_KV namespace");
  return {
    ...config,
    d1_databases: config.d1_databases.map((d) => (d.binding === "REGISTRY" ? { ...d, database_id: registryId } : d)),
    kv_namespaces: config.kv_namespaces.map((k) => (k.binding === "OAUTH_KV" ? { ...k, id: oauthKvId } : k)),
    routes: [{ pattern: host, custom_domain: true }],
    workers_dev: false,
    preview_urls: false,
  };
}

/**
 * What's wrong with a deployed Worker, from its answers to `probe`'s four requests; empty when it's fine.
 * Statuses only: an answer's body can carry a vault's name.
 */
export function probeProblems(host, { home, welcome, resource, mcp }) {
  const problems = [];
  if (home.status === 503) problems.push("GET / is 503: the Worker is missing a binding or secret");
  else if (home.status !== 302 || home.location !== "/dashboard/welcome/") problems.push(`GET / is ${home.status}, not a redirect to the welcome page`);
  if (welcome.status !== 200 || !welcome.type?.startsWith("text/html")) problems.push(`the welcome page is ${welcome.status} ${welcome.type ?? ""}: the dashboard assets aren't served`.trim());
  if (resource.status !== 200 || resource.body?.resource !== `https://${host}/mcp`) problems.push(`the MCP resource metadata is ${resource.status} or names another origin: check HIPPO_PUBLIC_URL`);
  if (mcp.status === 500) problems.push("MCP with an unknown key is 500: the registry (D1) isn't reachable or migrated");
  else if (mcp.status !== 401) problems.push(`MCP with an unknown key is ${mcp.status}, not 401`);
  return problems;
}

async function answers(host) {
  const at = (path, init = {}) => fetch(`https://${host}${path}`, { redirect: "manual", signal: AbortSignal.timeout(10_000), ...init });
  const home = await at("/", { headers: { accept: "text/html" } });
  const welcome = await at("/dashboard/welcome/");
  const resource = await at("/.well-known/oauth-protected-resource/mcp");
  // Shaped like a vault key, so it's looked up in the registry: an unmigrated D1 shows as a 500.
  const mcp = await at("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer hippo_${randomBytes(32).toString("base64url")}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  return {
    home: { status: home.status, location: home.headers.get("location") },
    welcome: { status: welcome.status, type: welcome.headers.get("content-type") },
    resource: { status: resource.status, body: resource.ok ? await resource.json().catch(() => undefined) : undefined },
    mcp: { status: mcp.status },
  };
}

/** Retries for about a minute: a new Custom Domain's certificate, or a version still rolling out. */
async function probe(host) {
  let problems = [];
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      problems = probeProblems(host, await answers(host));
    } catch (err) {
      problems = [`https://${host} didn't answer: ${err?.cause?.code ?? err?.name ?? "error"}`];
    }
    if (!problems.length) {
      console.log(`✓ https://${host} is up, configured and migrated`);
      return true;
    }
    console.log(`attempt ${attempt}: ${problems.join("; ")}`);
    if (attempt < 12) await new Promise((ok) => setTimeout(ok, 5_000));
  }
  for (const p of problems) console.error(`✗ ${p}`);
  return false;
}

function main() {
  const [command] = process.argv.slice(2);
  const host = process.env.HIPPO_HOST?.trim();
  if (command === "config") {
    const source = readFileSync(join(WORKER, "wrangler.jsonc"), "utf8");
    const errors = [];
    const config = parse(source, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error("apps/worker/wrangler.jsonc doesn't parse");
    const out = deployConfig(config, { host, registryId: process.env.CF_REGISTRY_DATABASE_ID?.trim(), oauthKvId: process.env.CF_OAUTH_KV_ID?.trim() });
    writeFileSync(join(WORKER, "wrangler.deploy.json"), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`✓ apps/worker/wrangler.deploy.json: ${out.name} on ${host}`);
  } else if (command === "probe") {
    if (!HOST.test(host ?? "")) throw new Error("HIPPO_HOST must be a bare hostname, like hippo.example.com");
    return probe(host).then((ok) => process.exit(ok ? 0 : 1));
  } else {
    console.error("usage: node scripts/deploy.mjs config|probe");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
