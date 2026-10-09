# Changelog

Every merge to `main` publishes a release. Per-release notes are generated on [GitHub Releases](https://github.com/mehrad77/hippocampus/releases). This file records **notable** changes, and especially **vault format** changes (which mean existing vaults need `hippo migrate`). Add them under `[Unreleased]` in your PR. Versions follow [semver](https://semver.org/) and are computed from conventional commits.

## [Unreleased]

### Added
- `--github owner/repo[#branch]` (or `HIPPO_GITHUB_REPO` + `HIPPO_GITHUB_TOKEN`): run `serve`, `sleep`, `remember` and the other commands against the vault repo on GitHub without a checkout. Every write is one atomic commit.
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
