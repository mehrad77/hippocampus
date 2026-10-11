import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import {
  ACTOR_TRAILER,
  CONFIG_PATH,
  CURRENT_VAULT_VERSION,
  HANDBOOK_PATH,
  HippoService,
  MODEL_TRAILER,
  Vault,
  actorTrailer,
  applyChanges,
  applyPreset,
  decryptSecret,
  fieldUsage,
  isSecretRef,
  migrate,
  pickPreset,
  presetCatalog,
  readChronicle,
  rebuildStats,
  renderHandbook,
  secretPath,
  validateShapes,
  vaultVersionStatus,
  withTrailers,
  type SearcherFactory,
  type VaultStore,
} from "@hippocampus/core";
import { MemoryRunStore, SleepRelay, aiSdkLLM, commitMessage, llmConfigFromEnv, sleep, type SleepReport } from "@hippocampus/curator";
import { createHippoServer } from "@hippocampus/mcp";
import { GitHubStore } from "@hippocampus/store-github";
import { PRESETS } from "@hippocampus/template";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Command } from "commander";
import { auditHistory } from "./audit.ts";
import { runDashboard } from "./dashboard/command.ts";
import { loadEnv } from "./env-file.ts";
import { Git } from "./git.ts";
import { assetRoot, expandHome, identityFile, indexKey, userEnvFile } from "./paths.ts";
import { openIndex, openSearcher as searcherFor, openStore as storeFor } from "./stores.ts";
import { initVault, keygen, templateFiles } from "./vault-setup.ts";

// Settings: the shell, then a gitignored .env in the working directory, then the user env file
// (~/.config/hippocampus/env, written by `hippo dashboard`). Earlier sources win.
const envOrigins = loadEnv({ userFile: () => userEnvFile() });

const program = new Command()
  .name("hippo")
  .description("Hippocampus: shared, curated memory for a party of agents, in an Obsidian vault whose types and kinds are notes (see `hippo preset list`).")
  .option("-v, --vault <dir>", "vault directory", process.env.HIPPO_VAULT ?? ".")
  .option("--github <owner/repo[#branch]>", "use the vault repo on GitHub directly, without a checkout (token from HIPPO_GITHUB_TOKEN)", process.env.HIPPO_GITHUB_REPO)
  .option("--no-index", "search in memory instead of the persistent index");

const vaultDir = () => resolve(expandHome(program.opts<{ vault: string }>().vault));
const github = () => program.opts<{ github?: string }>().github;
const useIndex = () => program.opts<{ index: boolean }>().index;
const err = (msg: string) => process.stderr.write(`${msg}\n`);
const vaultKey = () => indexKey({ dir: vaultDir(), github: github() });

/** The vault: a GitHub repo with `--github`, else the local directory. */
const openStore = (): VaultStore => storeFor({ dir: vaultDir(), github: github() });
const openSearcher = (): Promise<SearcherFactory | undefined> => searcherFor(vaultKey(), { index: useIndex() });

/** Sleep run by a connected agent (`sleep_start`). The run lives in this process; each unit reads the vault at its head. */
const localRelay = (store: VaultStore) =>
  new SleepRelay({
    open: async (now) => {
      await store.refresh?.();
      return { vault: await Vault.load(store, { now: () => now }), store };
    },
    runs: new MemoryRunStore(),
  });

/** In a local git vault, commit exactly `paths` (on GitHub the store's own commit already did). */
async function commitLocal(paths: string[], message: string, opts: { asUser?: boolean } = {}): Promise<void> {
  if (github()) return;
  if (await new Git(vaultDir()).commitPaths(paths, message, opts)) err("✓ committed");
}

function localOnly(command: string): void {
  if (github()) throw new Error(`\`hippo ${command}\` works on a local vault directory; drop --github`);
}

const repeatable = (value: string, previous: string[] = []) => [...previous, value];
const commaList = (v: string | undefined) =>
  v
    ?.split(",")
    .map((d) => d.trim())
    .filter(Boolean);

