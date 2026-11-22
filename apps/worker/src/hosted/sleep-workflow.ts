// The nightly sleep workflow the hosted app writes into a vault repo. Kept free of imports, so
// scripts/lint-workflows.mjs can load it with plain Node and run actionlint on exactly what ships.

export const SLEEP_WORKFLOW_PATH = ".github/workflows/sleep.yml";

/** What the app bakes into a vault's workflow. Neither is secret: the curator key authenticates. */
export interface SleepWorkflowOptions {
  /** The vault's own MCP address. */
  mcpUrl: string;
  /** The model that curates (sonnet, opus). */
  model: string;
}

/** Only what's safe inside the workflow's quoted YAML and JSON: an http(s) URL without quotes, spaces, braces or `$`. */
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.:\-]+(?:\/[A-Za-z0-9._~\-]+)*$/;
const SAFE_MODEL = /^[a-z0-9][a-z0-9.\-]{0,62}$/;

/** The model a workflow text was rendered with; undefined for one written by hand or before models were baked in. */
export const bakedModel = (text: string) => /HIPPO_CURATOR_MODEL \|\| '([a-z0-9.\-]+)'/.exec(text)?.[1];
/** The MCP address a workflow text was rendered with. */
export const bakedMcpUrl = (text: string) => /vars\.HIPPO_MCP_URL \|\| '([^']+)'/.exec(text)?.[1];

/**
 * The workflow for one vault. The repo's variables HIPPO_MCP_URL and HIPPO_CURATOR_MODEL, when set
 * (by hand), win over the baked values, so repos set up with `gh variable set` keep working.
 */
export function sleepWorkflow(o: SleepWorkflowOptions): string {
  if (!SAFE_URL.test(o.mcpUrl)) throw new Error(`sleepWorkflow: not a plain http(s) URL: ${o.mcpUrl}`);
  if (!SAFE_MODEL.test(o.model)) throw new Error(`sleepWorkflow: not a model name: ${o.model}`);
  const model = `\${{ vars.HIPPO_CURATOR_MODEL || '${o.model}' }}`;
  const url = `\${{ vars.HIPPO_MCP_URL || '${o.mcpUrl}' }}`;
  return `# Nightly sleep for this Hippocampus vault: Claude consolidates the inbox into notes, working only
# through the vault's MCP server with a curator key. It doesn't check out this repo.
# Added by the hosted app; turn it off on the dashboard's setup page, which removes this file.
#
# It needs, under Settings → Secrets and variables → Actions in this repo (the dashboard's
# Setup → Nightly curation sets them for you):
#   Secret    CLAUDE_CODE_OAUTH_TOKEN  a Claude subscription's token (run: claude setup-token), or
#   Secret    ANTHROPIC_API_KEY     an Anthropic API key (runs are billed to it); with both, the token wins
#   Secret    HIPPO_CURATOR_KEY     a curator key: dashboard → Setup → Nightly curation
# The vault's MCP address and the model are written below; the variables HIPPO_MCP_URL and
# HIPPO_CURATOR_MODEL, if you set them, take their place.
# Curating shows the model every new memory in full: secret ones in plain text, and confidential details.
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
    # A run takes up to 100 episodes; one cut off by the timeout leaves the rest in the inbox for tomorrow.
    timeout-minutes: 120
    steps:
      - uses: anthropics/claude-code-action@v1
        id: claude
        with:
          # A Claude subscription's token, else an API key. Claude Code prefers an API key it's given,
          # so the key goes in only without a token: a stale key can't shadow the subscription.
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          anthropic_api_key: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN == '' && secrets.ANTHROPIC_API_KEY || '' }}
          # A token without permissions, so the action doesn't ask for one of its own.
          github_token: \${{ github.token }}
          # The app commits this file, so scheduled runs start as its bot, which the action refuses
          # by default. Any bot is fine here: only the schedule and a dispatch start a run, and no
          # event text reaches the prompt.
          allowed_bots: "*"
          prompt: |
            You are the curator of a Hippocampus memory vault. Run tonight's sleep using only the
            hippocampus MCP tools. If sleep_status shows a run already open, stop. Otherwise call
            sleep_start with model "${model}", follow the procedure it
            returns, and answer its questions with sleep_answer (or sleep_skip for an episode you
            can't place) until the state is "done". Never repeat a secret value or a confidential
            detail outside the answers that ask for it.
          claude_args: >-
            --model ${model}
            --mcp-config '{"mcpServers":{"hippocampus":{"type":"http","url":"${url}","headers":{"Authorization":"Bearer \${{ secrets.HIPPO_CURATOR_KEY }}"}}}}'
            --allowedTools "mcp__hippocampus__*"
      # Why a run failed ("Credit balance is too low", say): only the final result's text. The rest of
      # the execution file holds tool results, which are vault content, so none of it is printed.
      - name: Say why it failed
        if: failure() && steps.claude.outputs.execution_file != ''
        env:
          EXECUTION_FILE: \${{ steps.claude.outputs.execution_file }}
        run: |
          if [ -f "$EXECUTION_FILE" ]; then
            jq -r 'last | select(.type == "result") | .result // empty' "$EXECUTION_FILE" | head -c 2000
          fi
`;
}

/** An example vault's address, for linting and tests: what ships differs only in the baked values. */
export const EXAMPLE_MCP_URL = "https://hippocampus.example/mcp/01J9Z8D3M0V000000000000001";

/** The workflow as an example vault gets it, with the default model. */
export const SLEEP_WORKFLOW = sleepWorkflow({ mcpUrl: EXAMPLE_MCP_URL, model: "sonnet" });
