// The nightly sleep workflow the hosted app writes into a vault repo. Kept free of imports, so
// scripts/lint-workflows.mjs can load it with plain Node and run actionlint on exactly what ships.

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
