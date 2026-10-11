# Changelog

Every merge to `main` publishes a release. Per-release notes are generated on [GitHub Releases](https://github.com/mehrad77/hippocampus/releases). This file records **notable** changes, and especially **vault format** changes (which mean existing vaults need `hippo migrate`). Add them under `[Unreleased]` in your PR. Versions follow [semver](https://semver.org/) and are computed from conventional commits.

## [Unreleased]

**Breaking for self-hosted Workers:** `apps/worker` is now a hosted multi-user app. A single-vault deployment needs a GitHub App, a new D1 registry and new secrets before it starts again, and its agents need new keys. Follow [docs/MIGRATING-WORKER.md](docs/MIGRATING-WORKER.md).

**Breaking: vault format v2.** Run `hippo migrate` in each vault (this release's `hippo validate` still passes a v1 vault, with a hint). Older versions of Hippocampus refuse a migrated vault.

### Added
- **Generic building blocks** (vault format v2): a vault's entity types and episode kinds are notes in `_hippo/schema/`, and code checks capabilities (`goal`, `actor`, `arc`), never type names.
  - Types `extend` types; fields are typed and may be `human_only`, `secret`, `confidential`, `identity_key`, `succession`, `recurs: yearly` or owned by a lane `domain`. Validation is advice: shape notes in the morning review and `hippo validate`.
  - Kinds give an episode a behaviour (observation, fact, decision, question, task, interaction), a text policy (required, optional, gist, forbidden), typed `data`, and whether it counts as contact. A data-only episode is curated without the model.
  - **Several humans** (`humans:`, each with `domains` and a `github:` login); the one whose domains cover a field outranks the others.
  - **Fact qualifiers:** scoped keys (`greeting@lang:pt`), `valid_from`/`valid_until`, `confidence`; succession closes an old value into its history instead of disputing it.
  - **Proposals** for `human_only` fields, and **merge proposals** when an identity key (an email, a repo url) shows two notes are one thing.
  - **Managed memory:** guidelines (scoped, rumor until corroborated), a decision log, open questions and contact stats on any note; `extends:` and inheritable notes pass on defaults, guidelines and a contact cadence; briefings list overdue contacts.
  - **Goals** replace quests and clocks: status words per type, owner, counterparty, due, one `progress`, and a repeat rule (every `1w`, or after the last contact). Commitments in episodes become goals.
- **Presets** (`presets/`, bundled as `PRESETS` in `@hippocampus/template`): people (archetypes with stakes, autonomy and cadence, groups, the human's voice per language, rollup and moment kinds), developer, business, student and household. They are notes, not code: `hippo init --preset <name…>`, the preset picker in Session Zero (local and hosted), or `hippo preset add <name> [--force]` on an existing vault, which copies what's missing, merges `merge: true` type notes into the vault's own, and commits only those files. Presets shape new vaults: adopting a repo that already holds a vault refuses them (`PRESETS_NEW_ONLY`).
- **MCP:** `update_goal`; `briefing(about)` for a brief on one person or thing; `remember` takes any kind, `data`, `scope` and `confidential`, and `text` is optional for kinds that don't need it; the `goal` scope.
- **CLI:** `hippo preset list|add`; `init --preset`, a repeatable `--human` and `--name`; `remember -k <kind> --data key=value --confidential`; `fmt --stats` recounts contact stats from the chronicle; `dashboard --as <human>`.
- **Dashboard:** Goals with progress bars; proposals and possible duplicates in the Council; overdue contacts on the home page; fact qualifiers, guidelines, stats, decisions, questions and inheritance on entity sheets; the vault's humans on the Party page; a preset picker in Session Zero.
- **The hosted app** (`apps/worker`): one Cloudflare Worker for many people, each with a vault in their own private GitHub repo.
  - A GitHub App (Contents and Workflows read and write, Metadata read) for sign-in and repo access; its settings are in `apps/worker/github-app.manifest.json`.
  - Accounts with a waitlist and an admin page (`HIPPO_ADMINS`, by GitHub user id). A D1 registry (`apps/worker/migrations/`) holds accounts, vaults and hashed keys, never vault content.
  - Onboarding: create an empty private repo, install the app, and the vault is set up in one commit, with an age key made in the browser. A repo that already holds a vault is adopted: only missing guardrail files are added.
  - One Durable Object per vault (`VaultHost`): MCP, the dashboard API, an audited single writer, the search index and blob cache in its own SQLite, sleep runs, and alarms.
  - Keys of three kinds: agent (any agent, which names itself), single-agent (bound, with chosen scopes) and curator. OAuth connectors pick a party member or seat a new agent on the consent page.
  - Webhooks that disconnect a vault when the app is uninstalled or suspended, the repo leaves the installation or is deleted, or the repo goes public; reconnecting is automatic once it's undone.
  - Per-vault quotas, rate limits, a connected-apps list, account deletion, and a draft privacy page for operators to complete.
  - Admins can override one vault's limits (`POST /dashboard/api/admin/vaults/quotas`, e.g. `sleepRunsPerDay`); `null` restores the defaults. Overrides are stored on the vault's registry row (`0002_vault_quotas.sql`), so no vault format change.
  - An optional Actions curator: a `sleep.yml` workflow in the vault repo that runs Claude nightly through MCP with a curator key.
- **Agent-run sleep:** `SleepRelay` lets any agent with the `curate` scope run sleep by answering the curator's questions over MCP (`sleep_start`, `sleep_answer`, `sleep_skip`, `sleep_status`, `sleep_abort`, and the `sleep` prompt). Runs are leased, one at a time per vault, and replayed when the vault moves underneath. `hippo serve` offers it too.
- **A Claude Code plugin** (`plugins/hippocampus`, marketplace in `.claude-plugin/`): the MCP server from `HIPPO_MCP_URL` and `HIPPO_KEY`, and the skills `/hippocampus:memory` and `/hippocampus:sleep`.
- **Introductions:** the `introduce` tool files `inbox/<agent>/_introduction-<id>.md`; approve (with authority domains) or dismiss it on the dashboard's Party page.
- **Audit:** every commit Hippocampus makes carries a `Hippo-Actor` trailer (plus `Hippo-Model`, and `Hippo-Curator` and `Hippo-Run` from the relay). `auditChanges` checks each change set against its actor's rules before every hosted commit and every `hippo sleep` flush. `hippo audit [--since <when> | --range a..b]` checks git history.
- **Vault guardrails** in the template: `AGENTS.md` and `CLAUDE.md` for agents that open the repo, `_hippo/curator.md` for the curator's house rules (added to every curator step), and a daily `audit` job in `validate.yml`.
- `buildVaultFiles` (core) builds a vault without a filesystem; `@hippocampus/template` bundles `vault-template/` and `seeds/` for the Worker (`pnpm gen:template`).
- `GitHubStore`: token refresh after a 401, `initialize()` for empty repos (`EmptyRepositoryError`), a `persist` filter for blobs that mustn't be cached at rest, and `SqliteBlobCache`. `doSql` runs the search index on Durable Object SQLite.
- `HIPPO_DEMO_HOSTED=1 pnpm dev:dashboard` walks the hosted onboarding against the demo campaign; `pnpm --filter @hippocampus/worker dev:github` is a fake GitHub for running the Worker offline.
- CI runs the hosted Worker in the real Workers runtime: `pnpm --filter @hippocampus/worker bundle:check` (`wrangler deploy --dry-run`) and `pnpm smoke:worker`, an end-to-end smoke test under `wrangler dev` against the fake GitHub. It also lints every workflow it owns or ships to vaults with actionlint (`pnpm lint:workflows`), and checks the Claude Code plugin's manifests and skills. `release` waits for all of it.
- After each release, CI deploys the hosted app to the official instance (`deploy` job, `scripts/deploy.mjs`). It applies registry migrations, then deploys, probes the live Worker, and rolls it back if the probe fails. See [docs/DEVELOPING.md](docs/DEVELOPING.md#the-official-instance).
- `pnpm deploy:worker` deploys a self-hosted instance from the repository root. `pnpm --filter @hippocampus/worker deploy` ran pnpm's own `deploy` command instead.
- SECURITY.md: the threat model, what a hosted operator can see, keys, and reporting.
- The dashboard (`hippo dashboard`, and `/dashboard` on the hosted app), a campaign codex for humans:
  - **Pages:** Tavern, Quest board, Council, Satchel, Codex, entity sheets, relation Map, Chronicle, Party and Guides, plus ⌘K search.
  - **Actions:** rule on disputes, tick and reopen objectives, turn clocks, scribe a memory as the player, and add party members.
  - **Sources:** a local vault, `--github`, or `--mcp <url>`; `--demo` serves a fictional campaign.
  - **Access:** local runs bind to 127.0.0.1 and open through a one-time link; on the hosted app, each GitHub account reaches only its own vault.
- Two looks for the dashboard, chosen under Setup & health → Personalization and saved per browser:
  - **Plain** (the default) is built on IBM's Carbon design system: IBM Plex, gray-10/gray-100, high contrast. It uses everyday names: Home, Goals, Disputes, Inbox, Records, Timeline, Agents, and Confirmed/Unverified for fact status.
  - **Campaign codex** is the tabletop look and vocabulary.
  - Personalization also sets the colors (match the device, light or dark) and the text size (standard or large).
- Session Zero: guided setup from the dashboard.
  - It can create or open the vault, add the party, forge the secrets key, configure and test the curator model, check that the GitHub repo is private, and generate agent connection snippets.
  - It can also install the nightly sleep (launchd) and rehearse a dry run.
  - On the hosted app it runs the onboarding above, mints and revokes keys, and sets up the curator.
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

### Changed
- Quests are goals (`goals/`) and campaigns are arcs (`arcs/`). `update_quest`, the `quest` scope and `/actions/quest` keep working as aliases, and keys store both scopes so a rollback keeps access.
- The curator's prompts are neutral and quote each type's description and examples; the Handbook drops the campaign framing and lists the vault's own types and kinds.
- `hippo migrate` commits exactly the paths it changed in a git vault, as `Hippo-Actor: migration`; the hosted app never migrates on its own: an older vault answers `VAULT_UPGRADE_NEEDED` to agents until its owner clicks Upgrade on the dashboard, which makes the same audited commit.
- Contact cadence along an `extends:` chain takes the nearest value (a colleague's `1m` over the stranger's `none` it extends); mixins and groups still mesh, with any `none` winning.
- The search index schema is v3; existing indexes rebuild themselves.
- Agents are told to use the MCP tools rather than edit vault files. The handbook documents `remember` and `introduce`; the inbox file format remains for local tools without MCP.
- Agent ids must be exact party slugs: no aliases, never the vault's human, and not `human`, `curator`, `unknown` or `hippocampus`.
- `remember` refuses memories over 8 KB.
- `hippo sleep` no longer logs the text of secret-bearing episodes, fails an episode that would name a new note after a secret value, and refuses to commit if a secret value would appear in plain text anywhere it writes.
- OAuth connections made with the single-vault Worker must be connected again.
- The Worker's `deploy` script applies the registry's migrations before deploying, so upgrades no longer need a separate `wrangler d1 migrations apply`.
- `wrangler.jsonc` sets `preview_urls: false`, so each uploaded version no longer gets its own workers.dev address. OAuth client registration is limited to 3 a minute per IP (was 10).

### Removed
- `SYSTEM_TYPES` and the fixed episode-kind enum: types and kinds come from the vault. `Clock` stays only to read v1 notes.
- The single-vault Worker's settings and storage: `GITHUB_REPO`, `GITHUB_TOKEN`, `HIPPO_OWNERS`, `GITHUB_OAUTH_CLIENT_ID`/`_SECRET`, the `INDEX` D1 database, the `TOKENS` KV namespace, and the `Scribe` Durable Object (wrangler migration `v2` deletes it).
- `pnpm agent-token`: keys are minted on the hosted app's setup page.
- The commented-out nightly `sleep` job in the vault template's CI. Use agent-run sleep or the Actions curator instead.

### Vault format
- v2: generic building blocks. Entity types and episode kinds are notes in `_hippo/schema/types/` and `_hippo/schema/kinds/` (the config's `types:` move there), and code asks for capabilities (`goal`, `actor`, `arc`) instead of type names. `quest` is now `goal` (`goals/`), `campaign` is now `arc` (`arcs/`); `party` keeps its name. Goals use `due` and one `progress` (`{ done, total }`) instead of `deadline` and `clocks`. The config says `name` and `humans` instead of `campaign` and `human`. `hippo migrate` converts a v1 vault, moving notes out of the default `quests/` and `campaigns/` folders, keeping custom types and folders, turning extra clocks into objectives (it says which), and replacing or patching the v1 templates and dashboards. It never touches the inbox, chronicle, disputes or secrets, and its commit passes the audit as the `migration` actor.

### Security
- **Confidential** facts, fields and episodes stay out of search, summaries, the chronicle, titles and aliases, and are masked everywhere except for a bound caller (an OAuth grant's agent, a bound key, `serve --agent`) with authority over them. Identity keys are confidential. The curator consent page says curators see them.
- The audit refuses an agent's or the curator's change to a `human_only` field without a ruling, goal-scoped writes beyond goal props, confidential leaks, and a migration that does more than move and reformat notes.
- Hosted commits are audited against the caller's real credentials; a key can't commit as another agent, the curator or the human.
- Installation tokens are narrowed to one repo, and to Contents and Metadata outside setup.
- Inbox files, which can hold secrets until sleep, are never cached at rest in the Worker.
- The age identity for a hosted vault is generated in the browser and never sent.
- Worker logs record route names, statuses and hashed vault ids, never URLs, error messages or content; invocation logs are off.
- The hosted app refuses a plain-http `HIPPO_PUBLIC_URL`, which would drop the `Secure` cookie flags, except on this machine. It also refuses `GITHUB_API_URL`/`GITHUB_OAUTH_URL`, which would send the app's client secret elsewhere, except for local development.

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
