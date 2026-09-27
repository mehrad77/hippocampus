# Contributing

```bash
pnpm install
pnpm test        # vitest across all packages (includes the privacy guard)
pnpm typecheck
```

- Commits use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:` …).
- Keep examples fictional. Use `seeds/example-relocation` names in tests and docs, never real people, IDs, or vault content.
- Curator changes should come with a golden test in `packages/curator/src/sleep.test.ts` (scripted LLM), so behavior doesn't depend on a particular model.
- Reconcile rule changes must update the precedence table in `packages/core/src/reconcile.ts` and its tests.
