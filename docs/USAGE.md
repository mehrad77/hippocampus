# Using Hippocampus

Hippocampus is a **tool**. Your memory is a **vault**. They live in two different repositories:

```
github.com/<you>/<your-vault>   PRIVATE   your campaign: notes, inbox, chronicle, secrets
        │  uses (pinned version)
        ▼
@mehrad77/hippocampus            PUBLIC    the `hippo` CLI: init · serve · sleep · migrate · …
```

The vault depends on the tool, and the tool never knows about any vault. Nothing from your vault ever goes into the Hippocampus repo, its issues, or its PRs.

Requirements: Node 24+, git, and (for the nightly curator) [LM Studio](https://lmstudio.ai) or [Ollama](https://ollama.com), or an Anthropic or xAI API key.

## 0. The dashboard and Session Zero

Every step below can be done from the dashboard:

```bash
npx @mehrad77/hippocampus dashboard
```

If the current directory (or `-v`, or `HIPPO_VAULT`) is not a vault yet, the dashboard opens **Session Zero**, a guided setup. Each step says whether the dashboard *does* it on this machine or *shows* you what to run:

| Step | Done for you | Shown to copy |
| --- | --- | --- |
| Vault | create one from the template (optionally with a seed), open one, or connect a GitHub repo or MCP server | `hippo migrate` when the format is older |
| Party | add agents (`party/<id>.md`), including unknown agents seen in the inbox | |
| Secrets | forge the age key, or reuse the one on this machine | where to back it up |
| Curator | save the model settings and test them | key pages for hosted providers |
| Git | check that the GitHub repo is private | creating the repo and pushing (never done for you) |
| Agents | | connection snippets per party member |
| Sleep | install the nightly launchd job, and rehearse a dry run | a cron line on Linux |
| Remote | check a Worker URL, save embedding settings, rebuild the index | the Worker deploy commands |

Settings that Session Zero saves (curator model and key, default vault, Worker URL) go to `~/.config/hippocampus/env` (mode 0600; set `HIPPO_CONFIG_DIR` to move it). The CLI reads that file after the shell environment and a local `.env`, so those still win. Keys are never sent back to the browser.

After setup, the same command opens your campaign: the **Tavern** (what happened, what needs you), the **Quest board**, the **Council** (disputes), the **Satchel** (the inbox), the **Codex** with entity sheets, the relation **Map**, the **Chronicle**, the **Party**, and **Guides**. Use `--github you/my-campaign` for a vault on GitHub, or `--mcp https://…/mcp` with `HIPPO_MCP_TOKEN` for any Hippocampus MCP server. Over MCP, writes are filed as that token's agent and rulings aren't available. `--demo` opens a fictional campaign to explore.

The dashboard listens on 127.0.0.1 only. The terminal prints a one-time sign-in link that sets a cookie for that browser. Other local users and other websites can't use it. Secret values never reach the page, and secret-bearing inbox episodes are shown sealed.

## 1. Create your vault

Start from the empty template, the fictional example campaign, or your own seed directory:

```bash
npx @mehrad77/hippocampus init ~/vaults/my-campaign --seed example-relocation
```

Then:
- edit `_hippo/config.yaml`: set `campaign`, `human` (your id), `timezone`, and `domains` (your lanes)
- replace the example party in `party/` with your agents, one note each, with `lane` and `authority` domains
- open the folder in Obsidian and install the Dataview community plugin for the dashboards

## 2. Put it in a private repo

Create an **empty private** repository on GitHub, then:

```bash
cd ~/vaults/my-campaign && git add -A && git commit -m "chore: new vault" && git remote add origin git@github.com:<you>/<your-vault>.git && git push -u origin main
```

Optionally, use the [obsidian-git](https://github.com/Vinzent03/obsidian-git) plugin to sync your own edits.

## 3. Secrets

```bash
npx @mehrad77/hippocampus -v ~/vaults/my-campaign secrets keygen
```

This writes the public key into `_hippo/config.yaml` and the private identity to `~/.config/hippocampus/age-identity.txt`. **Back the identity up** (e.g. in a password manager). Without it, secret facts can't be decrypted. To read secrets:

```bash
npx @mehrad77/hippocampus -v ~/vaults/my-campaign secrets show passport
```

## 4. Connect your agents

Every agent should first read `HANDBOOK.md` in the vault. It's regenerated on every sleep and explains the conventions, the party, the lanes, and the active quests.

**GitHub path (works with any agent that can use GitHub):** give the agent access to the private vault repo and instruct it:
> Read HANDBOOK.md. To remember something, commit one new file to `inbox/<your-id>/`. Never edit other files.

**MCP path (local agents):**

```bash
claude mcp add hippocampus -- npx -y @mehrad77/hippocampus -v ~/vaults/my-campaign serve --agent game-master
```

Or serve over local HTTP at `http://127.0.0.1:8765/mcp?agent=<id>`:

```bash
npx @mehrad77/hippocampus -v ~/vaults/my-campaign serve --http 8765
```

Tools: `onboard`, `remember`, `recall`, `get`, `neighbors`, `ask_canon`, `briefing`, `update_quest`.

Search uses a persistent index in `~/.cache/hippocampus/` (or `$XDG_CACHE_HOME`). It stays in step with the vault on its own, re-indexing only notes that changed. It's a cache: `hippo index` rebuilds it, deleting it is harmless, and `--no-index` searches in memory instead.

**Semantic recall (optional).** Load an embedding model in LM Studio or Ollama and set `HIPPO_EMBED_MODEL`. Recall then also finds notes by meaning ("accommodation" finds the apartment hunt), fused with keyword matches and re-ranked along relations:

```bash
HIPPO_EMBED_PROVIDER=ollama HIPPO_EMBED_MODEL=bge-m3 npx @mehrad77/hippocampus -v ~/vaults/my-campaign index
```

Notes are embedded once and again only when they change. A multilingual model such as `bge-m3` suits vaults that mix languages. If the model server is down, search falls back to keywords. Raise `HIPPO_EMBED_MIN_SIMILARITY` (default 0.35) if unrelated notes show up. Changing the model re-embeds everything on the next run.

**Without a checkout:** every command except `init` can work on the GitHub repo directly. Each write becomes one commit through the GitHub API. If someone pushed to the same file in the meantime, the write is refused instead of overwriting their change. Use a fine-grained token with **Contents: read and write** on the vault repo only:

```bash
HIPPO_GITHUB_TOKEN=github_pat_… npx @mehrad77/hippocampus --github you/my-campaign serve --agent game-master
```

Append `#branch` to use a branch other than `main`, or set `HIPPO_GITHUB_REPO` instead of passing `--github`.

## 5. Nightly sleep

`sleep` does the following in order:
1. pulls the vault
2. applies your dispute rulings
3. consolidates the inbox with the LLM
4. writes summaries, `HANDBOOK.md`, and `_hippo/review.md`
5. commits as *Hippocampus* and pushes

Failed episodes stay in the inbox for the next night.

```bash
HIPPO_LLM_PROVIDER=lmstudio HIPPO_LLM_MODEL=google/gemma-4-26b-a4b-qat npx @mehrad77/hippocampus@0.1 -v ~/vaults/my-campaign sleep
```

With `--github you/my-campaign`, steps 1 and 5 collapse into a single commit made through the API, with no clone needed. Pin the version (`@0.1`) so upgrades are deliberate. To schedule it on macOS, let Session Zero install it (Setup → Nightly sleep), or use [ops/com.hippocampus.sleep.plist](../ops/com.hippocampus.sleep.plist). Elsewhere, use cron or systemd. Models that worked well locally are MoE models with ~4B active parameters. Very long "thinking" models can hit the per-call timeout (`HIPPO_LLM_TIMEOUT_MS`). See [.env.example](../.env.example) for all settings.

## 6. The daily loop

1. Open the dashboard's Tavern, or `_hippo/review.md` (the morning review). Both list disputes, unverified rumors, stale facts, orphan notes, and episodes that failed.
2. **Rule on disputes:** in the dashboard's Council, pick the right claim or type the value; it becomes canon immediately, by you. Or open the dispute note in Obsidian and set `ruling: <correct value>`, and the next sleep makes it canon.
3. Edit anything in Obsidian. Your word outranks every agent. The curator only rewrites `%% hippo:… %%` regions and the `facts`/`relations` properties, never your prose.
4. Tick quest objectives and turn clocks on the dashboard's Quest board, or directly in quest notes.

## 7. Upgrading

Bump the pinned version in your schedule and CI, then run:

```bash
npx @mehrad77/hippocampus@<new> -v ~/vaults/my-campaign migrate
```

The tool refuses to write to a vault whose format version differs from its own. `hippo validate` reports the mismatch, and `migrate` upgrades the files and `_hippo/config.yaml`'s `version`. Read [CHANGELOG.md](../CHANGELOG.md) for format changes.

## 8. Remote MCP on Cloudflare (optional)

`apps/worker` serves the same MCP tools from a Cloudflare Worker, so agents that can't run a local process can use the vault. It reads the vault repo through the GitHub API, keeps its search index in D1, and makes every write as one commit through a single writer (the Scribe Durable Object). If someone pushed to the same file in the meantime, the write is redone on top of their change or refused, never overwritten. Each agent gets its own bearer token, with scopes `read`, `remember` and `quest`.

From a clone of this repository:

```bash
cd apps/worker
pnpm exec wrangler d1 create hippocampus-index
pnpm exec wrangler kv namespace create TOKENS
```

Paste the two ids into `wrangler.jsonc` (keep that edit local). Then store the repo name and a fine-grained token (Contents: read and write on the vault repo only) as secrets, and deploy:

```bash
pnpm exec wrangler secret put GITHUB_REPO
pnpm exec wrangler secret put GITHUB_TOKEN
pnpm exec wrangler deploy
```

Mint a token per agent. It's printed once; only its hash is stored:

```bash
pnpm agent-token create game-master --scopes read,remember,quest --remote
```

Connect the agent:

```bash
claude mcp add --transport http hippocampus https://hippocampus.<your-subdomain>.workers.dev/mcp --header "Authorization: Bearer hippo_…"
```

Revoke with `pnpm agent-token revoke <token> --remote`. For semantic recall, uncomment the `ai` binding in `wrangler.jsonc` and run `wrangler secret put HIPPO_EMBED_PROVIDER` with the value `workers-ai` (it uses `@cf/baai/bge-m3`), or point the `HIPPO_EMBED_*` settings at any OpenAI-compatible embeddings API. The Worker doesn't run `sleep`, so keep the nightly run (with a checkout or with `--github`). A cold start downloads the vault as one tarball, which fits the free plan's subrequest limit, but parsing a large vault on every request needs the paid plan's CPU time.

**Connect Claude.ai or ChatGPT (OAuth).** Apps that add MCP servers as connectors sign in with OAuth instead of a token. The Worker is its own OAuth server: you approve each app on a consent page, choosing the agent it acts as and what it may do, then sign in with GitHub to prove you own the vault. To turn it on:

1. Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps). Set its callback URL to `https://hippocampus.<your-subdomain>.workers.dev/oauth/github/callback`.
2. Create the grant store, paste its id into `wrangler.jsonc` as `OAUTH_KV`, and set the settings as secrets:

   ```bash
   pnpm exec wrangler kv namespace create OAUTH_KV
   ```

   ```bash
   pnpm exec wrangler secret put HIPPO_PUBLIC_URL
   ```

   Then `HIPPO_OWNERS` (your GitHub login; only these accounts can connect apps), `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` the same way, and redeploy.
3. In the app, add a custom connector with the URL `https://hippocampus.<your-subdomain>.workers.dev/mcp`.

Agent tokens keep working next to OAuth. A connection lasts 30 days from when you approve it (the app refreshes its access in between); connect again to renew or to change its permissions.

**The dashboard on the Worker.** With OAuth on, the Worker also serves the dashboard at `https://hippocampus.<your-subdomain>.workers.dev/dashboard/`. Sign in with GitHub; only `HIPPO_OWNERS` get in. Owners are re-checked on every request, so removing a login takes effect at once. A session lasts 7 days and is kept in `OAUTH_KV`. Until OAuth is configured, the pages load but the API answers 503 and lists the missing settings. It uses the same GitHub OAuth app with the callback `…/oauth/github/callback/dashboard`. GitHub accepts it as a subdirectory of the registered callback; if your app refuses it, add it as a second callback URL. Its Setup page shows the Worker's health and lets you mint, list and revoke agent tokens without the CLI. `deploy` builds the dashboard first.

For local development, copy `.dev.vars.example` to `.dev.vars` and run `pnpm --filter @hippocampus/worker dev`. Mint local tokens with `pnpm agent-token create <agent>` (no `--remote`).

## 9. Vault CI (optional)

`hippo init` adds `.github/workflows/validate.yml` to your vault. On every push, including agents' inbox commits, it checks that the vault still loads. It also contains a commented-out nightly `sleep` job for hosted models, since a CI runner can't reach your local LM Studio.