program
  .command("init")
  .argument("<dir>", "where to create the vault (a new or empty folder)")
  .option("--seed <name-or-path>", "also copy a seed campaign: a bundled name from seeds/ (e.g. example-relocation) or a directory path")
  .option("--name <name>", "what the memory is about (shown in the Handbook)")
  .option("--campaign <name>", "older name of --name")
  .option("--human <id>", "a human's id; their word outranks every agent. Repeat it for several, the primary first (default: player)", repeatable)
  .option("--preset <name...>", `add presets: ${Object.keys(PRESETS).sort().join(", ")} (see \`hippo preset list\`)`)
  .option("--timezone <iana>", "IANA timezone for chronicle days, e.g. Europe/Lisbon")
  .option("--domains <list>", "comma-separated lane domains, e.g. residency,housing,career")
  .description("Create a new vault from the template (and optionally a seed campaign and presets).")
  .action(async (dir: string, opts: { seed?: string; name?: string; campaign?: string; human?: string[]; preset?: string[]; timezone?: string; domains?: string }) => {
    localOnly("init");
    const humans = opts.human?.map((id) => ({ id: id.trim() }));
    const presets = opts.preset?.flatMap((p) => commaList(p) ?? []);
    const r = await initVault({ target: dir, seed: opts.seed, assets: assetRoot(), campaign: opts.name ?? opts.campaign, humans, presets, timezone: opts.timezone, domains: commaList(opts.domains) });
    if (presets?.length) err(`✓ presets: ${presets.join(", ")}`);
    err(`✓ vault created at ${r.dir}\n  next: open it in Obsidian, push it to a private GitHub repo, and run \`hippo secrets keygen -v ${dir}\` (or \`hippo dashboard -v ${dir}\`)`);
  });

const preset = program.command("preset").description("Presets: bundles of types, kinds, templates and starter notes for one way of using Hippocampus.");

preset
  .command("list")
  .description("List the presets this version bundles.")
  .action(() => {
    for (const p of presetCatalog(PRESETS)) console.log(`${p.name}\n  ${p.description}${p.requires.length ? `\n  needs: ${p.requires.join(", ")}` : ""}`);
  });

preset
  .command("add")
  .argument("<name>", "a preset from `hippo preset list`")
  .option("--force", "overwrite files the vault already has with the preset's, and let its definitions win in merged notes")
  .option("--as <human>", "the human whose note gets the preset's sections (default: the first)")
  .description("Add a preset to the vault: copies what's missing, merges its definitions into yours, commits only those files.")
  .action(async (name: string, opts: { force?: boolean; as?: string }) => {
    const store = openStore();
    const r = await applyPreset(store, pickPreset(PRESETS, name), { force: opts.force, human: opts.as });
    for (const p of r.added) err(`  + ${p}`);
    for (const p of r.merged) err(`  ~ ${p}`);
    for (const p of r.skipped) err(`  = ${p} (kept yours${opts.force ? "" : "; --force to replace it"})`);
    for (const n of r.notes) err(`⚠ ${n}`);
    if (!r.changes.length) {
      err(`✓ the vault already has everything the ${name} preset adds`);
      return;
    }
    const message = withTrailers(`chore: add the ${name} preset`, { [ACTOR_TRAILER]: actorTrailer({ kind: "human" }) });
    await applyChanges(store, r.changes, { message });
    await commitLocal(r.changes.map((c) => c.path), message, { asUser: true });
    err(`✓ added the ${name} preset (${r.changes.length} files)`);
  });

program
  .command("serve")
  .description("Run the MCP server over stdio (default) or local HTTP.")
  .option("-a, --agent <id>", "bind this connection to an agent id", process.env.HIPPO_AGENT)
  .option("--http <port>", "serve streamable HTTP on 127.0.0.1:<port>/mcp instead of stdio (agent via ?agent=)")
  .action(async (opts: { agent?: string; http?: string }) => {
    const store = openStore();
    const service = new HippoService(store, { searcher: await openSearcher() });
    // One relay for the whole server, so every connection sees the same run.
    const relay = localRelay(store);
    if (!opts.http) {
      await createHippoServer({ service, agent: opts.agent, relay }).connect(new StdioServerTransport());
      return;
    }
    const port = Number(opts.http);
    createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      const agent = url.searchParams.get("agent") ?? opts.agent;
      const server = createHippoServer({ service, agent: agent ?? undefined, relay });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close().then(() => server.close()));
      await server.connect(transport);
      await transport.handleRequest(req, res);
    }).listen(port, "127.0.0.1", () => err(`hippocampus MCP on http://127.0.0.1:${port}/mcp`));
  });

