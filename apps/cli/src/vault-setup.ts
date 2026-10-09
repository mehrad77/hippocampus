import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CONFIG_PATH, HANDBOOK_PATH, Vault, applyChanges, generateKeyPair, parseDoc, renderDoc, renderHandbook, type VaultStore } from "@hippocampus/core";
import { FsStore } from "@hippocampus/core/node";
import { identityToRecipient } from "age-encryption";
import { parseDocument } from "yaml";
import { Git } from "./git.ts";
import { expandHome } from "./paths.ts";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface InitVaultOptions {
  target: string;
  /** A bundled seed name (from `<assets>/seeds`) or a directory path. */
  seed?: string;
  /** Where `vault-template/` and `seeds/` live (see `assetRoot`). */
  assets: string;
  campaign?: string;
  human?: string;
  timezone?: string;
  domains?: string[];
}

/** Entries a fresh `git clone` of an empty repo (or Finder) leaves behind; anything else means the folder is in use. */
const HARMLESS = new Set([".git", ".DS_Store"]);

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A checkout of the Hippocampus tool itself (public), where a vault (private) must never be created. */
function toolCheckout(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "vault-template")) && existsSync(join(d, "apps", "cli", "package.json"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
};

/** Create a vault from the template (and optionally a seed), with the campaign settings filled in. */
export async function initVault(opts: InitVaultOptions): Promise<{ dir: string; campaign: string; human: string }> {
  const target = resolve(expandHome(opts.target));
  if (existsSync(join(target, CONFIG_PATH))) throw new Error(`${target} already has ${CONFIG_PATH}`);
  const tool = toolCheckout(target) ?? (inside(target, resolve(opts.assets)) ? resolve(opts.assets) : undefined);
  // The checkout's gitignored /vault/ and /vaults/ are the one safe place for a vault inside it.
  if (tool && !/^vaults?([\\/]|$)/.test(relative(tool, target)))
    throw new Error(`${target} is inside the Hippocampus tool's own folder; a vault is private, put it somewhere else (e.g. ~/vaults/<name>)`);
  if (existsSync(target)) {
    const entries = (await readdir(target)).filter((e) => !HARMLESS.has(e));
    if (entries.length) throw new Error(`${target} is not empty; choose a new or empty folder`);
  }
  if (opts.human !== undefined && !SLUG.test(opts.human)) throw new Error(`human "${opts.human}" must be an id: lowercase letters, digits and dashes`);
  if (opts.timezone !== undefined && !validTimezone(opts.timezone)) throw new Error(`unknown timezone "${opts.timezone}" (use an IANA name like Europe/Lisbon)`);
  for (const d of opts.domains ?? []) if (!SLUG.test(d)) throw new Error(`domain "${d}" must be lowercase letters, digits and dashes`);

  let seed: string | undefined;
  if (opts.seed) {
    const bundled = join(opts.assets, "seeds", opts.seed);
    seed = existsSync(bundled) ? bundled : resolve(expandHome(opts.seed));
    if (!existsSync(seed)) throw new Error(`no seed "${opts.seed}" (neither ${bundled} nor a directory path)`);
  }

  await mkdir(target, { recursive: true });
  await cp(join(opts.assets, "vault-template"), target, { recursive: true });
  // Published packages carry the template's .gitignore as `gitignore` (npm strips dotfile ignores).
  if (existsSync(join(target, "gitignore"))) await rename(join(target, "gitignore"), join(target, ".gitignore"));
  if (seed) await cp(seed, target, { recursive: true, force: true });

  const store = new FsStore(target);
  await patchConfig(store, opts);
  await placePlayerCharacter(store);

  const vault = await Vault.load(store);
  for (const e of vault.entities.values()) vault.markDirty(e);
  vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
  await vault.flush();
  const git = new Git(target);
  if (!git.isRepo()) await git.run("init", "--quiet", "-b", "main");
  return { dir: target, campaign: vault.config.campaign, human: vault.config.human };
}

/** Set the given settings in `_hippo/config.yaml`, keeping its comments and layout. */
async function patchConfig(store: VaultStore, opts: InitVaultOptions): Promise<void> {
  const raw = await store.read(CONFIG_PATH);
  if (raw === undefined) throw new Error(`the template has no ${CONFIG_PATH}`);
  const doc = parseDocument(raw);
  if (opts.campaign !== undefined) doc.set("campaign", opts.campaign);
  if (opts.human !== undefined) doc.set("human", opts.human);
  if (opts.timezone !== undefined) doc.set("timezone", opts.timezone);
  if (opts.domains !== undefined) doc.set("domains", doc.createNode(opts.domains, { flow: true }));
  await store.write(CONFIG_PATH, renderConfig(doc));
}

/** No line folding, so the template's one-line flow maps and lists stay on one line. */
const renderConfig = (doc: ReturnType<typeof parseDocument>) => doc.toString({ lineWidth: 0, flowCollectionPadding: false });

const titleCase = (id: string) => id.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => `${dash ? " " : ""}${c.toUpperCase()}`).replace(/-/g, " ");

