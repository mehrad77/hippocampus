# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository.

Hippocampus is shared, curated memory for a party of AI agents. It's an Obsidian vault organized like a TTRPG campaign wiki. Agents submit episodes to an inbox, and a nightly "sleep" consolidates them into canon. See [DESIGN.md](DESIGN.md) for the architecture, [docs/USAGE.md](docs/USAGE.md) for how people use it, and [docs/DEVELOPING.md](docs/DEVELOPING.md) for development against a private vault.

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
| `packages/core` | storage port + `MemoryStore` + adapter contract tests (`store.ts`, `store.contract.ts`), zod schemas (`schema.ts`), markdown + managed regions (`markdown.ts`), vault model (`vault.ts`), reconcile rules (`reconcile.ts`), fact/relation/quest ops (`ops.ts`), search port + in-memory MiniSearch (`search.ts`), handbook (`handbook.ts`), service used by MCP/CLI (`service.ts`), age secrets (`secrets.ts`), format versioning (`migrations.ts`) |
| `packages/index` | Persistent FTS5 + relations + vectors index behind core's `Searcher` port (`hippo-index.ts`), hybrid ranking (`hybrid.ts`), `Embedder` port (`embedder.ts`), `SqlDriver` port (`sql.ts`), `node:sqlite` driver (`node.ts`) |
| `packages/embeddings` | `Embedder` adapters: OpenAI-compatible via AI SDK (LM Studio/Ollama/hosted), Workers AI; `HIPPO_EMBED_*` config (`embedders.ts`) |
| `packages/curator` | LLM adapter (`llm.ts`, AI SDK; `prompt` vs `native` structured output), prompts and schemas (`prompts.ts`), sleep pipeline (`sleep.ts`) |
| `packages/mcp` | MCP tools and resources over `HippoService` (`server.ts`) |
| `packages/store-github` | `VaultStore` over the GitHub API: pinned-commit reads, atomic commits (`github-store.ts`), `FakeGitHub` for tests (`fake-github.ts`) |
| `apps/worker` | Cloudflare Worker MCP server: request handling and auth (`app.ts`, `auth.ts`), Scribe single writer (`scribe.ts`), OAuth consent and GitHub sign-in (`oauth.ts`), Workers entry point with bindings (`worker.ts`), agent tokens (`scripts/token.ts`). Not published |
| `packages/dashboard` | The dashboard's web-standard JSON API (`api.ts`), guards and errors (`http.ts`), `DashboardSource` port (`source.ts`) with service and MCP adapters (`service-source.ts`, `mcp-source.ts`), the Session Zero contract (`setup.ts`), node:http adapter and static serving (`node.ts`), the fictional demo campaign (`demo.ts`, `demo-setup.ts`), the `astro dev` API (`dev.ts`) |
| `apps/dashboard` | The dashboard UI: Astro static build (base `/dashboard`, hash-based CSP) with React islands (`src/islands`), shared UI (`src/ui`), data/cache helpers (`src/lib`), design tokens (`src/styles/tokens.css`), guides (`src/content/guides`). Not published on its own; the CLI and Worker serve its build |
| `apps/cli` | `hippo` CLI (`src/main.ts`, `src/git.ts`, `src/dashboard/` for `hippo dashboard` and the local Session Zero backend), published as `@mehrad77/hippocampus` (tsup bundle + the dashboard build) |
| `vault-template/` | What `hippo init` copies: config, Obsidian templates, Dataview dashboards, vault CI |
| `seeds/example-relocation/` | Fictional example campaign |
| `scripts/` | Privacy guard test and pack check |

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

Work on the dashboard UI against the fictional demo campaign (hot reload; set `HIPPO_VAULT` to use a local vault instead, which is private data):

```bash
pnpm dev:dashboard
```

## Conventions

- TypeScript ESM, Node 24. Relative imports use the `.ts` extension. Workspace packages export `src/*.ts` directly (no build step except the CLI bundle).
- Prefer composition over inheritance, and small pure functions (see `reconcile.ts`, `ops.ts`).
- Match the surrounding code's density and naming. Comments explain *why*, not *what*.
- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`. They decide the released version (`feat` minor, `fix`/other patch, `!` breaking). Every merge to `main` publishes to npm.
- `main` is protected: work on a branch and open a PR. Never bump versions by hand. Git tags are the version of record (`scripts/release.mjs`).
- Each curator LLM step is small and schema-validated (zod). The LLM never writes files directly. Deterministic code applies its structured output.
- Curator changes get a golden test with `ScriptedLLM` in `packages/curator/src/sleep.test.ts`.
- Dashboard: read models live in `packages/core/src/views.ts` (secrets are masked there, nowhere else). UI logic that can be pure lives in `apps/dashboard/src/lib` with `*.test.ts` tests. Colors come from the tokens in `tokens.css` only; fact status always pairs glyph, word and color. Screenshots and examples come from `--demo` only.
- Reconcile rule changes update the precedence table comment in `reconcile.ts` and `reconcile.test.ts` together.
- Changes to on-disk vault format bump `CURRENT_VAULT_VERSION`, add a migration, and get a CHANGELOG entry.

## Invariants — don't break these

- Human prose outside `%% hippo:begin … %%` / `%% hippo:end … %%` regions is never rewritten.
- Agents only append new files to `inbox/`. Everything else is written by the curator or the human.
- Human authority outranks every agent. Precedence is human > lane authority > corroboration > recency.
- Secret values never appear in notes, chronicle, summaries, aliases, or titles, only as `secret://…` refs. The curator encrypts with the public key and never decrypts.
- A failed episode stays in the inbox. `sleep` never loses a memory.
- `hippo sleep` stages only the paths the curator changed, never the human's unrelated edits.
