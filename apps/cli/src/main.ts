import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import {
  CONFIG_PATH,
  CURRENT_VAULT_VERSION,
  HANDBOOK_PATH,
  HippoService,
  Vault,
  applyChanges,
  decryptSecret,
  isSecretRef,
  migrate,
  renderHandbook,
  secretPath,
  vaultVersionStatus,
  type SearcherFactory,
  type VaultStore,
} from "@hippocampus/core";
import { aiSdkLLM, commitMessage, llmConfigFromEnv, sleep, type SleepReport } from "@hippocampus/curator";
import { createHippoServer } from "@hippocampus/mcp";
import { GitHubStore } from "@hippocampus/store-github";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Command } from "commander";
import { runDashboard } from "./dashboard/command.ts";
import { loadEnv } from "./env-file.ts";
import { Git } from "./git.ts";
import { assetRoot, expandHome, identityFile, indexKey, userEnvFile } from "./paths.ts";
import { openIndex, openSearcher as searcherFor, openStore as storeFor } from "./stores.ts";
import { initVault, keygen } from "./vault-setup.ts";

// Settings: the shell, then a gitignored .env in the working directory, then the user env file
// (~/.config/hippocampus/env, written by `hippo dashboard`). Earlier sources win.
const envOrigins = loadEnv({ userFile: () => userEnvFile() });

const program = new Command()
  .name("hippo")
  .description("Hippocampus: shared, curated memory for a party of agents (an Obsidian vault run like a TTRPG campaign wiki).")
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

function localOnly(command: string): void {
  if (github()) throw new Error(`\`hippo ${command}\` works on a local vault directory; drop --github`);
}

program
  .command("init")
  .argument("<dir>", "where to create the vault (a new or empty folder)")
  .option("--seed <name-or-path>", "also copy a seed campaign: a bundled name from seeds/ (e.g. example-relocation) or a directory path")
  .option("--campaign <name>", "campaign name (shown in the Player's Handbook)")
  .option("--human <id>", "your party id; your word outranks every agent (default: player)")
  .option("--timezone <iana>", "IANA timezone for chronicle days, e.g. Europe/Lisbon")
  .option("--domains <list>", "comma-separated lane domains, e.g. residency,housing,career")
  .description("Create a new vault from the template (and optionally a seed campaign).")
  .action(async (dir: string, opts: { seed?: string; campaign?: string; human?: string; timezone?: string; domains?: string }) => {
    localOnly("init");
    const domains = opts.domains
      ?.split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const r = await initVault({ target: dir, seed: opts.seed, assets: assetRoot(), campaign: opts.campaign, human: opts.human, timezone: opts.timezone, domains });
    err(`✓ vault created at ${r.dir}\n  next: open it in Obsidian, push it to a private GitHub repo, and run \`hippo secrets keygen -v ${dir}\` (or \`hippo dashboard -v ${dir}\`)`);
  });

program
  .command("serve")
  .description("Run the MCP server over stdio (default) or local HTTP.")
  .option("-a, --agent <id>", "bind this connection to an agent id", process.env.HIPPO_AGENT)
  .option("--http <port>", "serve streamable HTTP on 127.0.0.1:<port>/mcp instead of stdio (agent via ?agent=)")
  .action(async (opts: { agent?: string; http?: string }) => {
    const service = new HippoService(openStore(), { searcher: await openSearcher() });
    if (!opts.http) {
      await createHippoServer({ service, agent: opts.agent }).connect(new StdioServerTransport());
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
      const server = createHippoServer({ service, agent: agent ?? undefined });
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
        await git.commit(commitMessage(report));
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
    err(`vault format v${vault.config.version} (tool v${CURRENT_VAULT_VERSION}${status === "current" ? "" : `: ${status}, run \`hippo migrate\``})`);
    if (status !== "current") process.exitCode = 1;
    err(`${vault.entities.size} entities · ${vault.episodes.length} pending episodes · ${vault.openDisputes().length} open disputes`);
    for (const w of vault.warnings) err(`⚠ ${w}`);
    if (vault.warnings.length) process.exitCode = 1;
  });

program
  .command("migrate")
  .description("Upgrade the vault's file format to what this version of Hippocampus expects.")
  .option("--dry-run", "list the migrations without applying them")
  .action(async (opts: { dryRun?: boolean }) => {
    const store = openStore();
    const vault = await Vault.load(store, { skipVersionCheck: true });
    const r = await migrate(store, vault.config, { dryRun: opts.dryRun });
    if (store instanceof GitHubStore && !opts.dryRun) await store.commit({ message: `chore: migrate vault format to v${r.to}` });
    if (!r.applied.length) {
      err(`✓ vault format v${r.to} is up to date`);
      return;
    }
    for (const a of r.applied) err(`${opts.dryRun ? "would apply" : "applied"} ${a}`);
    for (const c of r.changed) err(`  ${c}`);
  });

program
  .command("fmt")
  .description("Re-render every note (normalize frontmatter, regenerate facts/relations/clocks regions).")
  .action(async () => {
    const vault = await Vault.load(openStore());
    for (const e of vault.entities.values()) vault.markDirty(e);
    const changed = await vault.flush({ message: "style: re-render notes" });
    err(`✓ rendered ${changed.length} notes`);
  });

program
  .command("remember")
  .description("Write an episode to the inbox from the command line (as the human by default).")
  .argument("<text...>")
  .option("-a, --agent <id>", "agent id")
  .option("-k, --kind <kind>", "observation | fact | decision | task | beat | question", "fact")
  .option("--secret", "contains secret values")
  .action(async (words: string[], opts: { agent?: string; kind: "fact"; secret?: boolean }) => {
    const store = openStore();
    const agent = opts.agent ?? (await Vault.load(store)).config.human;
    const r = await new HippoService(store).remember(agent, { text: words.join(" "), kind: opts.kind, secret: opts.secret });
    err(`✓ ${r.path}`);
  });

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
  .description("Open the dashboard in your browser: the campaign at a glance, rulings, quests, and Session Zero setup.")
  .option("-p, --port <n>", "port on 127.0.0.1 (the next free one if it's taken)", "4747")
  .option("--no-open", "print the sign-in link without opening a browser")
  .option("--demo", "the fictional example campaign, in memory")
  .option("--mcp <url>", "a Hippocampus MCP server (e.g. your Worker's /mcp); token from HIPPO_MCP_TOKEN or --token")
  .option("--token <token>", "bearer token for --mcp")
  .action(async (opts: { port: string; open: boolean; demo?: boolean; mcp?: string; token?: string }) => {
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
