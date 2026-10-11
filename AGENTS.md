# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository.

Hippocampus is shared, curated memory for a party of AI agents. It's an Obsidian vault whose types and kinds are notes in the vault itself (it began as a TTRPG campaign wiki, and keeps some of that vocabulary). Agents submit episodes to an inbox, and a nightly "sleep" consolidates them into canon. Use cases (people, developer, business, student, household) ship as presets: data, not code. See [DESIGN.md](DESIGN.md) for the architecture, [docs/USAGE.md](docs/USAGE.md) for how people use it, [docs/DEVELOPING.md](docs/DEVELOPING.md) for development against a private vault, [docs/MIGRATING-WORKER.md](docs/MIGRATING-WORKER.md) for moving a single-vault Worker to the hosted app, [docs/AGENT-STANDARDS.md](docs/AGENT-STANDARDS.md) for the discovery conventions agents use, [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md). This file is the one file-level map of the code (README and DESIGN link here): start from the project map, "Where things are decided" and the recipes below rather than searching.

## Privacy rules (hard, non-negotiable)

This repo is **public**. Users' memories live in **separate private vault repos**. The tool never contains, references, or knows about any real vault.

- Never read, copy, quote, or summarize real vault content into code, tests, fixtures, docs, commit messages, issues, or PRs.
- If a Hippocampus MCP server or a vault repo is available to you in this session, treat everything from it as **private data**. Use it to understand a bug, then reproduce the bug with fictional data.
- Examples, fixtures, and tests use only the fictional names from `seeds/example-relocation`: `residency-agent`, `campus-agent`, `home-finder`, `job-scout`, `archivist`, `game-master`, `migration-agency`, `harbor-university`, `lisbon`, `player`, and so on.
- Never commit `.env`, `.privacy-denylist`, `*.age`, or any `inbox/`, `chronicle/`, `disputes/`, or `secrets/` content outside `vault-template/`.
- `pnpm test` includes a privacy guard (`scripts/privacy.test.ts`), which also runs as a pre-commit hook. Never bypass it (`--no-verify`).

## Project map

