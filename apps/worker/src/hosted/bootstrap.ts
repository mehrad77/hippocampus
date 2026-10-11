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
  vaultVersionStatus,
  withTrailers,
  type Change,
  type CommitMeta,
  type VaultSettings,
} from "@hippocampus/core";
import { HttpError } from "@hippocampus/dashboard";
import { GitHubStore } from "@hippocampus/store-github";
import { GitLabStore } from "@hippocampus/store-gitlab";
import { PRESETS, SEEDS, TEMPLATE } from "@hippocampus/template";
import { GitHubAppError, type GitHubApp, type Permissions } from "./github-app.ts";
import { GitLabAuthError, type GitLabAccess } from "./gitlab.ts";
import type { Provider, Registry, VaultRecord } from "./registry.ts";

// Turning a person's repo into their vault, through the host's API (the Worker has no filesystem):
// the GitHub API with the app's installation token, or the GitLab API with the person's connection.

/** What the vault's token may do: write notes and the vault's CI workflow, and nothing else. */
export const VAULT_PERMISSIONS: Permissions = { contents: "write", workflows: "write", metadata: "read" };

/** The files that tell agents and CI the vault's rules. Adopting an existing vault adds whichever are missing. */
export const GUARDRAIL_FILES = ["AGENTS.md", "CLAUDE.md", CURATOR_RULES_PATH, ".github/workflows/validate.yml"];

/** GitLab vaults get no GitHub Actions workflow: it would sit there doing nothing. */
const guardrails = (provider: Provider) => (provider === "gitlab" ? GUARDRAIL_FILES.filter((p) => !p.startsWith(".github/")) : GUARDRAIL_FILES);

/** What GitHub's "new repository" form can add. A repo with only these is as good as empty. */
const GITHUB_STARTERS = new Set(["README.md", "LICENSE", ".gitignore"]);

export const BOOTSTRAP_AUTHOR = { name: "Hippocampus", email: "hippocampus@users.noreply.github.com" };

/** A commit by the hosted app itself. `[skip ci]`: the vault's own workflow arrives in these commits and needn't validate the template. */
export const bootstrapCommit = (message: string): CommitMeta => ({
  message: withTrailers(`${message} [skip ci]`, { [ACTOR_TRAILER]: actorTrailer({ kind: "bootstrap" }) }),
  author: BOOTSTRAP_AUTHOR,
});

/**
 * The commit that brings a vault to format `version`, made when the owner clicks Upgrade on the hosted dashboard for an older
 * vault. No `[skip ci]`: the vault's own CI validates the migrated tree.
 */
export const migrationCommit = (version: number): CommitMeta => ({
  message: withTrailers(`chore: migrate vault to format v${version}`, { [ACTOR_TRAILER]: actorTrailer({ kind: "migration" }) }),
  author: BOOTSTRAP_AUTHOR,
});

export type Plan = { mode: "initialize" } | { mode: "adopt"; missing: string[] } | { mode: "refuse" };

/**
 * What to do with a repo that has commits, from its file list: adopt an existing vault (only its
 * missing guardrail files), initialize over GitHub's starter files, or refuse anything else.
 */
export function plan(paths: string[], provider: Provider = "github"): Plan {
  if (paths.includes(CONFIG_PATH)) return { mode: "adopt", missing: guardrails(provider).filter((p) => !paths.includes(p)) };
  if (paths.every((p) => GITHUB_STARTERS.has(p))) return { mode: "initialize" };
  return { mode: "refuse" };
}

export interface BootstrapOptions {
  /** GitHub: the app, and the installation the repo was picked from. */
  app?: GitHubApp;
  installationId?: number;
  /** GitLab: the account's connection. Set this instead of `app` and `installationId`. */
  gitlab?: GitLabAccess;
  registry: Registry;
  accountId: number;
  /** The repo picked; `branch` defaults to `main` (an empty repo's first commit creates it). */
  repo: { id: number; fullName: string; branch?: string };
  settings: VaultSettings;
  /** An example campaign laid over the template (`example-relocation`). */
  seed?: string;
  /** Presets added to a new vault, in order (names of `PRESETS`). Refused for a repo that already holds a vault. */
  presets?: string[];
  /** The vault's clock while building, for reproducible output. */
  now?: Date;
}

/** What bootstrapping needs of a store; both hosts' stores fit. */
interface BootstrapStore {
  info(): Promise<{ id: number; fullName: string; private: boolean; empty: boolean; branch: string }>;
  list(): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  initialize(files: Record<string, string>, meta: CommitMeta): Promise<void>;
  apply(changes: Change[], meta: CommitMeta): Promise<void>;
}

/** The host-specific part of bootstrapping: the store, a first token check, how to word refusals. */
interface Target {
  provider: Provider;
  installationId: number;
  store: BootstrapStore;
  /** Gets a token now, so a missing permission is explained before anything else happens. */
  preflight(): Promise<void>;
  explain(err: unknown, repo: string): unknown;
  publicHelp: string;
}

