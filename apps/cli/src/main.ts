#!/usr/bin/env node
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_PATH,
  HANDBOOK_PATH,
  HippoService,
  Vault,
  decryptSecret,
  generateKeyPair,
  isSecretRef,
  renderHandbook,
  secretPath,
} from "@hippocampus/core";
import { FsStore } from "@hippocampus/core/node";
import { aiSdkLLM, llmConfigFromEnv, sleep, type SleepReport } from "@hippocampus/curator";
import { createHippoServer } from "@hippocampus/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Command } from "commander";
import { parseDocument } from "yaml";
import { Git } from "./git.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const IDENTITY_FILE = process.env.HIPPO_AGE_IDENTITY_FILE ?? join(homedir(), ".config", "hippocampus", "age-identity.txt");

const program = new Command()
  .name("hippo")
  .description("Hippocampus: shared, curated memory for a party of agents (an Obsidian vault run like a TTRPG campaign wiki).")
  .option("-v, --vault <dir>", "vault directory", process.env.HIPPO_VAULT ?? ".");

const vaultDir = () => resolve(program.opts<{ vault: string }>().vault);
const err = (msg: string) => process.stderr.write(`${msg}\n`);

program
  .command("init")
  .argument("<dir>", "where to create the vault")
  .option("--seed <name-or-path>", "also copy a seed campaign: a bundled name from seeds/ (e.g. example-relocation) or a directory path")
  .description("Create a new vault from the template (and optionally a seed campaign).")
  .action(async (dir: string, opts: { seed?: string }) => {
    const target = resolve(dir);
    if (existsSync(join(target, CONFIG_PATH))) throw new Error(`${target} already has ${CONFIG_PATH}`);
    await mkdir(target, { recursive: true });
    await cp(join(REPO_ROOT, "vault-template"), target, { recursive: true });
    if (opts.seed) {
      const bundled = join(REPO_ROOT, "seeds", opts.seed);
      const seed = existsSync(bundled) ? bundled : resolve(opts.seed);
      if (!existsSync(seed)) throw new Error(`no seed "${opts.seed}" (neither ${bundled} nor a directory path)`);
      await cp(seed, target, { recursive: true, force: true });
    }
    const store = new FsStore(target);
    // The template's placeholder PC is replaced by the seed's own player character.
    if ((await Vault.load(store)).config.human !== "player") await store.remove("characters/player.md");
    const vault = await Vault.load(store);
    for (const e of vault.entities.values()) vault.markDirty(e);
    vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
    await vault.flush();
    const git = new Git(target);
    if (!git.isRepo()) await git.run("init", "--quiet", "-b", "main");
    err(`✓ vault created at ${target}\n  next: open it in Obsidian, push it to a private GitHub repo, and run \`hippo secrets keygen -v ${dir}\``);
  });