/**
 * The template's placeholder PC is `characters/player.md`. When the human has another id, it
 * becomes theirs (`characters/<human>.md`), unless a seed already brought the human's own note.
 */
async function placePlayerCharacter(store: VaultStore): Promise<void> {
  const PC = "characters/player.md";
  const vault = await Vault.load(store);
  const human = vault.config.human;
  const pc = await store.read(PC);
  if (human === "player" || pc === undefined) return;
  if (vault.entities.has(human)) {
    await store.remove(PC);
    return;
  }
  const { data, body } = parseDoc(pc);
  await store.write(`characters/${human}.md`, renderDoc({ ...data, title: titleCase(human) }, body));
  await store.remove(PC);
}

export interface KeygenResult {
  identityFile: string;
  recipient: string;
  /** False when an existing identity was reused. */
  created: boolean;
}

/**
 * Create an age identity and set its recipient in the vault config. An existing identity is never
 * overwritten: it is reused (its recipient derived from it) only when asked to.
 */
export async function keygen(opts: { store: VaultStore; identityFile: string; reuseExisting?: boolean }): Promise<KeygenResult> {
  const config = await opts.store.read(CONFIG_PATH);
  if (config === undefined) throw new Error(`no ${CONFIG_PATH} here; is this a vault?`);
  let recipient: string;
  let created = false;
  if (existsSync(opts.identityFile)) {
    if (!opts.reuseExisting) throw new IdentityExistsError(opts.identityFile);
    const identity = (await readFile(opts.identityFile, "utf8")).trim();
    recipient = await identityToRecipient(identity);
  } else {
    const pair = await generateKeyPair();
    await mkdir(dirname(opts.identityFile), { recursive: true, mode: 0o700 });
    await writeFile(opts.identityFile, `${pair.identity}\n`, { mode: 0o600, flag: "wx" });
    await chmod(opts.identityFile, 0o600);
    recipient = pair.recipient;
    created = true;
  }
  const doc = parseDocument(config);
  if (doc.getIn(["secrets", "recipient"]) !== recipient) {
    doc.setIn(["secrets", "recipient"], recipient);
    await applyChanges(opts.store, [{ path: CONFIG_PATH, content: renderConfig(doc) }], { message: "chore: set the secrets recipient" });
  }
  return { identityFile: opts.identityFile, recipient, created };
}

export class IdentityExistsError extends Error {
  constructor(readonly file: string) {
    super(`${file} already exists; refusing to overwrite (reuse it instead)`);
  }
}

/** The recipient of the identity on this machine, if there is one. */
export async function localRecipient(file: string): Promise<string | undefined> {
  if (!existsSync(file)) return undefined;
  try {
    return await identityToRecipient((await readFile(file, "utf8")).trim());
  } catch {
    return undefined;
  }
}
