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

## Demos

Use these for UI work, screenshots and bug reports. Everything in them is fictional.

- `pnpm dev:dashboard` runs the dashboard UI with hot reload against the demo campaign. `HIPPO_VAULT=<dir> pnpm dev:dashboard` uses a local vault instead, which is private data: never commit or share what it shows.
- `HIPPO_DEMO_HOSTED=1 pnpm dev:dashboard` puts a pretend hosted app in front of the demo: sign-in, waitlist, GitHub App install, vault setup, keys, curator, admin and account pages, with nothing touching GitHub. `GET /dashboard/api/__demo/stage?to=<stage>` jumps to a stage (`signed-out`, `waitlisted`, `requested`, `approved`, `installed`, `ready`).
- `./apps/cli/bin/hippo dashboard --demo` serves the built dashboard with the demo campaign, as users see it.

## The hosted app

`apps/worker` runs offline under `wrangler dev` against a fake GitHub (`apps/worker/scripts/fake-github.ts`). The fake has a GitHub App and two users with an empty private repo each: `player` (an admin) and `game-master`, for checking that one account never sees another's vault. Nothing is saved: restarting the fake empties the repos.

Write settings for the fake once (a gitignored `.dev.vars` with a fresh key):

```bash
pnpm --filter @hippocampus/worker dev:github --dev-vars > apps/worker/.dev.vars
```

Then, in two terminals:

```bash
pnpm --filter @hippocampus/worker dev:github
```

```bash
pnpm --filter @hippocampus/worker dev
```

Open http://127.0.0.1:8787/. `dev` builds the dashboard and applies the registry migrations to a local D1 first. Pass `--choose` to the fake to pick the user at each sign-in (use two browser profiles), or `--login game-master` to be the other one. Tests use the same pieces in memory (`apps/worker/src/hosted/testing.ts`, `FakeGitHub` in `packages/store-github`).

Never point the dev Worker at a real GitHub App or a real vault repo.

## The template bundle

The Worker has no filesystem, so `vault-template/` and `seeds/` are bundled into `packages/template/src/files.gen.ts` and turned into a vault by `buildVaultFiles` (`packages/core/src/bootstrap.ts`), the same function `hippo init` uses. After changing either folder:

```bash
pnpm gen:template
```

`scripts/gen-template.test.ts` fails while the bundle is stale. The bundle takes only what git would commit, so local `seeds/private-*` folders stay out.

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

## Tests and CI

