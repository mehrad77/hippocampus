import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

// The user env file (`~/.config/hippocampus/env`): plain `KEY=value` lines that `hippo` loads on
// every run, after the shell and a cwd `.env`. The dashboard edits it in place, keeping comments.

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Parse `KEY=value` lines (quotes optional, `#` comments) the way `process.loadEnvFile` reads them. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    out[m[1]!] = unquote(m[2]!);
  }
  return out;
}

function unquote(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'" || q === "`") && v.indexOf(q, 1) > 0) return v.slice(1, v.indexOf(q, 1));
  const hash = v.indexOf("#");
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

/** A value as one line `process.loadEnvFile` reads back verbatim. */
export function formatValue(key: string, value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error(`${key}: values can't contain line breaks`);
  if (/^[A-Za-z0-9_\-./:@+,=~%]*$/.test(value)) return value;
  // Single quotes are literal; double quotes would expand \n.
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  throw new Error(`${key}: the value mixes quote characters this file can't hold`);
}

export async function readEnvFile(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  return parseEnv(await readFile(path, "utf8"));
}

/**
 * Set (string) or remove (null) keys, keeping every other line, comment and the order. Written
 * atomically (temp file + rename) and readable only by you (0600), since it may hold API keys.
 */
export async function updateEnvFile(path: string, updates: Record<string, string | null | undefined>): Promise<void> {
  const pending = new Map<string, string | null>();
  for (const [k, v] of Object.entries(updates)) {
    if (!KEY.test(k)) throw new Error(`invalid setting name ${JSON.stringify(k.slice(0, 40))}`);
    if (v === undefined) continue;
    pending.set(k, v === null ? null : `${k}=${formatValue(k, v)}`);
  }
  if (!pending.size) return;
  const lines = existsSync(path) ? (await readFile(path, "utf8")).split(/\r?\n/) : ["# Hippocampus settings (written by `hippo dashboard`; edit freely)."];
  if (lines.at(-1) === "") lines.pop();
  const out: string[] = [];
  const done = new Set<string>();
  for (const line of lines) {
    const key = LINE.exec(line)?.[1];
    if (!key || !pending.has(key)) {
      out.push(line);
      continue;
    }
    // A key that appears twice keeps only its first line, updated.
    if (done.has(key)) continue;
    done.add(key);
    const next = pending.get(key);
    if (next !== null && next !== undefined) out.push(next);
  }
  for (const [k, line] of pending) if (!done.has(k) && line !== null) out.push(line);

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, `${out.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Where a setting came from. The shell beats a cwd `.env`, which beats the user env file. */
export type EnvOrigin = "shell" | "cwd" | "user";

export class EnvOrigins {
  constructor(
    private readonly shell: ReadonlySet<string>,
    private readonly cwd: ReadonlySet<string>,
  ) {}

  origin(key: string, env: Record<string, string | undefined> = process.env): EnvOrigin | undefined {
    if (this.shell.has(key)) return "shell";
    if (this.cwd.has(key)) return "cwd";
    return env[key] === undefined ? undefined : "user";
  }

  /** Of `keys`, those set by the shell or a cwd `.env`: saving them to the user env file changes nothing. */
  overriddenBy(keys: readonly string[]): string[] {
    return keys.filter((k) => this.shell.has(k) || this.cwd.has(k));
  }

  /** Mirror a saved setting into this process, unless the shell or cwd `.env` wins anyway. */
  apply(updates: Record<string, string | null | undefined>, env: Record<string, string | undefined> = process.env): void {
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined || this.shell.has(k) || this.cwd.has(k)) continue;
      if (v === null) delete env[k];
      else env[k] = v;
    }
  }
}

/**
 * Load a cwd `.env`, then the user env file. `process.loadEnvFile` never overrides a variable that
 * is already set, so precedence is shell > cwd `.env` > user env file.
 */
export function loadEnv(opts: { cwdFile?: string; userFile: () => string }): EnvOrigins {
  const shell = new Set(Object.keys(process.env));
  const cwdFile = opts.cwdFile ?? ".env";
  if (existsSync(cwdFile)) process.loadEnvFile(cwdFile);
  const cwd = new Set(Object.keys(process.env).filter((k) => !shell.has(k)));
  // Resolved after the cwd .env, which may set HIPPO_CONFIG_DIR.
  const user = opts.userFile();
  if (existsSync(user)) process.loadEnvFile(user);
  return new EnvOrigins(shell, cwd);
}