program
  .command("sleep")
  .description("Consolidate the inbox into canon: git pull → curate with the LLM → commit → push. With --github, commits straight to the repo.")
  .option("--limit <n>", "max episodes this run")
  .option("--dry-run", "run the curator but write nothing")
  .option("--no-git", "don't pull/commit/push")
  .option("--no-push", "commit but don't push")
  .action(async (opts: { limit?: string; dryRun?: boolean; git: boolean; push: boolean }) => {
    const dir = vaultDir();
    const git = new Git(dir);
    // On GitHub the store's own atomic commit is the git step.
    const useGit = !github() && opts.git && git.isRepo() && !opts.dryRun;
    if (useGit && (await git.hasUpstream())) {
      err("↓ git pull");
      await git.pull();
    }
    const llmConfig = llmConfigFromEnv();
    err(`🌙 sleeping with ${llmConfig.provider}:${llmConfig.model}`);
    const store = openStore();
    const report = await sleep({
      store,
      llm: aiSdkLLM(llmConfig),
      searcher: await openSearcher(),
      limit: opts.limit ? Number(opts.limit) : undefined,
      dryRun: opts.dryRun,
      log: err,
    });
    printReport(report);
    if (store instanceof GitHubStore && report.changed.length) err(`✓ committed ${(await store.head()).slice(0, 7)} to ${store.repo}#${store.branch}`);
    if (useGit && report.changed.length) {
      await git.stage(report.changed);
      if (await git.hasStaged()) {
        await git.commit(withTrailers(commitMessage(report), { [ACTOR_TRAILER]: "curator", [MODEL_TRAILER]: report.model }));
        err("✓ committed");
        if (opts.push && (await git.hasRemote())) {
          await git.push();
          err("↑ pushed");
        }
      }
    }
    if (report.failed.length) process.exitCode = 2;
  });

program
  .command("handbook")
  .description("Regenerate HANDBOOK.md.")
  .action(async () => {
    const store = openStore();
    await applyChanges(store, [{ path: HANDBOOK_PATH, content: renderHandbook(await Vault.load(store)) }], { message: "docs: regenerate handbook" });
    err(`✓ wrote ${HANDBOOK_PATH}`);
  });

program
  .command("validate")
  .description("Load the vault and report problems (duplicate names, invalid frontmatter).")
  .action(async () => {
    const vault = await Vault.load(openStore(), { skipVersionCheck: true });
    const status = vaultVersionStatus(vault.config);
    err(`vault format v${vault.config.version} (tool v${CURRENT_VAULT_VERSION}${status === "current" ? "" : `: ${status}`})`);
    if (status === "newer") process.exitCode = 1;
    if (status === "older") err(`⚠ run \`hippo migrate\` to upgrade this vault to format v${CURRENT_VAULT_VERSION}`);
    err(`${vault.entities.size} entities · ${vault.episodes.length} pending episodes · ${vault.openDisputes().length} open disputes`);
    for (const w of vault.warnings) err(`⚠ ${w}`);
    // Advisory only (never the exit code): notes and episodes that don't fit the schema. Paths and fields, never values.
    if (status === "current") {
      for (const f of validateShapes(vault)) err(`📐 ${f.path}: ${f.message}`);
      for (const u of fieldUsage(vault)) err(`📐 ${u.type} notes use undeclared fields: ${u.fields.map((f) => `${f.field} ×${f.count}`).join(", ")}`);
    }
    // This release still passes an older vault (only the hint), so pinned vault CI keeps working until someone migrates.
    if (vault.warnings.length && status !== "older") process.exitCode = 1;
  });