function target(o: BootstrapOptions): Target {
  const name = o.repo.fullName;
  if (o.gitlab) {
    const access = o.gitlab;
    const token = access.tokenFor(o.accountId);
    return {
      provider: "gitlab",
      installationId: 0,
      store: new GitLabStore({ project: o.repo.id, branch: o.repo.branch, token, fetch: access.fetch, apiUrl: access.client.apiUrl }),
      preflight: async () => void (await token().catch((err: unknown) => {
        throw explainGitLab(err, name);
      })),
      explain: explainGitLab,
      publicHelp: "Make it private on GitLab (Settings → General → Visibility, project features, permissions → Project visibility: Private), then try again. Internal isn't enough: every signed-in user of the instance could read it.",
    };
  }
  if (!o.app || o.installationId === undefined) throw new Error("bootstrapVault needs the GitHub app and installation, or a GitLab connection");
  const { app, installationId } = o;
  const token = app.tokenSource(installationId, { repositoryIds: [o.repo.id], permissions: VAULT_PERMISSIONS });
  return {
    provider: "github",
    installationId,
    store: new GitHubStore({ repo: name, branch: o.repo.branch, token, fetch: app.fetch, apiUrl: app.apiUrl }),
    preflight: async () => void (await token().catch((err: unknown) => {
      throw explain(err, name);
    })),
    explain,
    publicHelp: "Make it private on GitHub (Settings → Danger Zone → Change visibility), then try again.",
  };
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
  const seed = o.seed === undefined || !Object.hasOwn(SEEDS, o.seed) ? undefined : SEEDS[o.seed];
  if (o.seed !== undefined && !seed) throw new HttpError(400, `seed: unknown "${o.seed}"; choose from ${Object.keys(SEEDS).join(", ")}`, "INVALID");

  const unknown = o.presets?.find((n) => !Object.hasOwn(PRESETS, n));
  if (unknown !== undefined) throw new HttpError(400, `presets: unknown "${unknown}"; choose from ${Object.keys(PRESETS).sort().join(", ")}`, "INVALID");

  const name = o.repo.fullName;
  const t = target(o);
  await t.preflight();
  const store = t.store;
  const info = await store.info().catch((err: unknown) => {
    throw t.explain(err, name);
  });
  if (info.id !== o.repo.id) throw new HttpError(409, `${name} is no longer the repo you picked; pick it again.`, "REPO_CHANGED");
  if (!info.private) throw new HttpError(400, `${info.fullName} is ${t.provider === "gitlab" ? "not private" : "public"}: anyone could read this memory. ${t.publicHelp}`, "PUBLIC_REPO");

  const p = info.empty ? ({ mode: "initialize" } as const) : plan(await store.list(), t.provider);
  if (p.mode === "refuse") throw new HttpError(409, `${info.fullName} already has files; pick an empty repo (or one with only a README, LICENSE or .gitignore).`, "NOT_EMPTY");
  if (p.mode === "adopt") {
    // Presets shape a new vault; an existing one gets them from its owner (`hippo preset add`), who can review the changes.
    if (o.presets?.length)
      throw new HttpError(400, `${info.fullName} already holds a vault, and presets apply only to new vaults. Pick it again without presets, then add them with \`hippo preset add\` in a clone.`, "PRESETS_NEW_ONLY");
    try {
      // An older vault is adopted as it is and upgraded when its owner clicks Upgrade; a newer one needs a newer app.
      const config = parseConfig(await store.read(CONFIG_PATH));
      if (vaultVersionStatus(config) === "newer") assertVaultVersion(config);
    } catch (err) {
      throw new HttpError(409, `${info.fullName} has a ${CONFIG_PATH} that doesn't load: ${(err as Error).message}`, "BAD_VAULT");
    }
  }
  const built = p.mode === "initialize" ? await buildVaultFiles(TEMPLATE, { ...o.settings, seed, presets: o.presets, presetFiles: PRESETS, now: o.now }) : undefined;
  const files = built && t.provider === "gitlab" ? Object.fromEntries(Object.entries(built).filter(([path]) => !path.startsWith(".github/"))) : built;

  const { vault, replaced } = await o.registry.claimVault({ accountId: o.accountId, provider: t.provider, installationId: t.installationId, repoId: info.id, fullName: info.fullName, branch: info.branch });
  try {
    if (files) await store.initialize(files, bootstrapCommit("chore: initialize Hippocampus vault"));
    else if (p.mode === "adopt") {
      const changes: Change[] = p.missing.map((path) => ({ path, content: TEMPLATE[path]! }));
      await store.apply(changes, bootstrapCommit("chore: add Hippocampus guardrail files"));
    }
  } catch (err) {
    await o.registry.setVaultStatus(vault.id, "disconnected", "bootstrap_failed");
    throw t.explain(err, info.fullName);
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

/** GitLab's refusals, in words that say what to do about them. */
export function explainGitLab(err: unknown, project: string): unknown {
  if (err instanceof GitLabAuthError)
    return new HttpError(409, err.reason === "not_connected" ? "Connect your GitLab account first." : "GitLab no longer accepts the connection. Connect GitLab again from the setup page.", "GITLAB_RECONNECT");
  if (err instanceof VaultError && /\b403\b/.test(err.message))
    return new HttpError(
      403,
      `GitLab won't let Hippocampus write to ${project}. You need Developer access or better, and if the default branch is protected, Maintainers must be allowed to push to it (Settings → Repository → Protected branches).`,
      "GITLAB_PERMISSIONS",
    );
  return err;
}