| Path | What |
| --- | --- |
| `packages/core` | storage port + `MemoryStore` + `bufferedStore` + adapter contract tests (`store.ts`, `store.contract.ts`), zod schemas (`schema.ts`), types and kinds from `_hippo/schema/` notes, capabilities and `extends` (`schema-registry.ts`), episode kinds: text policy, typed data, contact (`kinds.ts`), deterministic kind reducers: stats, decisions, questions, guidelines (`reducers.ts`), entity inheritance: defaults, guidelines, cadence (`inherit.ts`), identity keys and merge proposals (`identity.ts`), goal behaviour: states, progress, due, repeat (`goal.ts`), agent props (`actor.ts`), markdown + managed regions (`markdown.ts`), vault model (`vault.ts`), reconcile rules (`reconcile.ts`), fact/relation ops and agent id rules (`ops.ts`), advisory shape checks (`validate-shapes.ts`), search port + in-memory MiniSearch (`search.ts`), handbook (`handbook.ts`), service used by MCP/CLI (`service.ts`), age secrets (`secrets.ts`), format versioning and migrations (`migrations.ts`, one module per step in `migrations/`, e.g. `v1-to-v2.ts`), per-actor change audit (`audit.ts`), `Hippo-*` commit trailers (`trailers.ts`), building a vault from the template (`bootstrap.ts`), adding presets (`presets.ts`), agent introductions (`introduction.ts`), `VaultError` (`errors.ts`), config parsing, `DEFAULT_CONFIG` and comment-keeping edits to `humans` (`config.ts`), entity notes: parse, render, summary (`entity.ts`), inbox episodes (`episode.ts`), slugs, fact keys, durations, dates, `ulid` (`text.ts`), the dashboard's read models with all masking, `REVIEW_PATH` (`views.ts`), `[[links]]` (`wikilink.ts`), `FsStore`, the `@hippocampus/core/node` entry (`node/fs-store.ts`), fixture vaults (`__fixtures__/vault.ts`, `__fixtures__/managed.ts`, frozen `__fixtures__/v1-vault.ts`) |
| `packages/index` | Persistent FTS5 + relations + vectors index behind core's `Searcher` port (`hippo-index.ts`), hybrid ranking (`hybrid.ts`), `Embedder` port (`embedder.ts`), `SqlDriver` port (`sql.ts`), `node:sqlite`, D1 and Durable Object SQLite drivers (`node.ts`, `d1.ts`, `do-sql.ts`) |
| `packages/embeddings` | `Embedder` adapters: OpenAI-compatible via AI SDK (LM Studio/Ollama/hosted), Workers AI; `HIPPO_EMBED_*` config (`embedders.ts`) |
| `packages/curator` | LLM adapter (`llm.ts`, AI SDK; `prompt` vs `native` structured output), prompts and schemas (`prompts.ts`), sleep pipeline (`sleep.ts`), what the person does after a run (`next-steps.ts`), agent-run sleep over MCP (`relay.ts`: `SleepRelay`, `SLEEP_PROCEDURE`), one shared night of the example vault for sleep and relay tests (`__fixtures__/night.ts`) |
| `packages/mcp` | MCP tools, resources and the `sleep` prompt over `HippoService` (`server.ts`); scopes `read`, `remember`, `goal` (old name `quest`), `curate` |
| `packages/store-git` | Host-neutral pieces shared by the git-host stores: blob caches (`blob-cache.ts`, `sql-cache.ts`), snapshots and ignore rules (`snapshot.ts`), tar reader (`tar.ts`) |
| `packages/store-github` | `VaultStore` over the GitHub API: pinned-commit reads, atomic commits, token refresh, `initialize()` for empty repos (`github-store.ts`), `FakeGitHub` for tests (`fake-github.ts`); re-exports `store-git` |
| `packages/store-gitlab` | `VaultStore` over the GitLab API (gitlab.com or self-managed): pinned-commit reads, one commit per batch via the commits API, token refresh, empty projects, `FakeGitLab` for tests (`gitlab-store.ts`, `fake-gitlab.ts`) |
| `packages/template` | `vault-template/`, `seeds/` and `presets/` as data (`TEMPLATE`, `SEEDS`, `PRESETS` in `files.gen.ts`, generated by `pnpm gen:template`), for the Worker and the CLI |
| `apps/worker` | The hosted multi-user app on Cloudflare: Workers entry point (`worker.ts`), request handling and routing (`app.ts`), key format (`auth.ts`), OAuth consent (`oauth.ts`), single-writer queue (`scribe.ts`), the dashboard's assets under `/dashboard` (`dashboard.ts`), `/llms.txt`, server card and AI catalog (`discovery.ts`), GitHub sign-in (`github-login.ts`), its own small HTML pages (`pages.ts`), the whole app in Node for tests (`testing/hosted-app.ts`, with `testing/browser.ts`, `testing/memory-kv.ts`, `testing/cloudflare-workers.ts`). Registry schema: `migrations/`. Dev fake: `scripts/fake-github.ts`; end-to-end smoke test under `wrangler dev`: `scripts/smoke.ts`; bundle check: `scripts/bundle-check.mjs`. Files that import `cloudflare:workers` or Workers' global types are in `tsconfig.json`'s `exclude` and type-checked by `tsconfig.worker.json`. Not published |
| `apps/worker/src/hosted` | Every binding and setting the Worker reads (`env.ts`: `HostedEnv`; `settings.ts`), the hosted routes: accounts, onboarding, admin, webhooks (`routes.ts`), registry over D1 (`registry.ts`), GitHub App (`github-app.ts`), sign-in sessions (`session.ts`), onboarding and keys (`onboarding.ts`), vault bootstrap and adoption (`bootstrap.ts`), the per-vault Durable Object (`vault-host.ts` over `vault-runtime.ts`; the Worker's typed view of it is `vault-port.ts`), account settings and deletion (`account.ts`), members and invites (`sharing.ts`), device sign-in for agents (`device.ts`, `device-routes.ts`), which connection holds each agent name (`agent-claims.ts`), what the owner switched for a connection, such as an app's curating (`connection-settings.ts`), the sleep relay's run in DO SQLite (`run-store.ts`), GitLab vaults (OAuth connect `gitlab-connect.ts`, sealed tokens `gitlab.ts` and `token-box.ts`, the Cron health check `gitlab-health.ts`), audited writes (`audited-store.ts`), quotas and rate limits (`quotas.ts`, `limits.ts`, embedding cap `embed-cap.ts`), webhooks (`webhooks.ts`), admin (`admin.ts`), the Actions curator workflow (`curator-actions.ts`, text in `sleep-workflow.ts`), test helpers: registry on node:sqlite, fake GitHub sign-in (`testing.ts`) |
| `packages/dashboard` | The dashboard's web-standard JSON API (`api.ts`), guards and errors (`http.ts`), `DashboardSource` port (`source.ts`) with service and MCP adapters (`service-source.ts`, `mcp-source.ts`), the Session Zero contract (`setup.ts`), node:http adapter and static serving (`node.ts`), the fictional demo campaign (`demo.ts`, `demo-setup.ts`) and a pretend hosted app in front of it (`demo-hosted.ts`), the `astro dev` API (`dev.ts`), the apps a vault connects and what each pastes (`connect.ts`), the dashboard's fixture vault (`__fixtures__/vault.ts`), API parity across sources (`parity.test.ts`) |
| `apps/dashboard` | The dashboard UI: Astro static build (base `/dashboard`, hash-based CSP) with React islands (`src/islands`), shared UI (`src/ui`), data/cache helpers (`src/lib`), design tokens (`src/styles/tokens.css`), guides (`src/content/guides`) and their MDX components (`src/components/guides`: `Aside` kinds `lore`, `tip`, `warn`, `rule`; section names in `sections.ts`), the setup wizard and hosted onboarding (`src/islands/setup`). Two looks: Plain (default) and Campaign/codex, words in `src/lib/terms.ts`, chosen per browser in `src/lib/prefs.ts` (islands call `useTerms().v(plain, codex)`), Plain's dress in `src/styles/plain.css`. Page ids keep the campaign names (`src/lib/routes.ts`): `tavern` Home, `goals`, `council` Disputes, `codex` Records, `map` Connections, `chronicle` Timeline, `satchel` Inbox, `party` Agents; an entity is `/entity/?ref=<slug>`. Not published on its own; the CLI and Worker serve its build |
| `apps/cli` | `hippo` CLI (`src/main.ts`, `src/git.ts` incl. staging and committing exactly the changed paths, `src/audit.ts` for `hippo audit`, `src/vault-setup.ts` for `init`, `src/dashboard/` for `hippo dashboard` and the local Session Zero backend: `command.ts`, `local-setup.ts`, `runtime.ts`, `server.ts`), env and path helpers (`src/paths.ts`), opening a store, index and searcher from flags (`src/stores.ts`), nightly sleep as launchd or cron, set up from the local dashboard (`src/schedule.ts`), `hippo serve` and its agent binding (`src/serve.ts`), the user env file in ~/.config/hippocampus (`src/env-file.ts`), published as `@mehrad77/hippocampus` (tsup bundle + the dashboard build) |
| `plugins/hippocampus`, `.claude-plugin/` | Claude Code plugin and its marketplace: `.mcp.json` (reads `HIPPO_MCP_URL`, `HIPPO_KEY`), skills `connect`, `memory`, `sleep`, `sleep-setup` |
| `vault-template/` | What `hippo init` and the hosted app write: config, guardrails (`AGENTS.md`, `CLAUDE.md`, `_hippo/curator.md`), Obsidian templates, Dataview dashboards, vault CI (validate + daily audit) |
| `seeds/example-relocation/` | Fictional example campaign: `_hippo/`, `arcs/`, `characters/`, `factions/`, `goals/`, `locations/`, `lore/`, `party/`. Tests and examples use its slugs (`residency-agent`, `harbor-university`, `residence-permit`, `lisbon`, …) |
| `presets/<name>/` | Presets (people, developer, business, student, household): `preset.yaml` (description, `requires`, config domains and relations), `_hippo/schema/` type and kind notes (`merge: true` merges into the vault's own), `_hippo/templates/`, starter notes, `human-sections.md`. Fictional examples only; never inbox, chronicle, disputes or secrets |
| `scripts/` | Privacy guard test, pack check, template bundle generator, release versioning (`release.mjs`), the official instance's deploy config and probe (`deploy.mjs`), plugin and workflow checks (`plugin.test.ts`, `workflows.test.ts`, `lint-workflows.mjs`), tests for the deploy, release and template scripts (`deploy.test.ts`, `release.test.ts`, `gen-template.test.ts`). `no-type-names.test.ts` fails when code names a type (`quest`, `party`, `campaign`) as a literal; its `ALLOWED` entries each carry a `why`. `docs.test.ts` checks that this map's paths exist, that MCP tools are documented in README and DESIGN §3, that skills match, and that no doc pins a stale `@0.x` version |
| `ops/` | A macOS launchd agent for nightly `hippo sleep` (`com.hippocampus.sleep.plist`); the local dashboard's setup can schedule sleep for you instead |
| `.githooks/` | `pre-commit` runs the privacy guard; `pnpm install` points `core.hooksPath` here |
| Test fixtures | Fictional vaults to build tests on: `packages/core/src/__fixtures__/`, `packages/curator/src/__fixtures__/night.ts` with `ScriptedLLM` (`packages/curator/src/llm.ts`), `packages/dashboard/src/__fixtures__/vault.ts`, `apps/worker/src/testing/` and `apps/worker/src/hosted/testing.ts`. Importing another package's fixtures by relative path is normal; they aren't exported |

## Where things are decided

| Concept | Code |
| --- | --- |
| Fact keys (`field@scope`) and qualifiers (`valid_from`, `valid_until`, `confidence`) | `factKey`, `parseFactKey` in `packages/core/src/text.ts`; `qualifiersOf` in `ops.ts`, `qualifiers` in `reconcile.ts` |
| Reconcile precedence | `reconcileFact`, `AUTHORITY_RANK` and the table comment in `packages/core/src/reconcile.ts` |
| Humans and authority | `HumanDef` in `packages/core/src/schema.ts`; `Vault.authorityOf`, `isHuman`, `humanByLogin` in `vault.ts` |
| Confidential masking | `seesConfidential` and the read models in `packages/core/src/views.ts`; agents' views go through it in `service.ts` |
| Scopes | `SCOPES`, `LEGACY_GOAL_SCOPE` in `packages/mcp/src/server.ts`; `KIND_SCOPES` in `apps/worker/src/hosted/registry.ts`; `SCOPE_LABELS` in `apps/worker/src/oauth.ts` |
| Hosted vault ids | `ulid()` in `apps/worker/src/hosted/registry.ts` (core's `text.ts` has its own `ulid` for episodes) |
| Vault format version | `CURRENT_VAULT_VERSION`, `assertVaultVersion` in `packages/core/src/migrations.ts` |
| Config path | `CONFIG_PATH` (`_hippo/config.yaml`) and `DEFAULT_CONFIG` in `packages/core/src/config.ts` |
| Sign-in → vault human | `dashboardUser` builds a `DashboardUser` in `apps/worker/src/app.ts` → `humanOf` in `hosted/vault-runtime.ts` → `humanByLogin` over `humans[].gitlab`, then `humans[].github`, else the primary human |
| Empty-repo setup | `initialize()` in `github-store.ts` and `gitlab-store.ts`; `plan()` (initialize, adopt or refuse) in `apps/worker/src/hosted/bootstrap.ts` |
| MCP tools, resources, the `sleep` prompt | `createHippoServer` in `packages/mcp/src/server.ts` |
| Worker bindings and settings | `HostedEnv` in `apps/worker/src/hosted/env.ts`; `HostedSettings`, `hostedSettings` in `settings.ts` |
| Limits | `QUOTAS`, `MAX_*` in `hosted/quotas.ts`; `rateLimit` in `limits.ts` over `ratelimits` in `wrangler.jsonc`; `MAX_*` in `registry.ts`; `DEFAULT_EMBED_DAILY_LIMIT` in `embed-cap.ts` |
| Episode kinds | `validateEpisode` in `packages/core/src/kinds.ts`; `SchemaRegistry.kind()` in `schema-registry.ts` resolves a kind name |

## Recipes

**Hosted request flow.** `worker.ts` → `createHostedApp` in `app.ts` (OAuth, discovery, rate limits; picks the vault for `/mcp` and the dashboard API) → `routes.ts` and `session.ts` for hosted pages and sign-in → `registry.ts` (account, vault, key) → `vault-port.ts` (typed stub) → `VaultHost` in `vault-host.ts` (the Durable Object) → `HostedVault` in `vault-runtime.ts` → `GitHubStore` or `GitLabStore`.

**A new dashboard action.** Add the route in `packages/dashboard/src/api.ts` → a `DashboardSource` method in `source.ts` → implement it in `service-source.ts`, `mcp-source.ts` and the demo (`demo.ts`, `demo-hosted.ts`) → cover it in `parity.test.ts` → call it from `apps/dashboard/src/lib/api.ts` in an island.

**Add or rename a dashboard page.** `apps/dashboard/src/lib/routes.ts` (`Page`, `PATHS`), its words in `lib/terms.ts`, the nav in `layouts/Shell.astro`, `islands/CommandPalette.tsx`, `components/guides/sections.ts` if guides mention it, `TYPE_ORDER` in `lib/graph.ts` for a type, its stylesheet, and for a rename a redirect page under `pages/` (see `quests.astro`).

**Change vault config from code.** Edit the YAML document so comments survive (`setHumans`, `linkHuman`, `renderConfig` in `config.ts`; presets merge through `applyPreset` in `presets.ts`), commit through a `HippoService` method's `mutate`, and re-render `HANDBOOK.md` with `renderHandbook` when it shows the change. `audit.ts` treats the config as protected (`PROTECTED`): only the human or a migration writes it.

**GitHub vs GitLab code.** Stores: `packages/store-github`, `packages/store-gitlab` (shared parts in `packages/store-git`). Worker: `github-app.ts`, `webhooks.ts`, `github-login.ts`, `gitlab-connect.ts`, `gitlab.ts`, `token-box.ts`, `gitlab-health.ts`, and the `provider` branches in `vault-runtime.ts`, `registry.ts` and `bootstrap.ts`. Core: `humans[].github|gitlab` (`config.ts`, `humanByLogin`).

## Commands

Install (also enables the pre-commit hook):

```bash
pnpm install
```

Run all tests, including the privacy guard:

```bash
pnpm test
```

Typecheck:

```bash
pnpm typecheck
```

Bundle the CLI into `apps/cli/dist`:

```bash
pnpm build
```

Verify the npm tarball has no vault data:

```bash
pnpm pack:check
```

Run the CLI from source:

```bash
./apps/cli/bin/hippo --help
```

Work on the dashboard UI against the fictional demo campaign (hot reload; set `HIPPO_VAULT` to use a local vault instead, which is private data; `HIPPO_DEMO_HOSTED=1` adds the hosted app's sign-in and onboarding):

```bash
pnpm dev:dashboard
```

Regenerate the template bundle after changing `vault-template/`, `seeds/` or `presets/`:

```bash
pnpm gen:template
```

Run the hosted Worker offline against a fake GitHub (once: `pnpm --filter @hippocampus/worker dev:github --dev-vars > apps/worker/.dev.vars`), in two terminals:

```bash
pnpm --filter @hippocampus/worker dev:github
```

```bash
pnpm --filter @hippocampus/worker dev
```

After changing the Worker, check it in the real Workers runtime the way CI does (needs the dashboard UI built: `pnpm --filter @hippocampus/dashboard-ui build`):

```bash
pnpm --filter @hippocampus/worker bundle:check
```

```bash
pnpm smoke:worker
```

After changing a workflow (this repo's, the vault template's, or the Actions curator's), lint them with [actionlint](https://github.com/rhysd/actionlint):

```bash
pnpm lint:workflows
```

## Conventions

- TypeScript ESM, Node 24. Relative imports use the `.ts` extension. Workspace packages export `src/*.ts` directly (no build step except the CLI bundle).
- Prefer composition over inheritance, and small pure functions (see `reconcile.ts`, `ops.ts`).
- Match the surrounding code's density and naming. Comments explain *why*, not *what*.
- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`. They decide the released version (`feat` minor, `fix`/other patch, `!` breaking). Every merge to `main` publishes to npm, then deploys the hosted app to the official instance.
- `main` is protected: work on a branch and open a PR. Never bump versions by hand. Git tags are the version of record (`scripts/release.mjs`).
- Each curator LLM step is small and schema-validated (zod). The LLM never writes files directly. Deterministic code applies its structured output.
- Curator changes get a golden test with `ScriptedLLM` in `packages/curator/src/sleep.test.ts`.
- Dashboard: read models live in `packages/core/src/views.ts` (secrets are masked there, nowhere else). UI logic that can be pure lives in `apps/dashboard/src/lib` with `*.test.ts` tests. Colors come from the tokens in `tokens.css` only; fact status always pairs glyph, word and color. Screenshots and examples come from `--demo` only.
- Dashboard stylesheets: a feature stylesheet prefixes its classes (`sz-` in `setup.css`, `hz-` in `hosted.css`, `pub-` in `public.css`, `guide-` in `guides.css`), so pages can't collide; classes more than one page uses live in `components.css`.
- No formatter or linter is configured; match the surrounding style by hand.
- A new store or git host updates DESIGN.md §1 and its Implementation status, and this file's map.
- Reconcile rule changes update the precedence table comment in `reconcile.ts` and `reconcile.test.ts` together.
- Changes to on-disk vault format bump `CURRENT_VAULT_VERSION`, add a migration, and get a CHANGELOG entry.
- Code asks the schema registry for capabilities (`goal`, `actor`, `arc`); it never names a type. A new use case is a preset (notes), not code.
- Registry schema changes add a new numbered file to `apps/worker/migrations/`; never edit an applied one. Deploys apply them before the new code, and a rollback restores only the code, so a migration must also work with the previous Worker: add, don't rename or drop.
- Durable Object class migrations (`migrations` in `wrangler.jsonc`) can't be rolled back. Ship them in a PR of their own and watch its deploy.
- A new required Worker setting is set on the official instance before the PR that needs it merges. Otherwise the deploy's probe sees the "isn't set up yet" page and rolls back.
- `wrangler.jsonc` stays generic: no instance's host or resource ids. The official instance's come from the `production` environment at deploy time (`scripts/deploy.mjs`).
- The Worker logs route names, statuses and hashed vault ids only, never error messages or vault content.

## Invariants — don't break these

- Human prose outside `%% hippo:begin … %%` / `%% hippo:end … %%` regions is never rewritten.
- Agents only append new files to `inbox/`. Everything else is written by the curator or the human.
- Every hosted commit passes `auditChanges` for its actor, and carries a `Hippo-Actor` trailer.
- The hosted app never stores inbox blobs at rest, and never receives the age identity.
- Human authority outranks every agent; among humans, the one whose `domains` cover the field. Precedence is human > lane authority > corroboration > recency, and a `succession` field never closes a human's value.
- Secret values never appear in notes, chronicle, summaries, aliases, or titles, only as `secret://…` refs. The curator encrypts with the public key and never decrypts.
- Confidential values (confidential facts and fields, identity keys) never reach search, summaries, the chronicle, aliases or titles, and are masked in every read model except for a bound caller with authority.
- A `human_only` field changes only by a human's word: an agent's value becomes a proposal, and the audit refuses anything else.
- A format migration commits as the `migration` actor and only rewrites config, schema, templates, dashboards and the Handbook, or moves notes without changing their human prose, facts or relations. It never touches the inbox, chronicle, disputes or secrets.
- A failed episode stays in the inbox. `sleep` never loses a memory.
- `hippo sleep` stages only the paths the curator changed, never the human's unrelated edits.