program
  .command("audit")
  .description("Check recent commits by agents and the curator (their Hippo-Actor trailer) against what each may change. Exits 1 on a violation.")
  .option("--range <a..b>", "audit these commits (git revision range) instead of the last 26 hours")
  .option("--since <when>", 'only commits since this date, e.g. "26 hours ago" (the default without --range)')
  .action(async (opts: { range?: string; since?: string }) => {
    localOnly("audit");
    const git = new Git(vaultDir());
    if (!git.isRepo()) throw new Error(`${vaultDir()} is not a git repository`);
    const r = await auditHistory(git, { range: opts.range, since: opts.since ?? (opts.range ? undefined : "26 hours ago") });
    for (const s of r.skipped) err(`· ${s.sha.slice(0, 7)} skipped: ${s.reason}`);
    // Paths and rules only, never content: this runs in CI logs.
    for (const v of r.violations) err(`✗ ${v.sha.slice(0, 7)} ${v.path}: ${v.rule}`);
    if (r.violations.length) process.exitCode = 1;
    else err(`✓ audited ${r.audited} commit${r.audited === 1 ? "" : "s"}`);
  });

program
  .command("migrate")
  .description("Upgrade the vault's file format to what this version of Hippocampus expects.")
  .option("--dry-run", "list the migrations without applying them")
  .action(async (opts: { dryRun?: boolean }) => {
    const store = openStore();
    const vault = await Vault.load(store, { skipVersionCheck: true });
    const message = (to: number) => withTrailers(`chore: migrate vault format to v${to}`, { [ACTOR_TRAILER]: actorTrailer({ kind: "migration" }) });
    const r = await migrate(store, vault.config, { dryRun: opts.dryRun, template: await templateFiles(assetRoot()) });
    if (!r.applied.length) {
      err(`✓ vault format v${r.to} is up to date`);
      return;
    }
    for (const a of r.applied) err(`${opts.dryRun ? "would apply" : "applied"} ${a}`);
    for (const c of r.changes) err(`  ${"remove" in c ? "-" : "~"} ${c.path}`);
    for (const n of r.notes) err(`⚠ ${n}`);
    // One commit with exactly the migrated paths (removals included), as `hippo audit` expects of the migration actor.
    if (!opts.dryRun) await commitLocal(r.changed, message(r.to));
  });

program
  .command("fmt")
  .description("Re-render every note (normalize frontmatter, regenerate facts, relations, progress and managed regions).")
  .option("--stats", "also recount every note's contact stats from the chronicle")
  .action(async (opts: { stats?: boolean }) => {
    const vault = await Vault.load(openStore());
    if (opts.stats) err(`✓ recounted stats on ${rebuildStats(vault, await readChronicle(vault, "0000-01-01")).length} notes`);
    for (const e of vault.entities.values()) vault.markDirty(e);
    const changed = await vault.flush({ message: opts.stats ? "style: re-render notes and recount stats" : "style: re-render notes" });
    err(`✓ rendered ${changed.length} notes`);
  });

program
  .command("remember")
  .description("Write an episode to the inbox from the command line (as the human by default).")
  .argument("[text...]", "the memory; a kind that takes only data needs none")
  .option("-a, --agent <id>", "agent id")
  .option("-k, --kind <kind>", "one of the vault's kinds (observation, fact, decision, task, question, or one a preset adds)", "fact")
  .option("--data <key=value>", "a data field of the kind, e.g. --data with=[[ana]]; repeat it, and repeat a key for a list", repeatable)
  .option("--secret", "contains secret values")
  .option("--confidential", "keep it out of search, summaries and the chronicle")
  .action(async (words: string[], opts: { agent?: string; kind: string; data?: string[]; secret?: boolean; confidential?: boolean }) => {
    const store = openStore();
    const agent = opts.agent ?? (await Vault.load(store)).config.human;
    const input = { text: words.join(" "), kind: opts.kind, secret: opts.secret, confidential: opts.confidential, ...(opts.data?.length ? { data: parseData(opts.data) } : {}) };
    const r = await new HippoService(store).remember(agent, input, { asHuman: !opts.agent });
    for (const w of r.warnings ?? []) err(`⚠ ${w}`);
    err(`✓ ${r.path}`);
  });

