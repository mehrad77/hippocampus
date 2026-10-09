import {
  ACTOR_TRAILER,
  CONFIG_PATH,
  CURATOR_RULES_PATH,
  VaultError,
  actorTrailer,
  assertVaultVersion,
  buildVaultFiles,
  parseConfig,
  validateVaultSettings,
  withTrailers,
  type Change,
  type CommitMeta,
  type VaultSettings,
} from "@hippocampus/core";
import { HttpError } from "@hippocampus/dashboard";
import { GitHubStore } from "@hippocampus/store-github";
import { SEEDS, TEMPLATE } from "@hippocampus/template";
import { GitHubAppError, type GitHubApp, type Permissions } from "./github-app.ts";
import type { Registry, VaultRecord } from "./registry.ts";

// Turning a person's repo into their vault, through the GitHub API (the Worker has no filesystem).

/** What the vault's token may do: write notes and the vault's CI workflow, and nothing else. */
export const VAULT_PERMISSIONS: Permissions = { contents: "write", workflows: "write", metadata: "read" };

/** The files that tell agents and CI the vault's rules. Adopting an existing vault adds whichever are missing. */
export const GUARDRAIL_FILES = ["AGENTS.md", "CLAUDE.md", CURATOR_RULES_PATH, ".github/workflows/validate.yml"];

/** What GitHub's "new repository" form can add. A repo with only these is as good as empty. */
const GITHUB_STARTERS = new Set(["README.md", "LICENSE", ".gitignore"]);

export const BOOTSTRAP_AUTHOR = { name: "Hippocampus", email: "hippocampus@users.noreply.github.com" };

/** A commit by the hosted app itself. `[skip ci]`: the vault's own workflow arrives in these commits and needn't validate the template. */
export const bootstrapCommit = (message: string): CommitMeta => ({
  message: withTrailers(`${message} [skip ci]`, { [ACTOR_TRAILER]: actorTrailer({ kind: "bootstrap" }) }),
  author: BOOTSTRAP_AUTHOR,
});

export type Plan = { mode: "initialize" } | { mode: "adopt"; missing: string[] } | { mode: "refuse" };

/**
 * What to do with a repo that has commits, from its file list: adopt an existing vault (only its
 * missing guardrail files), initialize over GitHub's starter files, or refuse anything else.
 */
export function plan(paths: string[]): Plan {
  if (paths.includes(CONFIG_PATH)) return { mode: "adopt", missing: GUARDRAIL_FILES.filter((p) => !paths.includes(p)) };
  if (paths.every((p) => GITHUB_STARTERS.has(p))) return { mode: "initialize" };
  return { mode: "refuse" };
}

export interface BootstrapOptions {
  app: GitHubApp;
  registry: Registry;
  accountId: number;
  installationId: number;
  /** The repo picked; `branch` defaults to `main` (an empty repo's first commit creates it). */
  repo: { id: number; fullName: string; branch?: string };
  settings: VaultSettings;
  /** An example campaign laid over the template (`example-relocation`). */
  seed?: string;
  /** The vault's clock while building, for reproducible output. */
  now?: Date;
}

export interface BootstrapResult {
  vault: VaultRecord;
  mode: "initialized" | "adopted";
  /** A disconnected vault on another repo that this one replaced. */
  replaced?: string;
}

/**
 * Make the repo the account's vault. Every check that can refuse runs before anything is
 * written or registered; after that the vault row is `bootstrapping` until the commit lands
 * (`ready`), or `disconnected` (`bootstrap_failed`) so a retry can pick it up again.
 */
export async function bootstrapVault(o: BootstrapOptions): Promise<BootstrapResult> {
  try {
    validateVaultSettings(o.settings);
  } catch (err) {
    throw new HttpError(400, (err as Error).message, "INVALID");
  }
  const seed = o.seed === undefined ? undefined : SEEDS[o.seed];
  if (o.seed !== undefined && !seed) throw new HttpError(400, `seed: unknown "${o.seed}"; choose from ${Object.keys(SEEDS).join(", ")}`, "INVALID");

  const name = o.repo.fullName;
  const token = o.app.tokenSource(o.installationId, { repositoryIds: [o.repo.id], permissions: VAULT_PERMISSIONS });
  // Mint now, so a missing permission is explained before anything else happens.
  await token().catch((err: unknown) => {
    throw explain(err, name);
  });
  const store = new GitHubStore({ repo: name, branch: o.repo.branch, token, fetch: o.app.fetch, apiUrl: o.app.apiUrl });
  const info = await store.info();
  if (info.id !== o.repo.id) throw new HttpError(409, `${name} is no longer the repo you picked; pick it again.`, "REPO_CHANGED");
  if (!info.private)
    throw new HttpError(400, `${info.fullName} is public: anyone could read this memory. Make it private on GitHub (Settings → Danger Zone → Change visibility), then try again.`, "PUBLIC_REPO");

  const p = info.empty ? ({ mode: "initialize" } as const) : plan(await store.list());
  if (p.mode === "refuse") throw new HttpError(409, `${info.fullName} already has files; pick an empty repo (or one with only a README, LICENSE or .gitignore).`, "NOT_EMPTY");
  if (p.mode === "adopt") {
    try {
      assertVaultVersion(parseConfig(await store.read(CONFIG_PATH)));
    } catch (err) {
      throw new HttpError(409, `${info.fullName} has a ${CONFIG_PATH} that doesn't load: ${(err as Error).message}`, "BAD_VAULT");
    }
  }
  const files = p.mode === "initialize" ? await buildVaultFiles(TEMPLATE, { ...o.settings, seed, now: o.now }) : undefined;

  const { vault, replaced } = await o.registry.claimVault({ accountId: o.accountId, installationId: o.installationId, repoId: info.id, fullName: info.fullName, branch: info.branch });
  try {
    if (files) await store.initialize(files, bootstrapCommit("chore: initialize Hippocampus vault"));
    else if (p.mode === "adopt") {
      const changes: Change[] = p.missing.map((path) => ({ path, content: TEMPLATE[path]! }));
      await store.apply(changes, bootstrapCommit("chore: add Hippocampus guardrail files"));
    }
  } catch (err) {
    await o.registry.setVaultStatus(vault.id, "disconnected", "bootstrap_failed");
    throw explain(err, info.fullName);
  }
  const ready = (await o.registry.setVaultStatus(vault.id, "ready"))!;
  return { vault: ready, mode: files ? "initialized" : "adopted", ...(replaced ? { replaced } : {}) };
}

/** GitHub's refusals, in words that say what to do about them. */
export function explain(err: unknown, repo: string): unknown {
  const fix = "On GitHub, open Settings → Applications → Installed GitHub Apps → Hippocampus, accept any pending permission request (it needs Contents and Workflows: read and write)";
  if (err instanceof GitHubAppError && err.status === 422) return new HttpError(403, `The app can't get write access to ${repo}. ${fix}, and make sure ${repo} is one of its repositories.`, "APP_PERMISSIONS");
  if (err instanceof GitHubAppError && err.status === 404) return new HttpError(409, "The app isn't installed there anymore. Install it again from the setup page.", "NO_INSTALLATION");
  if (err instanceof VaultError && /\bworkflow/i.test(err.message)) return new HttpError(403, `The app may not write ${repo}'s workflow files. ${fix}.`, "APP_PERMISSIONS");
  return err;
}
