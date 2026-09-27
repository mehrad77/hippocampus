# Contributing

`pnpm install` also enables the pre-commit privacy hook:

```bash
pnpm install
```

Run the tests (vitest across all packages, including the privacy guard):

```bash
pnpm test
```

```bash
pnpm typecheck
```

Bundle the CLI, then verify the npm tarball:

```bash
pnpm build && pnpm pack:check
```

- **Develop against your own vault without leaking it.** Read [docs/DEVELOPING.md](docs/DEVELOPING.md) first. This repo is public. Vaults are private.
- Commits use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:` …).
- Keep examples fictional: use `seeds/example-relocation` names in tests and docs, never real people, IDs, or vault content.
- Curator changes come with a golden test in `packages/curator/src/sleep.test.ts` (scripted LLM), so behavior doesn't depend on a particular model.
- Reconcile rule changes must update the precedence table in `packages/core/src/reconcile.ts` and its tests.
- Vault format changes bump `CURRENT_VAULT_VERSION`, add a migration, and get a CHANGELOG entry.
- Coding agents: see [AGENTS.md](AGENTS.md).
