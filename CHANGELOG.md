# Changelog

Every merge to `main` publishes a release. Per-release notes are generated on [GitHub Releases](https://github.com/mehrad77/hippocampus/releases). This file records **notable** changes, and especially **vault format** changes (which mean existing vaults need `hippo migrate`). Add them under `[Unreleased]` in your PR. Versions follow [semver](https://semver.org/) and are computed from conventional commits.

## [Unreleased]

### Added
- The dashboard (`hippo dashboard`, and `/dashboard` on the Worker), a campaign codex for humans:
  - **Pages:** Tavern, Quest board, Council, Satchel, Codex, entity sheets, relation Map, Chronicle, Party and Guides, plus ⌘K search.
  - **Actions:** rule on disputes, tick and reopen objectives, turn clocks, scribe a memory as the player, and add party members.
  - **Sources:** a local vault, `--github`, or `--mcp <url>`; `--demo` serves a fictional campaign.
  - **Access:** local runs bind to 127.0.0.1 and open through a one-time link; on the Worker, GitHub sign-in is limited to `HIPPO_OWNERS`.
- Two looks for the dashboard, chosen under Setup & health → Personalization and saved per browser:
  - **Plain** (the default) is built on IBM's Carbon design system: IBM Plex, gray-10/gray-100, high contrast. It uses everyday names: Home, Goals, Disputes, Inbox, Records, Timeline, Agents, and Confirmed/Unverified for fact status.
  - **Campaign codex** is the tabletop look and vocabulary.
  - Personalization also sets the colors (match the device, light or dark) and the text size (standard or large).
- Session Zero: guided setup from the dashboard.
  - It can create or open the vault, add the party, forge the secrets key, configure and test the curator model, check that the GitHub repo is private, and generate agent connection snippets.
  - It can also install the nightly sleep (launchd) and rehearse a dry run.
  - On the Worker it shows remote health and mints, lists and revokes agent tokens.
- A user-level env file (`~/.config/hippocampus/env`, or `$HIPPO_CONFIG_DIR/env`) for settings saved by Session Zero. The shell and a local `.env` still take precedence.
- Rulings can be applied immediately (`HippoService.rule`), not only at the next sleep. `update_quest` accepts `reopen` to untick objectives.
- MCP resource templates for human read models (`hippo://dashboard/…`). They stay out of `resources/list`, so agent hosts don't see them.
- `--github owner/repo[#branch]` (or `HIPPO_GITHUB_REPO` + `HIPPO_GITHUB_TOKEN`): run `serve`, `sleep`, `remember` and the other commands against the vault repo on GitHub without a checkout. Every write is one atomic commit.
- OAuth for MCP connectors (Claude.ai, ChatGPT) in the Worker: discovery, dynamic client registration and PKCE via `@cloudflare/workers-oauth-provider`; a consent page where the owner picks the agent and scopes for each app; GitHub sign-in restricted to `HIPPO_OWNERS`. Agent tokens keep working.
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
