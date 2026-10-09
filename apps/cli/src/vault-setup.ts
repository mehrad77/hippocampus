import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CONFIG_PATH, applyChanges, buildVaultFiles, generateKeyPair, parseConfig, renderConfig, validateVaultSettings, type VaultStore } from "@hippocampus/core";
import { identityToRecipient } from "age-encryption";
import { parseDocument } from "yaml";
import { Git } from "./git.ts";
import { expandHome } from "./paths.ts";

// The checks live in core so the hosted setup validates the same way; the local setup imports them from here.
export { SLUG, validTimezone } from "@hippocampus/core";

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
  const settings = { campaign: opts.campaign, human: opts.human, timezone: opts.timezone, domains: opts.domains };
  validateVaultSettings(settings);

  let seed: string | undefined;
  if (opts.seed) {
    const bundled = join(opts.assets, "seeds", opts.seed);
    seed = existsSync(bundled) ? bundled : resolve(expandHome(opts.seed));
    if (!existsSync(seed)) throw new Error(`no seed "${opts.seed}" (neither ${bundled} nor a directory path)`);
  }

  const files = await readTree(join(opts.assets, "vault-template"));
  // Published packages carry the template's .gitignore as `gitignore` (npm strips dotfile ignores).
  const gitignore = files.get("gitignore");
  if (gitignore) {
    files.set(".gitignore", gitignore);
    files.delete("gitignore");
  }
  if (seed) for (const [path, content] of await readTree(seed)) files.set(path, content);
  const { text, binary } = splitText(files);
  const built = await buildVaultFiles(text, settings);

  await mkdir(target, { recursive: true });
  for (const [path, content] of [...Object.entries(built), ...binary]) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await writeFile(join(target, path), content);
  }
  const git = new Git(target);
  if (!git.isRepo()) await git.run("init", "--quiet", "-b", "main");
  const config = parseConfig(built[CONFIG_PATH]);
  return { dir: target, campaign: config.campaign, human: config.human };
}

/** Every file under `dir` by forward-slash relative path, except a `.git` the folder may carry. */
async function readTree(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) out.set(path, await readFile(join(dir, path)));
    }
  };
  await walk("");
  return out;
}

/** The vault is built from text; anything else a seed brings (images, PDFs) is copied as is. */
function splitText(files: Map<string, Buffer>): { text: Record<string, string>; binary: [string, Buffer][] } {
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const text: Record<string, string> = {};
  const binary: [string, Buffer][] = [];
  for (const [path, bytes] of files) {
    try {
      text[path] = utf8.decode(bytes);
    } catch {
      binary.push([path, bytes]);
    }
  }
  return { text, binary };
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
