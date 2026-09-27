# 🧠 Hippocampus

Shared, curated memory for a party of AI agents, stored as an **Obsidian vault** and organized like a **TTRPG campaign wiki**.

Agents don't dump memory and read it back. They submit *episodes* (raw memories) to an inbox. Hippocampus **sleeps**: it consolidates episodes into canon, links entities into a graph, and keeps facts honest with lane authority, rumor/canon status, and disputes for the human to rule on. It is episodic memory turned into semantic memory, like the real hippocampus.

See [DESIGN.md](DESIGN.md) for the full design.

```
agents ──(GitHub connector: write inbox/<agent>/*.md)──┐
agents ──(MCP: remember / recall / get / ask_canon …)──┤
                                                       ▼
                                  vault repo (private GitHub, Obsidian-openable)
                                                       ▲
             nightly `hippo sleep` on your machine: git pull → LLM curator (LM Studio/Ollama) → commit → push
```

## Quick start

```bash
pnpm install
```

Create a vault from the template plus the fictional example campaign (or use `--seed /path/to/your/seed`, or omit `--seed`):

```bash
./apps/cli/bin/hippo init ~/vaults/my-campaign --seed example-relocation
```

Generate an age key for secret facts. The private key stays in `~/.config/hippocampus/`:

```bash
./apps/cli/bin/hippo -v ~/vaults/my-campaign secrets keygen
```

Then push the vault to a **private** GitHub repo, open it in Obsidian (install Dataview for the dashboards), and give each agent read access plus write access to `inbox/<its-id>/`. Every agent should read `HANDBOOK.md` first.

## Nightly sleep

```bash
lms server start
```

```bash
HIPPO_LLM_PROVIDER=lmstudio HIPPO_LLM_MODEL=qwen/qwen3.5-9b ./apps/cli/bin/hippo -v ~/vaults/my-campaign sleep
```

`sleep` pulls, applies human rulings from `disputes/`, consolidates up to `curator.batch_size` episodes, and rewrites summaries. It regenerates `HANDBOOK.md` and `_hippo/review.md` (your morning review), then commits as *Hippocampus* and pushes. Episodes the model fails on stay in the inbox for the next night.

To schedule it, use [ops/com.hippocampus.sleep.plist](ops/com.hippocampus.sleep.plist) (launchd) or cron. Providers are `lmstudio`, `ollama`, `openai-compatible`, `anthropic`, and `xai` (see [.env.example](.env.example)).

## MCP (for agents that speak MCP)

Local agents use stdio, bound to one party member:

```bash
./apps/cli/bin/hippo -v ~/vaults/my-campaign serve --agent residency-agent
```

Local HTTP is also available, at `http://127.0.0.1:8765/mcp?agent=<id>`:

```bash
./apps/cli/bin/hippo -v ~/vaults/my-campaign serve --http 8765
```

Claude Code example:

```bash
claude mcp add hippocampus -- /path/to/hippocampus/apps/cli/bin/hippo -v /path/to/vault serve --agent game-master
```

| Tool | Purpose |
| --- | --- |
| `onboard` | Who you are (lane, authority, quests), plus the handbook |
| `remember` | Queue an episode (fast, never blocks on the LLM) |
| `recall` | Search entities, with graph neighbors and pending episodes |
| `get` / `neighbors` | Full entity note / graph walk |
| `ask_canon` | The fact-checker's job: the canonical answer to a factual question, with status and disputes |
| `briefing` | "Previously on…": chronicle, changes, upcoming deadlines, disputes |
| `update_quest` | Objectives, status, clocks, deadline, owner |

## How facts stay honest

- Every fact has a status: `canon` / `rumor` / `disputed` / `retconned`.
- An agent is **authoritative** for entities tagged with its `authority` domains (`party/<id>.md`). There its word is canon immediately. Elsewhere it's a rumor until a second agent corroborates it.
- Precedence is **human > lane authority > corroboration > recency**.
- A source may correct its own earlier report.
- Contradictions between peers, or against the human, open `disputes/<…>.md`. Set `ruling:` there and the next sleep makes it canon.
- Fields flagged secret are age-encrypted to `secrets/<entity>/<field>.age`. The note only holds `secret://…`. The curator encrypts with the public key and can't read secrets back.

## Repo layout

| Path | What |
| --- | --- |
| `packages/core` | Schemas, markdown and managed regions, vault model, reconcile rules, search, handbook, service, secrets |
| `packages/curator` | LLM adapter (AI SDK) and the sleep pipeline: mentions → resolve → claims → reconcile → apply → summaries |
| `packages/mcp` | MCP tools and resources over the service |
| `apps/cli` | `hippo`: init, serve, sleep, fmt, validate, handbook, remember, secrets |
| `vault-template/` | Empty vault: config, Obsidian templates, Dataview dashboards |
| `seeds/example-relocation/` | Fictional example campaign: party lanes, quests, factions |

```bash
pnpm test
```

```bash
pnpm typecheck
```

## Keep your vault private

This repo holds only code, the template, and fictional examples. Your vault is a **separate private repo**. Never copy a real vault, inbox, chronicle, or `secrets/` into this repo. `.gitignore` blocks the usual paths, and `pnpm test` includes a privacy guard. For an extra check, list your own names, IDs, or places in an untracked `.privacy-denylist` file (one term per line) and the guard fails if any of them appear in tracked files.

## License

[AGPL-3.0](LICENSE)
