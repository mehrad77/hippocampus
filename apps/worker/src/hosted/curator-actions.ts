import { StoreConflictError } from "@hippocampus/core";
import { HttpError, type HostedCuratorActionsResult } from "@hippocampus/dashboard";
import { GitHubStore } from "@hippocampus/store-github";
import { VAULT_PERMISSIONS, bootstrapCommit, explain } from "./bootstrap.ts";
import type { GitHubApp, Permissions } from "./github-app.ts";
import type { VaultRecord } from "./registry.ts";

// The vault's nightly sleep on GitHub Actions, for people without an agent of their own to run it:
// a workflow in their vault repo that has Claude curate through the vault's MCP server. It never
// checks the repo out, and its GitHub token can't read it: Claude sees only what the curator key shows.

export const SLEEP_WORKFLOW_PATH = ".github/workflows/sleep.yml";

export const SLEEP_WORKFLOW = `# Nightly sleep for this Hippocampus vault: Claude consolidates the inbox into notes, working only
# through the vault's MCP server with a curator key. It doesn't check out this repo.
# Added by the hosted app; turn it off on the dashboard's setup page, which removes this file.
#
# It needs, under Settings → Secrets and variables → Actions in this repo:
#   Secret    ANTHROPIC_API_KEY     an Anthropic API key (runs are billed to it)
#   Secret    HIPPO_CURATOR_KEY     a curator key: dashboard → Setup → Keys → Curator
#   Variable  HIPPO_MCP_URL         the vault's MCP URL, shown on the dashboard's setup page
#   Variable  HIPPO_CURATOR_MODEL   optional: the model that curates, like sonnet or opus (default sonnet)
# Curating shows the model every new memory in full, secret ones in plain text.
name: sleep
on:
  schedule:
    - cron: "23 3 * * *"
  workflow_dispatch:

permissions: {}

concurrency:
  group: hippocampus-sleep
  cancel-in-progress: false

jobs:
  sleep:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          # A token without permissions, so the action doesn't ask for one of its own.
          github_token: \${{ github.token }}
          prompt: |
            You are the curator of a Hippocampus memory vault. Run tonight's sleep using only the
            hippocampus MCP tools. If sleep_status shows a run already open, stop. Otherwise call
            sleep_start with model "\${{ vars.HIPPO_CURATOR_MODEL || 'sonnet' }}", follow the procedure it
            returns, and answer its questions with sleep_answer (or sleep_skip for an episode you
            can't place) until the state is "done". Never repeat a secret value outside the answers
            that ask for it.
          claude_args: >-
            --model \${{ vars.HIPPO_CURATOR_MODEL || 'sonnet' }}
            --mcp-config '{"mcpServers":{"hippocampus":{"type":"http","url":"\${{ vars.HIPPO_MCP_URL }}","headers":{"Authorization":"Bearer \${{ secrets.HIPPO_CURATOR_KEY }}"}}}}'
            --allowedTools "mcp__hippocampus__*"
`;

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