program
  .command("serve")
  .description("Run the MCP server over stdio (default) or local HTTP.")
  .option("-a, --agent <id>", "bind this connection to an agent id", process.env.HIPPO_AGENT)
  .option("--http <port>", "serve streamable HTTP on 127.0.0.1:<port>/mcp instead of stdio (agent via ?agent=)")
  .action(async (opts: { agent?: string; http?: string }) => {
    const service = new HippoService(new FsStore(vaultDir()));
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
  .description("Consolidate the inbox into canon: git pull → curate with the LLM → commit → push.")
  .option("--limit <n>", "max episodes this run")
  .option("--dry-run", "run the curator but write nothing")
  .option("--no-git", "don't pull/commit/push")
  .option("--no-push", "commit but don't push")
  .action(async (opts: { limit?: string; dryRun?: boolean; git: boolean; push: boolean }) => {
    const dir = vaultDir();
    const git = new Git(dir);
    const useGit = opts.git && git.isRepo() && !opts.dryRun;
    if (useGit && (await git.hasUpstream())) {
      err("↓ git pull");
      await git.pull();
    }
    const llmConfig = llmConfigFromEnv();
    err(`🌙 sleeping with ${llmConfig.provider}:${llmConfig.model}`);
    const report = await sleep({
      store: new FsStore(dir),
      llm: aiSdkLLM(llmConfig),
      limit: opts.limit ? Number(opts.limit) : undefined,
      dryRun: opts.dryRun,
      log: err,
    });
    printReport(report);
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
    const store = new FsStore(vaultDir());
    await store.write(HANDBOOK_PATH, renderHandbook(await Vault.load(store)));
    err(`✓ wrote ${HANDBOOK_PATH}`);
  });

program
  .command("validate")
  .description("Load the vault and report problems (duplicate names, invalid frontmatter).")
  .action(async () => {
    const vault = await Vault.load(new FsStore(vaultDir()));
    err(`${vault.entities.size} entities · ${vault.episodes.length} pending episodes · ${vault.openDisputes().length} open disputes`);
    for (const w of vault.warnings) err(`⚠ ${w}`);
    if (vault.warnings.length) process.exitCode = 1;
  });

program
  .command("fmt")
  .description("Re-render every note (normalize frontmatter, regenerate facts/relations/clocks regions).")
  .action(async () => {
    const vault = await Vault.load(new FsStore(vaultDir()));
    for (const e of vault.entities.values()) vault.markDirty(e);
    const changed = await vault.flush();
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
    const store = new FsStore(vaultDir());
    const agent = opts.agent ?? (await Vault.load(store)).config.human;
    const r = await new HippoService(store).remember(agent, { text: words.join(" "), kind: opts.kind, secret: opts.secret });
    err(`✓ ${r.path}`);
  });

const secrets = program.command("secrets").description("Manage age-encrypted secret facts.");

secrets
  .command("keygen")
  .description(`Create an age identity (${IDENTITY_FILE}) and set its recipient in ${CONFIG_PATH}.`)
  .action(async () => {
    if (existsSync(IDENTITY_FILE)) throw new Error(`${IDENTITY_FILE} already exists; refusing to overwrite`);
    const { identity, recipient } = await generateKeyPair();
    await mkdir(dirname(IDENTITY_FILE), { recursive: true });
    await writeFile(IDENTITY_FILE, `${identity}\n`, { mode: 0o600 });
    await chmod(IDENTITY_FILE, 0o600);
    const configPath = join(vaultDir(), CONFIG_PATH);
    const doc = parseDocument(await readFile(configPath, "utf8"));
    doc.setIn(["secrets", "recipient"], recipient);
    await writeFile(configPath, doc.toString());
    err(`✓ identity saved to ${IDENTITY_FILE} (back it up, e.g. in your password manager)\n✓ recipient ${recipient} written to ${CONFIG_PATH}`);
  });

secrets
  .command("show")
  .argument("<entity>")
  .argument("[field]")
  .description("Decrypt secret facts of an entity.")
  .action(async (ref: string, field?: string) => {
    const store = new FsStore(vaultDir());
    const vault = await Vault.load(store);
    const e = vault.resolve(ref);
    if (!e) throw new Error(`no entity "${ref}"`);
    const identity = (await readFile(IDENTITY_FILE, "utf8")).trim();
    for (const [k, f] of Object.entries(e.fm.facts)) {
      if ((field && k !== field) || !isSecretRef(f.value)) continue;
      const armored = await store.read(secretPath(vault.config.folders.secrets, f.value));
      console.log(`${k}: ${armored ? await decryptSecret(identity, armored) : "(missing ciphertext)"}`);
    }
  });

function printReport(r: SleepReport): void {
  err(
    `\n${r.consolidated.length} consolidated · ${r.failed.length} failed · ${r.remaining} remaining · ${r.summaries.length} summaries · ${r.changed.length} files changed`,
  );
  for (const w of r.warnings) err(`⚠ ${w}`);
}

function commitMessage(r: SleepReport): string {
  const lines = r.consolidated.map((c) => {
    const bits = [
      c.touched.length ? `touched ${c.touched.join(", ")}` : "nothing durable",
      c.created.length ? `new ${c.created.join(", ")}` : "",
      c.facts.some((f) => f.decision === "dispute") ? "⚖ dispute" : "",
      c.quests.length ? c.quests.join("; ") : "",
    ].filter(Boolean);
    return `- ${c.id} (${c.agent}): ${bits.join(" · ")}`;
  });
  return [
    `chore(sleep): consolidate ${r.consolidated.length} episode${r.consolidated.length === 1 ? "" : "s"}`,
    "",
    ...r.rulings.map((x) => `- ruling: ${x}`),
    ...lines,
    ...r.failed.map((f) => `- ✗ ${f.id}: ${f.error.slice(0, 120)}`),
    "",
    `model: ${r.model}`,
  ].join("\n");
}

program.parseAsync().catch((e: unknown) => {
  err(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
