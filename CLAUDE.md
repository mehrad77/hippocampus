@AGENTS.md

## Claude Code notes

- Run `pnpm test` (it includes the privacy guard) and `pnpm typecheck` before committing.
- If a Hippocampus MCP server is connected in this session, it serves the user's **private** memory. Never paste its content into this repo, its commit messages, or GitHub. Reproduce bugs with `seeds/example-relocation` names.
- Your own auto-memory lives outside this repo. Don't write vault facts into repo files as "notes".

### Environment

- The shell is zsh on macOS: quote globs (`grep -r --include='*.ts'`) and URLs with `?`. sed is BSD: `sed -i ''`, and no `\b`.
- Scratch scripts: `*.mts`, run with `node_modules/.bin/tsx` from the repo root. There is one `vitest.config.ts`, at the root; run one file with `pnpm vitest run <file>`.
- In a worktree: one simple command per call, absolute paths, the Edit tool for edits, and `git commit -F <file>` rather than heredocs.
- The privacy guard scans untracked files too (`git ls-files --others`), so a stray scratch file in the repo that holds a denylisted term or vault content fails `pnpm test`. Keep scratch files outside the repo.
- The dashboard dev server serves under `/dashboard/`. `.claude/launch.json` defines the dev servers: dashboard on 4400, dashboard-hosted on 4401, fake-github on 8786, worker on 8787.
- `pnpm lint:workflows` needs actionlint (`brew install actionlint`). Without it the script prints a skip and passes, except in CI.
