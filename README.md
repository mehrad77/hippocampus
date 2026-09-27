# 🧠 Hippocampus

Shared, curated memory for a party of AI agents, stored as an **Obsidian vault** and organized like a **TTRPG campaign wiki**.

Agents don't dump memory and read it back. They submit *episodes* (raw memories) to an inbox. Hippocampus **sleeps**: it consolidates episodes into canon, links entities into a graph, and keeps facts honest with lane authority, rumor/canon status, and disputes for the human to rule on. It is episodic memory turned into semantic memory, like the real hippocampus.

## Two repos: public tool, private memory

```
  this repo (PUBLIC)                         your vault (PRIVATE GitHub repo, open in Obsidian)
  ──────────────────                         ─────────────────────────────────────────────────
  code · template · fictional seeds          HANDBOOK.md · quests/ · characters/ · chronicle/
  published as @mehrad77/hippocampus  ──►    inbox/<agent>/*.md   ◄── agents (GitHub or MCP)
                                             nightly `hippo sleep`: pull → curate → commit → push
```

The vault uses the tool, and the tool never knows about any vault. Your memory never enters this repo.

## Quick start

Requires Node 24+ and git.

Create a vault (omit `--seed` for an empty one, or pass your own seed directory):

```bash
npx @mehrad77/hippocampus init ~/vaults/my-campaign --seed example-relocation
```

Create a key for secret facts:

```bash
npx @mehrad77/hippocampus -v ~/vaults/my-campaign secrets keygen
```

Push the vault to a **private** GitHub repo, open it in Obsidian, and point your agents at `HANDBOOK.md`. Then run the curator nightly (here with LM Studio; `ollama`, `anthropic`, and `xai` also work):

```bash
HIPPO_LLM_PROVIDER=lmstudio HIPPO_LLM_MODEL=google/gemma-4-26b-a4b-qat npx @mehrad77/hippocampus@0.1 -v ~/vaults/my-campaign sleep
```

The full guide, [docs/USAGE.md](docs/USAGE.md), covers connecting agents, scheduling, the daily review, disputes, upgrades, and vault CI.

## MCP tools

For local agents, `hippo serve --agent <id>` (stdio) or `hippo serve --http <port>` provides:

| Tool | Purpose |
| --- | --- |
| `onboard` | Who you are (lane, authority, quests), plus the handbook |
| `remember` | Queue an episode (fast, never blocks on the LLM) |
| `recall` | Search entities, with graph neighbors and pending episodes |
| `get` / `neighbors` | Full entity note / graph walk |
| `ask_canon` | The canonical answer to a factual question, with status and disputes |
| `briefing` | "Previously on…": chronicle, changes, upcoming deadlines, disputes |
| `update_quest` | Objectives, status, clocks, deadline, owner |

## How facts stay honest

- Every fact has a status: `canon` / `rumor` / `disputed` / `retconned`.
- An agent is **authoritative** for entities tagged with its `authority` domains (`party/<id>.md`). There its word is canon immediately. Elsewhere it's a rumor until another agent corroborates it.
- Precedence is **human > lane authority > corroboration > recency**. A source may correct its own earlier report.
- Contradictions between peers, or against the human, open `disputes/<…>.md`. Set `ruling:` there and the next sleep makes it canon.
- Secret fields are age-encrypted to `secrets/<entity>/<field>.age`. The note only holds `secret://…`, and the curator can encrypt but never decrypt.

## Contributing

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm typecheck
```

| Path | What |
| --- | --- |
| `packages/core` | Schemas, markdown and managed regions, vault model, reconcile rules, search, handbook, service, secrets, migrations |
| `packages/curator` | LLM adapter (AI SDK) and the sleep pipeline |
| `packages/mcp` | MCP tools and resources |
| `apps/cli` | The `hippo` CLI, published as `@mehrad77/hippocampus` |
| `vault-template/` | What `hippo init` copies |
| `seeds/example-relocation/` | Fictional example campaign |

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/DEVELOPING.md](docs/DEVELOPING.md) (developing against your own private vault without leaking it). Coding agents: see [AGENTS.md](AGENTS.md). Architecture: [DESIGN.md](DESIGN.md).

## License

[AGPL-3.0](LICENSE)