/** `key=value` pairs as episode data; a repeated key becomes a list. The kind types the values. */
function parseData(pairs: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const key = at > 0 ? pair.slice(0, at).trim() : "";
    if (!key) throw new Error(`--data takes key=value, not "${pair}"`);
    const value = pair.slice(at + 1).trim();
    const prev = out[key];
    out[key] = prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value];
  }
  return out;
}

program
  .command("index")
  .description("Rebuild the persistent search index from the vault (it's a cache; this is always safe).")
  .action(async () => {
    const { index, path, options: opts } = await openIndex(vaultKey());
    await index.rebuild();
    const stats = await index.sync(await Vault.load(openStore()));
    const { edges } = await index.counts();
    err(`✓ indexed ${stats.added} docs and ${edges} relations in ${path}`);
    if (opts.embedder) err(`${stats.embedFailed ? "⚠" : "✓"} embedded ${stats.embedded} docs with ${opts.embedder.id}${index.lastEmbedError ? `: ${index.lastEmbedError.message}` : ""}`);
  });

const secrets = program.command("secrets").description("Manage age-encrypted secret facts.");

secrets
  .command("keygen")
  .description(`Create an age identity (${identityFile()}) and set its recipient in ${CONFIG_PATH}.`)
  .option("--reuse", "use the identity that already exists on this machine (e.g. for a second vault)")
  .action(async (opts: { reuse?: boolean }) => {
    const r = await keygen({ store: openStore(), identityFile: identityFile(), reuseExisting: opts.reuse });
    err(
      `${r.created ? `✓ identity saved to ${r.identityFile} (back it up, e.g. in your password manager)` : `✓ reusing the identity in ${r.identityFile}`}\n✓ recipient ${r.recipient} written to ${CONFIG_PATH}`,
    );
  });

secrets
  .command("show")
  .argument("<entity>")
  .argument("[field]")
  .description("Decrypt secret facts of an entity.")
  .action(async (ref: string, field?: string) => {
    const store = openStore();
    const vault = await Vault.load(store);
    const e = vault.resolve(ref);
    if (!e) throw new Error(`no entity "${ref}"`);
    const identity = (await readFile(identityFile(), "utf8")).trim();
    for (const [k, f] of Object.entries(e.fm.facts)) {
      if ((field && k !== field) || !isSecretRef(f.value)) continue;
      const armored = await store.read(secretPath(vault.config.folders.secrets, f.value));
      console.log(`${k}: ${armored ? await decryptSecret(identity, armored) : "(missing ciphertext)"}`);
    }
  });

program
  .command("dashboard")
  .description("Open the dashboard in your browser: your memory at a glance, rulings, goals, and Session Zero setup.")
  .option("-p, --port <n>", "port on 127.0.0.1 (the next free one if it's taken)", "4747")
  .option("--no-open", "print the sign-in link without opening a browser")
  .option("--demo", "the fictional example campaign, in memory")
  .option("--mcp <url>", "a Hippocampus MCP server (e.g. your Worker's /mcp); token from HIPPO_MCP_TOKEN or --token")
  .option("--token <token>", "bearer token for --mcp")
  .option("--as <human>", "which of the vault's humans the dashboard acts as (default: the first)")
  .action(async (opts: { port: string; open: boolean; demo?: boolean; mcp?: string; token?: string; as?: string }) => {
    await runDashboard({ ...opts, vault: program.opts<{ vault: string }>().vault, github: github(), index: useIndex(), origins: envOrigins, log: err });
  });

function printReport(r: SleepReport): void {
  err(
    `\n${r.consolidated.length} consolidated · ${r.failed.length} failed · ${r.remaining} remaining · ${r.summaries.length} summaries · ${r.changed.length} files changed`,
  );
  for (const w of r.warnings) err(`⚠ ${w}`);
}

program.parseAsync().catch((e: unknown) => {
  err(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
