import { StoreConflictError } from "@hippocampus/core";
import { HttpError, type HostedCuratorActionsResult } from "@hippocampus/dashboard";
import { GitHubStore } from "@hippocampus/store-github";
import { VAULT_PERMISSIONS, bootstrapCommit, explain } from "./bootstrap.ts";
import type { GitHubApp, Permissions } from "./github-app.ts";
import type { VaultRecord } from "./registry.ts";
import { SLEEP_WORKFLOW, SLEEP_WORKFLOW_PATH } from "./sleep-workflow.ts";

// The vault's nightly sleep on GitHub Actions, for people without an agent of their own to run it:
// a workflow in their vault repo that has Claude curate through the vault's MCP server. It never
// checks the repo out, and its GitHub token can't read it: Claude sees only what the curator key shows.

export { SLEEP_WORKFLOW, SLEEP_WORKFLOW_PATH };

const READ_ONLY: Permissions = { metadata: "read", contents: "read" };

function store(app: GitHubApp, vault: VaultRecord, permissions: Permissions): GitHubStore {
  const token = app.tokenSource(vault.installationId, { repositoryIds: [vault.repoId], permissions });
  return new GitHubStore({ repo: vault.fullName, branch: vault.branch, token, fetch: app.fetch, apiUrl: app.apiUrl });
}

/** Whether the vault repo has the workflow. */
export async function curatorActionsEnabled(app: GitHubApp, vault: VaultRecord): Promise<boolean> {
  return (await store(app, vault, READ_ONLY).read(SLEEP_WORKFLOW_PATH)) !== undefined;
}

/** Add (or bring up to date) or remove the workflow. Writing a workflow needs the app's Workflows permission. */
export async function setCuratorActions(app: GitHubApp, vault: VaultRecord, enable: boolean): Promise<HostedCuratorActionsResult> {
  const s = store(app, vault, VAULT_PERMISSIONS);
  try {
    const current = await s.read(SLEEP_WORKFLOW_PATH);
    if (enable && current !== SLEEP_WORKFLOW)
      await s.apply(
        [{ path: SLEEP_WORKFLOW_PATH, content: SLEEP_WORKFLOW }],
        bootstrapCommit(current === undefined ? "chore: run sleep nightly on GitHub Actions" : "chore: update the nightly sleep workflow"),
      );
    if (!enable && current !== undefined) await s.apply([{ path: SLEEP_WORKFLOW_PATH, remove: true }], bootstrapCommit("chore: stop running sleep on GitHub Actions"));
  } catch (err) {
    if (err instanceof StoreConflictError) throw new HttpError(409, "The workflow changed on GitHub just now; try again.", "CONFLICT");
    throw explain(err, vault.fullName);
  }
  return { enabled: enable, path: SLEEP_WORKFLOW_PATH };
}