`.github/workflows/ci.yml` runs three jobs in parallel on every pull request and push to `main`. On `main`, `release` runs only after all three pass, then `deploy` (see [Branches and releases](#branches-and-releases)).

- **check:** `pnpm typecheck`, `pnpm test` (every package's unit tests in Node, the privacy guard, and the checks in `scripts/`: the template bundle, the Claude Code plugin's manifests and skills, and what each shipped workflow does), `pnpm build` and `pnpm pack:check`.
- **worker:** the hosted Worker in the real Workers runtime. `bundle:check` builds it as `wrangler deploy --dry-run` would (no Cloudflare account) and checks the bundle's size, then again with the official instance's config stamped with stand-in ids (`scripts/deploy.mjs`). `smoke` (`apps/worker/scripts/smoke.ts`) starts the fake GitHub and `wrangler dev --local`, then walks it end to end: sign-in and the waitlist, installing the app, setting up a vault from the example seed, keys, MCP as an agent and as the curator (a whole sleep run), and that one account's keys never see another's vault.
- **workflows:** `scripts/lint-workflows.mjs` runs actionlint on this repo's workflows, the vault template's `validate.yml`, and the `sleep.yml` the hosted app writes into vault repos.

Run the Worker checks locally (they need the dashboard UI built, and leave `apps/worker/.dev.vars` and `.wrangler/` alone: everything goes in a temp dir):

```bash
pnpm --filter @hippocampus/dashboard-ui build
pnpm --filter @hippocampus/worker bundle:check
pnpm smoke:worker
```

`pnpm lint:workflows` needs [actionlint](https://github.com/rhysd/actionlint) on your `PATH` (or `ACTIONLINT=/path/to/actionlint`); without it, it skips locally and fails in CI.

## Branches and releases

`main` is protected. All changes land through pull requests, and CI (`check`, `worker` and `workflows`) must pass.

**Every merge to `main` releases the CLI automatically** (`release` job in `.github/workflows/ci.yml`):
1. The next version is computed from the conventional commits since the last `v*` tag (`scripts/release.mjs`):
   - `feat:` bumps minor
   - `fix:` and everything else bump patch
   - `!` or `BREAKING CHANGE:` bumps major (minor while below 1.0)
2. The version is stamped into the package at build time. Nothing is committed back to `main`: **the git tag is the version of record**, and `apps/cli/package.json`'s version only seeds the very first release.
3. The job publishes `@mehrad77/hippocampus` to npm with provenance, then pushes the `vX.Y.Z` tag and a GitHub Release with generated notes.

So write commit messages (or squash-merge PR titles) as conventional commits, because they decide the version. Record vault format changes under `[Unreleased]` in `CHANGELOG.md` in the same PR.

Preview the next version locally:

```bash
node scripts/release.mjs
```

**Publishing auth** uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC). CI stores no npm token, and every release carries provenance. The package's trusted publisher on npmjs.com is GitHub Actions, repo `mehrad77/hippocampus`, workflow `ci.yml`. The release step is idempotent: if a version is already on npm, CI only adds the missing tag and GitHub Release.

**Then the hosted app deploys** to the official instance (`tip` and `deploy` jobs). It deploys only after npm has the release, because the vault template the Worker writes runs `npx @mehrad77/hippocampus@0 …`. It deploys only if the commit is still `main`'s newest: when two merges land close together, the older run's deploy is skipped and the newer one deploys both. The `deploy` job:
1. Stamps the instance's host and resource ids into `apps/worker/wrangler.deploy.json` (gitignored), with `node scripts/deploy.mjs config`.
2. Applies the registry's migrations.
3. Runs `wrangler deploy`, tagged with the release's `vX.Y.Z` and the commit.
4. Probes the live Worker (`node scripts/deploy.mjs probe`).

If the probe fails, the job rolls the Worker back to the previous version and fails. Rollback restores code, never the registry's schema, which is why migrations must stay compatible with the previous Worker (see AGENTS.md).

## The official instance

The `production` environment in the repo's settings (deployment branches: `main` only) holds everything instance-specific:

| Name | Kind | What |
| --- | --- | --- |
| `HIPPO_HOST` | variable | The instance's hostname, served as a Workers Custom Domain |
| `CF_REGISTRY_DATABASE_ID` | variable | The `hippocampus-registry` D1 database's id |
| `CF_OAUTH_KV_ID` | variable | The `OAUTH_KV` namespace's id |
| `CLOUDFLARE_ACCOUNT_ID` | secret | The Cloudflare account |
| `CLOUDFLARE_API_TOKEN` | secret | Account-owned token: Workers Editor on the `hippocampus` Worker only, D1 Editor (on the registry, if the dashboard offers resource scope), and Workers Routes Write on the zone only if a deploy asks for it |

The Worker's own secrets (`HIPPO_PUBLIC_URL`, `HIPPO_ADMINS`, the GitHub App's) are set on Cloudflare with `wrangler secret` and persist across deploys. They never pass through CI.

**Setting it up** (once, by a maintainer, with their own `wrangler login`, before the first merge that deploys):
1. Check the zone is in the Cloudflare account, the hostname has no DNS record, and the rate limiters' `namespace_id`s (1001–1004) aren't used by another Worker there. Decide the D1 jurisdiction now (`--jurisdiction eu`): it can't be added later.
2. Create the GitHub App from [`apps/worker/github-app.manifest.json`](../apps/worker/github-app.manifest.json) with the instance's host (in a copy you don't commit). Note its slug, which may not be `hippocampus`. Convert its key to PKCS#8 ([USAGE.md §8](USAGE.md#running-your-own-instance), step 1).
3. `pnpm exec wrangler d1 create hippocampus-registry` and `pnpm exec wrangler kv namespace create OAUTH_KV`, in `apps/worker`.
4. Deploy once by hand, which creates the Worker, its Durable Object namespace and the Custom Domain:
   ```bash
   HIPPO_HOST=<host> CF_REGISTRY_DATABASE_ID=<id> CF_OAUTH_KV_ID=<id> node scripts/deploy.mjs config
   pnpm --filter @hippocampus/dashboard-ui build
   cd apps/worker
   pnpm exec wrangler d1 migrations apply REGISTRY --remote -c wrangler.deploy.json
   pnpm exec wrangler deploy -c wrangler.deploy.json --tag bootstrap
   ```
5. Set the Worker's secrets ([USAGE.md §8](USAGE.md#running-your-own-instance), step 3), with `HIPPO_PUBLIC_URL=https://<host>`: `pnpm exec wrangler secret bulk -c wrangler.deploy.json <file>`, from a file outside the repo that you delete afterwards.
6. Check it: `HIPPO_HOST=<host> node scripts/deploy.mjs probe`. Then by hand:
   - sign in;
   - install the app on a throwaway private repo;
   - mint a key and recall over MCP;
   - run one sleep;
   - uninstall and reinstall the app.
   Workers Logs should show no 500s and no `exceededCpu` (error 1102).
7. Create the CI token (above). Rehearse with it: deploy, probe, `pnpm exec wrangler rollback -c wrangler.deploy.json --message rehearsal`, deploy again.
8. Fill in the `production` environment, and make `check`, `worker` and `workflows` required checks on `main`.

**When a deploy fails:**
- **Before or during `wrangler deploy`:** production is still on the previous version. Fix the cause, then "Re-run failed jobs". The re-run deploys only if the commit is still `main`'s newest; otherwise the newer run deploys it.
- **At the probe:** the job has already rolled back. Read its log, which names what failed, never values.

Roll back by hand with the stamped config (step 4's first command):

```bash
pnpm exec wrangler rollback -c wrangler.deploy.json --message "<why>"
```

Run it in `apps/worker`. It can't cross a Durable Object class migration.

**Rotating the CI token:** create the new token, replace the environment secret, then delete the old token.

**Plan.** The instance starts on Workers Free. Move it to Workers Paid (a dashboard toggle, no code change) when any of these show up:
- `exceededCpu` (error 1102) in Workers Logs;
- Cloudflare's emails about KV or D1 daily limits;
- requests nearing 100,000 a day.

KV writes run out first: each sign-in, OAuth client registration and token refresh writes one, and Free allows 1,000 a day.
