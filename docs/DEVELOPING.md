# Developing Hippocampus against a private vault

Most contributors use Hippocampus on their own private vault. That's the best way to find real problems, and also the easiest way to leak personal data into a public repo. These rules keep the two apart.

## The rule

**Data flows from the tool into your vault, never back.** No file, snippet, name, ID, or screenshot from a real vault goes into this repo, its issues, its PRs, or its commit messages.

## Setup

```bash
pnpm install
```

`pnpm install` also enables the pre-commit privacy hook (`.githooks/pre-commit`).

Point the dev CLI at your vault through a gitignored `.env`, rather than typing paths into shared logs:

```bash
cp .env.example .env
```

Run the CLI from source (tsx, no build):

```bash
./apps/cli/bin/hippo validate
```

## Try changes safely

- Work on a copy: `cp -r ~/vaults/my-campaign /tmp/vault-copy && ./apps/cli/bin/hippo -v /tmp/vault-copy sleep --no-git`.
- Or run `hippo sleep --dry-run` on the real vault. It runs the curator but writes nothing.
- Never point tests at your real vault. Tests use in-memory fixtures (`packages/core/src/__fixtures__/vault.ts`).

## Turn real bugs into fictional tests

When your vault reveals a bug:
1. Reproduce it with names from the fictional example (`seeds/example-relocation`: residency-agent, campus-agent, migration-agency, …).
2. Add a golden test using `ScriptedLLM` (see `packages/curator/src/sleep.test.ts`). The test replays what the model returned, so it doesn't depend on a particular model.
3. Describe the bug in the PR in the same fictional terms.

## Privacy guard

- `scripts/privacy.test.ts` runs with `pnpm test`, in CI, and in the pre-commit hook. It fails if inbox episodes, chronicle days, disputes, reviews, or `.age` files would be committed.
- Create a **local, gitignored** `.privacy-denylist` with your real names, places, IDs, and agent names, one per line. The guard then fails if any of them appears in a file that would be committed. Lines starting with `!` are phrases that are public on purpose (e.g. `!your-github-handle`) and are ignored.
- `pnpm pack:check` makes sure the npm package contains only the build, the template, and the fictional seeds.

## AI agents working on this repo

If your coding agent is also connected to your Hippocampus MCP server or your vault repo, it can read your private memory. Tell it (as [AGENTS.md](../AGENTS.md) does) that vault content is private and must not be copied into code, tests, docs, issues, or PRs. The guard catches files, not text an agent posts on GitHub.

## Evals

- **Public:** fictional golden tests only. Optionally, a fictional episode set for running real models.
- **Private:** keep evals built from your real memos inside your vault, e.g. `_hippo/evals/`. The vault loader ignores that folder. Run a new version or model against a copy of your vault before trusting it.

## Changing the vault format

If a change alters files in existing vaults (frontmatter keys, folder layout, region names):
1. Bump `CURRENT_VAULT_VERSION` in `packages/core/src/migrations.ts`.
2. Add a `Migration` that rewrites old vaults, with a test.
3. Note it under "Vault format" in [CHANGELOG.md](../CHANGELOG.md).

## Releasing

The version is in `apps/cli/package.json` (`@mehrad77/hippocampus`) and follows semver. Update `CHANGELOG.md`, then run:

```bash
pnpm build && pnpm pack:check
```

A maintainer then runs `npm publish` from `apps/cli`.
