import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Env = Record<string, string | undefined>;

export const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

/** This module's directory: `dist/` in the published bundle, `apps/cli/src/` from source. */
const here = () => dirname(fileURLToPath(import.meta.url));

/**
 * Where `vault-template/` and `seeds/` live: next to the published package (dist/..),
 * or at the repo root when running from source.
 */
export function assetRoot(): string {
  const candidates = [resolve(here(), ".."), resolve(here(), "../../..")];
  return candidates.find((dir) => existsSync(join(dir, "vault-template"))) ?? candidates[1]!;
}

/** The published package's version (stamped at release), for pinning scheduled runs. */
export function cliVersion(): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(resolve(here(), ".."), "package.json"), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** Per-user settings: the env file, the age identity, the dashboard token, logs. */
export function configDir(env: Env = process.env): string {
  return env.HIPPO_CONFIG_DIR ? resolve(expandHome(env.HIPPO_CONFIG_DIR)) : join(homedir(), ".config", "hippocampus");
}

/** The age identity that decrypts secret facts. It never enters a vault. */
export function identityFile(env: Env = process.env): string {
  return env.HIPPO_AGE_IDENTITY_FILE ? expandHome(env.HIPPO_AGE_IDENTITY_FILE) : join(configDir(env), "age-identity.txt");
}

/** `KEY=value` settings the dashboard saves; loaded after the shell and a cwd `.env`. */
export function userEnvFile(env: Env = process.env): string {
  return join(configDir(env), "env");
}

/** The search index is a cache outside the vault, one file per vault directory or repo. */
export function indexPath(key: string, env: Env = process.env): string {
  const cache = env.XDG_CACHE_HOME ? expandHome(env.XDG_CACHE_HOME) : join(homedir(), ".cache");
  return join(cache, "hippocampus", `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.sqlite`);
}

/** The index key of a vault: its directory, or `github:<repo>`. */
export const indexKey = (vault: { dir?: string; github?: string }) => (vault.github ? `github:${vault.github}` : resolve(vault.dir ?? "."));

/**
 * The built dashboard UI: `dist/dashboard` next to the bundle when published, else the Astro
 * build in the repo when running from source. Undefined until it has been built.
 */
export function dashboardRoot(): string | undefined {
  const candidates = [join(here(), "dashboard"), resolve(here(), "../../dashboard/dist/dashboard")];
  return candidates.find((dir) => existsSync(join(dir, "index.html")));
}
