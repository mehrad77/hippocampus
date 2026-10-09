# Changelog

Every merge to `main` publishes a release. Per-release notes are generated on [GitHub Releases](https://github.com/mehrad77/hippocampus/releases). This file records **notable** changes, and especially **vault format** changes (which mean existing vaults need `hippo migrate`). Add them under `[Unreleased]` in your PR. Versions follow [semver](https://semver.org/) and are computed from conventional commits.

## [Unreleased]

### Added
- `--github owner/repo[#branch]` (or `HIPPO_GITHUB_REPO` + `HIPPO_GITHUB_TOKEN`): run `serve`, `sleep`, `remember` and the other commands against the vault repo on GitHub without a checkout. Every write is one atomic commit.
- Semantic recall (opt-in via `HIPPO_EMBED_MODEL`): local LM Studio or Ollama embeddings by default, any OpenAI-compatible API, or Workers AI in the Worker. Keyword and vector results are fused and re-ranked along relations; if the embedder is down, search falls back to keywords.
- Cloudflare Worker MCP server (`apps/worker`, deployed from a clone, not on npm): GitHub-backed reads, D1 search index, a Scribe Durable Object as the single writer, and per-agent bearer tokens with `read`/`remember`/`quest` scopes.
- `GitHubStore` downloads a commit as one tarball when many files are uncached, and can share its blob and tree caches between short-lived stores.
- Persistent search index (SQLite FTS5 via `node:sqlite`) for `serve` and `sleep`: incremental by content hash, typo-tolerant name matching, typed relations. `hippo index` rebuilds it; `--no-index` keeps in-memory search.
- `VaultStore.apply()` for atomic batches, and `StoreConflictError` when a batch collides with a concurrent change.

## [0.1.0]

### Added
- Vault model: TTRPG campaign wiki (characters, factions, locations, items, lore, quests, campaigns, party), managed regions, typed relations, facts with canon/rumor/disputed status.
- Curator (`hippo sleep`): mentions → resolve → claims → reconcile → apply → chronicle → summaries → morning review and handbook, with git pull/commit/push. Provider-agnostic LLM adapter (LM Studio, Ollama, OpenAI-compatible, Anthropic, xAI).
- Disputes with human rulings, age-encrypted secret facts.
- MCP server (`hippo serve`, stdio and local HTTP) with 8 tools.
- CLI: `init`, `serve`, `sleep`, `migrate`, `fmt`, `validate`, `handbook`, `remember`, `secrets`.
- Vault template with Obsidian templates, Dataview dashboards, and vault CI. Fictional example seed.
- Privacy guard, pre-commit hook, pack check.

### Vault format
- v1 (initial).
