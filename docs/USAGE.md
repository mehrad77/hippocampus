# Using Hippocampus

Hippocampus is a **tool**. Your memory is a **vault**. They live in two different repositories:

```
github.com/<you>/<your-vault>   PRIVATE   your campaign: notes, inbox, chronicle, secrets
        │  uses (pinned version)
        ▼
@mehrad77/hippocampus            PUBLIC    the `hippo` CLI: init · serve · sleep · migrate · …
```

The vault depends on the tool, and the tool never knows about any vault. Nothing from your vault ever goes into the Hippocampus repo, its issues, or its PRs.

There are two ways to run it:

- **The hosted app** (§8): sign in with GitHub, and the app keeps your vault in a private repo you own, serves MCP to your agents, and lets one of them curate. You need only a GitHub account. You can also run your own instance on Cloudflare.
- **The local CLI** (§0–§7): `hippo` on your own machine. Requirements: Node 24+, git, and (for the nightly curator) [LM Studio](https://lmstudio.ai) or [Ollama](https://ollama.com), an Anthropic or xAI API key, or an agent of your own (§5).

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
| Remote | check a hosted app's URL, save embedding settings, rebuild the index | where to use a hosted app, or how to run your own |

Settings that Session Zero saves (curator model and key, default vault, hosted app URL) go to `~/.config/hippocampus/env` (mode 0600; set `HIPPO_CONFIG_DIR` to move it). The CLI reads that file after the shell environment and a local `.env`, so those still win. Keys are never sent back to the browser.

After setup, the same command opens your campaign: the **Tavern** (what happened, what needs you), the **Quest board**, the **Council** (disputes), the **Satchel** (the inbox), the **Codex** with entity sheets, the relation **Map**, the **Chronicle**, the **Party**, and **Guides**. Use `--github you/my-campaign` for a vault on GitHub, or `--mcp https://…/mcp` with `HIPPO_MCP_TOKEN` for any Hippocampus MCP server. Over MCP, writes are filed as that token's agent and rulings aren't available. `--demo` opens a fictional campaign to explore.

The dashboard has two looks, set under **Setup & health → Personalization** (the last card) and saved in your browser:
- **Plain** (the default): IBM Carbon design, everyday names (Home, Goals, Disputes, Inbox, Records, Timeline, Agents) and Confirmed/Unverified for fact status.
- **Campaign codex**: the tabletop look and names used in this guide.

Personalization also sets the colors (match your device, light or dark) and the text size.

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

Every agent should first call `onboard` (or read `HANDBOOK.md` in the vault). The handbook is regenerated on every sleep and explains the conventions, the party, the lanes, and the active quests.

**MCP (local agents):**

```bash
claude mcp add hippocampus -- npx -y @mehrad77/hippocampus -v ~/vaults/my-campaign serve --agent game-master
```

Or serve over local HTTP at `http://127.0.0.1:8765/mcp?agent=<id>`:

```bash
npx @mehrad77/hippocampus -v ~/vaults/my-campaign serve --http 8765
```

Tools: `onboard`, `introduce`, `remember`, `recall`, `get`, `neighbors`, `ask_canon`, `briefing`, `update_quest`, plus the curator's `sleep_*` tools (§5). For remote agents and Claude.ai or ChatGPT connectors, use the hosted app (§8).

Agent ids are exact: lowercase letters, digits and dashes, matching `party/<id>.md`. Your own id (the config's `human`) and the reserved ids `human`, `curator`, `unknown` and `hippocampus` are refused. An agent without a party sheet can still write, but its memories count as rumors until you approve it (§6). One `remember` call takes at most 8 KB; split longer memories.

**Inbox files (local tools without MCP):** a tool that can't speak MCP may write one new file per memory to `inbox/<its-id>/`, in the format `HANDBOOK.md` shows. It must never edit other files. The vault's `AGENTS.md` tells agents to use MCP instead, since the tools run the checks.

Search uses a persistent index in `~/.cache/hippocampus/` (or `$XDG_CACHE_HOME`). It stays in step with the vault on its own, re-indexing only notes that changed. It's a cache: `hippo index` rebuilds it, deleting it is harmless, and `--no-index` searches in memory instead.

**Semantic recall (optional).** Load an embedding model in LM Studio or Ollama and set `HIPPO_EMBED_MODEL`. Recall then also finds notes by meaning ("accommodation" finds the apartment hunt), fused with keyword matches and re-ranked along relations:

```bash
HIPPO_EMBED_PROVIDER=ollama HIPPO_EMBED_MODEL=bge-m3 npx @mehrad77/hippocampus -v ~/vaults/my-campaign index
```

Notes are embedded once and again only when they change. A multilingual model such as `bge-m3` suits vaults that mix languages. If the model server is down, search falls back to keywords. Raise `HIPPO_EMBED_MIN_SIMILARITY` (default 0.35) if unrelated notes show up. Changing the model re-embeds everything on the next run.

**Without a checkout:** every command except `init` and `audit` can work on the GitHub repo directly. Each write becomes one commit through the GitHub API. If someone pushed to the same file in the meantime, the write is refused instead of overwriting their change. Use a fine-grained token with **Contents: read and write** on the vault repo only:

```bash
HIPPO_GITHUB_TOKEN=github_pat_… npx @mehrad77/hippocampus --github you/my-campaign serve --agent game-master
```

Append `#branch` to use a branch other than `main`, or set `HIPPO_GITHUB_REPO` instead of passing `--github`.

## 5. The curator (sleep)

Sleep turns the inbox into canon. It does the following in order:
1. applies your dispute rulings
2. consolidates the inbox, one episode at a time
3. writes summaries, `HANDBOOK.md`, and `_hippo/review.md`
4. audits the change set and commits it as *Hippocampus*

Failed or skipped episodes stay in the inbox for the next run. There are two ways to run it.

### With a model: `hippo sleep`

`hippo sleep` runs the pipeline with a model you configure, and adds git around it (pull first, then commit and push):

```bash
HIPPO_LLM_PROVIDER=lmstudio HIPPO_LLM_MODEL=google/gemma-4-26b-a4b-qat npx @mehrad77/hippocampus@0.1 -v ~/vaults/my-campaign sleep
```

With `--github you/my-campaign`, the pull and push collapse into a single commit made through the API, with no clone needed. Pin the version (`@0.1`) so upgrades are deliberate. To schedule it on macOS, let Session Zero install it (Setup → Nightly sleep), or use [ops/com.hippocampus.sleep.plist](../ops/com.hippocampus.sleep.plist). Elsewhere, use cron or systemd. Models that worked well locally are MoE models with ~4B active parameters. Very long "thinking" models can hit the per-call timeout (`HIPPO_LLM_TIMEOUT_MS`). See [.env.example](../.env.example) for all settings.

Before it writes, `hippo sleep` audits its own changes (§9) and refuses the commit if, for example, a secret value would land in a note in plain text.

### With an agent: agent-run sleep

An agent you trust can be the curator instead. It holds a **curator key** (scope `curate`), which adds five tools and a prompt:

| Tool | What it does |
| --- | --- |
| `sleep_start` | Opens a run (one at a time per vault) and returns the first questions |
| `sleep_answer` | Answers questions; each answer is checked against its JSON Schema |
| `sleep_skip` | Leaves an unclear episode in the inbox for you |
| `sleep_status` | The open run and the last runs |
| `sleep_abort` | Stops the open run. What it committed stays |

Each question is one step of the pipeline above, with instructions, input and a schema. The server does the bookkeeping and commits; the agent makes the judgment calls. A run holds a 15-minute lease that every answer renews. If the agent stops answering, the run expires on its own and the rest stays in the inbox. The MCP prompt `sleep` gives the agent the full procedure.

The curator sees every new memory in full, secret ones in plain text, so its model's provider does too. Pick an agent and provider you'd trust with that.

**The Claude Code plugin.** This repo is also a Claude Code plugin marketplace. The plugin connects Claude Code to a vault over HTTP (it reads `HIPPO_MCP_URL` and `HIPPO_KEY`) and adds two skills: `/hippocampus:memory` for everyday agents, and `/hippocampus:sleep` for the curator.

```bash
claude plugin marketplace add mehrad77/hippocampus
claude plugin install hippocampus@hippocampus
```

```bash
export HIPPO_MCP_URL=https://<your-instance>/mcp
export HIPPO_KEY=<your curator key>
```

Then run `/hippocampus:sleep` in Claude Code. Without the plugin, the server's prompt does the same: `/mcp__hippocampus__sleep`.

**On a schedule.** Once a day suits most vaults; every hour suits agents that write a lot. A cron line on a machine that's on at that hour:

```bash
30 3 * * * HIPPO_MCP_URL=https://<your-instance>/mcp HIPPO_KEY=<your curator key> claude -p "/hippocampus:sleep" --allowedTools "mcp__hippocampus__*"
```

Scheduled tasks in Claude Code, Claude Desktop or Cursor work too. Schedule this prompt where the server is connected with the curator key: "Run the Hippocampus sleep procedure as the vault's curator: call sleep_start with your model name, then answer its questions until the run is done."

**The Actions curator (hosted app).** On the hosted app's setup page you can turn on a workflow, `.github/workflows/sleep.yml`, which the app adds to your vault repo. It runs Claude nightly on GitHub Actions with the curator key, through MCP only. It doesn't check the repo out, and its GitHub token has no permissions. It needs, under the repo's Settings → Secrets and variables → Actions:

| Name | Kind | Value |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Secret | An Anthropic API key; runs are billed to it |
| `HIPPO_CURATOR_KEY` | Secret | A curator key |
| `HIPPO_MCP_URL` | Variable | The vault's MCP URL, from the setup page |
| `HIPPO_CURATOR_MODEL` | Variable | Optional: `sonnet` (default) or `opus`, say |

Turning it off on the setup page removes the file.

**Locally.** `hippo serve` offers the same tools, with no key: connect your agent with `claude mcp add hippocampus -- npx -y @mehrad77/hippocampus -v ~/vaults/my-campaign serve` and run `/mcp__hippocampus__sleep`. Commit and push the result yourself, or keep using `hippo sleep`.

### House rules

`_hippo/curator.md` in your vault holds the curator's house rules, in plain words: what to keep, how to match notes, how careful to be with facts and secrets. Whichever curator runs sleep follows them on top of its built-in rules. Edit them like any note; changes apply from the next run. Vaults from older versions don't have the file; `hippo sleep` and the relay then use only the built-in rules.

## 6. The daily loop

1. Open the dashboard's Tavern, or `_hippo/review.md` (the morning review). Both list disputes, unverified rumors, stale facts, orphan notes, and episodes that failed.
2. **Rule on disputes:** in the dashboard's Council, pick the right claim or type the value; it becomes canon immediately, by you. Or open the dispute note in Obsidian and set `ruling: <correct value>`, and the next sleep makes it canon.
3. **Approve introductions:** an agent that isn't in the party yet can call `introduce` with a title, its lane, host, model and a few lines about itself. It lands in `inbox/<agent>/_introduction-<id>.md` and shows on the Party page and in the Tavern. **Approve** adds `party/<agent>.md` with the authority domains you choose; **Dismiss** removes the introduction, and the agent's word stays a rumor. Older tools ignore these files (the `_` prefix), so no format change was needed.
4. Edit anything in Obsidian. Your word outranks every agent. The curator only rewrites `%% hippo:… %%` regions and the `facts`/`relations` properties, never your prose.
5. Tick quest objectives and turn clocks on the dashboard's Quest board, or directly in quest notes.

## 7. Upgrading

Bump the pinned version in your schedule and CI, then run:

```bash
npx @mehrad77/hippocampus@<new> -v ~/vaults/my-campaign migrate
```

The tool refuses to write to a vault whose format version differs from its own. `hippo validate` reports the mismatch, and `migrate` upgrades the files and `_hippo/config.yaml`'s `version`. Read [CHANGELOG.md](../CHANGELOG.md) for format changes.

## 8. The hosted app

`apps/worker` is a multi-user Hippocampus on Cloudflare. People sign in with GitHub; each keeps their vault in a private repo of their own, which the app reads and writes through a GitHub App installed on that one repo. It serves MCP for agents, the dashboard for the human, and agent-run sleep. [SECURITY.md](../SECURITY.md) says what an operator can and can't see.

### Using a hosted instance

1. **Sign in** with GitHub on the instance's welcome page and ask for access, with an optional note. An admin approves accounts by hand; the setup page unlocks once you're in.
2. **Create a private repo.** The setup page opens GitHub's form, filled in (`vault`, private). It must be empty, or hold only a README, LICENSE or .gitignore. A repo that already holds a Hippocampus vault is adopted instead: only missing guardrail files are added.
3. **Install the app** on that repo only. GitHub asks you to authorize it, then sends you back.
4. **Pick the repo and name the campaign:** your id, time zone and domains, optionally the fictional example campaign. A key for secret facts is made in your browser; download the key file and keep it safe. Only its public half goes into the vault.
5. **Set up the vault.** One commit puts the template into the repo.
6. **Connect agents** (below) and **set up a curator** (§5).

**Keys.** The setup page mints keys, shows each one once, and stores only its hash. Revoking one stops it at once.

| Kind | Scopes | For |
| --- | --- | --- |
| Agent key | `read`, `remember`, `quest` | Any of your agents. Each names itself (`agent`) on every call |
| Single-agent key | `read` plus your choice of `remember` and `quest` | One agent, bound to its id |
| Curator key | `read`, `curate` | The agent that runs sleep. It sees secret memories in plain text while curating |

```bash
claude mcp add --transport http hippocampus https://<your-instance>/mcp --header "Authorization: Bearer hippo_…"
```

The setup page also gives snippets for `.mcp.json`, Cursor and VS Code, and the Claude Code plugin (§5).

**Connectors (Claude.ai, ChatGPT).** Add a custom connector with the URL `https://<your-instance>/mcp`. The app signs you in with GitHub and shows a consent page for your vault: pick the agent id the app acts as (a party member, or a new one you can seat right away) and what it may do. Allowing curating makes the app a curator, with a curator key's view of secrets. Your account menu lists connected apps and disconnects them.

**Reconnecting.** If the app is uninstalled or suspended, the repo is removed from the installation or deleted, or the repo is made public, the vault is disconnected and stops answering. The setup page says why. Undo it on GitHub (install again, make the repo private) and it reconnects.

**Limits.** Per vault: 2,000 episodes waiting in the inbox, 20 waiting introductions, 20,000 files, 50 MB of text, 24 sleep runs a day, and 50 keys. Requests are rate-limited per key, account and IP. An admin can raise these for one vault (`POST /dashboard/api/admin/vaults/quotas` with `{"id", "quotas": {"sleepRunsPerDay": 96}}`); `null` restores the defaults.

**Deleting your account.** Your account menu deletes everything the app holds for you, after you type your GitHub login: keys stop working, connected apps are signed out, the GitHub App is uninstalled, and your account and your vault's index and cache are erased. Your vault repo stays on GitHub, untouched.

### Running your own instance

From a clone of this repository, with Node 24 and a Cloudflare account. The Workers paid plan is recommended: loading a large vault takes more CPU time than the free plan allows.

**1. Create the GitHub App.** [`apps/worker/github-app.manifest.json`](../apps/worker/github-app.manifest.json) lists its settings. Either register it [from the manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) after replacing `hippocampus.example.workers.dev` with your Worker's host, or create it by hand under GitHub → Settings → Developer settings → GitHub Apps → New GitHub App:

| Setting | Value |
| --- | --- |
| Callback URL | `https://<your-host>/oauth/github/callback` |
| Request user authorization (OAuth) during installation | On |
| Webhook URL | `https://<your-host>/github/webhook`, with a random secret |
| Repository permissions | Contents: read and write · Workflows: read and write · Metadata: read |
| Subscribe to events | Installation repositories, Repository |
| Where it can be installed | Any account, if other people will sign up |

On the app's page, note the App ID, the slug (the last part of its public URL) and the Client ID, generate a client secret, and generate a private key. GitHub hands out PKCS#1 keys, which the Worker can't read, so convert it:

```bash
openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
```

**2. Create the Cloudflare resources** and paste their ids into `apps/worker/wrangler.jsonc` (keep that edit local):

```bash
cd apps/worker
pnpm exec wrangler d1 create hippocampus-registry
pnpm exec wrangler kv namespace create OAUTH_KV
```

The rate limiters' `namespace_id`s only need to be unique within your account.

**3. Set the secrets.** Each with `pnpm exec wrangler secret put <NAME>`:

| Secret | Value |
| --- | --- |
| `HIPPO_PUBLIC_URL` | The Worker's https origin, like `https://hippocampus.<your-subdomain>.workers.dev` |
| `HIPPO_ADMINS` | GitHub user ids (numbers, comma-separated) of the people who approve accounts. Find yours with `gh api users/<login> --jq .id` |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | From the app's page |
| `GITHUB_APP_WEBHOOK_SECRET` | The webhook secret you chose |
| `GITHUB_APP_PRIVATE_KEY` | The PKCS#8 key: `pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pkcs8.pem` |

Until they're all set, the Worker answers with a page naming the missing ones (names only, never values).

**4. Deploy.** From the repository root. This builds the dashboard, applies the registry's migrations (`apps/worker/migrations/`), then deploys:

```bash
pnpm deploy:worker
```

Run it again to upgrade. To serve a custom domain, add it to `wrangler.jsonc` as `"routes": [{ "pattern": "<your-host>", "custom_domain": true }]` with `"workers_dev": false`. The Worker answers on one origin only, the one in `HIPPO_PUBLIC_URL`.

Sign in at your Worker's address. Admins are approved on sign-in and find an Admin page in their account menu, where they approve or deny the waitlist and see which vaults exist (names and states, never content).

**Semantic recall (optional).** Uncomment the `ai` binding in `wrangler.jsonc` and set `HIPPO_EMBED_PROVIDER` to `workers-ai` (it uses `@cf/baai/bge-m3`), or point the `HIPPO_EMBED_*` settings at any OpenAI-compatible embeddings API. `HIPPO_EMBED_DAILY_LIMIT` caps the texts embedded per vault per day (default 5000); past it, search falls back to keywords until the next day.

**Logs.** Invocation logs are off in `wrangler.jsonc`, since they would record every request's URL. The Worker logs one line per request itself: the route name, status, timing and a hashed vault id, never content or error messages.

**Upgrading from the single-vault Worker.** Deployments from before the hosted app need a few one-time steps; see [MIGRATING-WORKER.md](MIGRATING-WORKER.md).

**Local development** runs against a fake GitHub; see [DEVELOPING.md](DEVELOPING.md#the-hosted-app).

## 9. Vault CI and `hippo audit` (optional)

`hippo init` and the hosted app add `.github/workflows/validate.yml` to your vault. It has two jobs:

- **validate**, on every push and pull request (except pushes that only add inbox memories, and the app's own `[skip ci]` commits): checks that the vault still loads.
- **audit**, once a day: runs `hippo audit` over the last day's commits.

Every commit Hippocampus makes names its actor in a trailer: `Hippo-Actor: agent:<id>`, `curator`, `human` or `bootstrap`. The curator's commits also carry `Hippo-Model` (and, from the relay, `Hippo-Curator` and `Hippo-Run`). `hippo audit` checks each commit with a non-human actor against what that actor may do:

- agents only add episodes and introductions to their own inbox folder (and edit quests with the `quest` scope);
- the curator writes canon, the chronicle, disputes and secrets, but never your prose, facts you set, the config, the party or the vault's CI, and never writes a secret in plain text;
- the human (no trailer, or `human`) may change anything.

```bash
npx @mehrad77/hippocampus -v ~/vaults/my-campaign audit --since "7 days ago"
```

`--range a..b` audits a revision range instead. It prints commit, path and rule, never content, and exits 1 on a violation. The hosted app runs the same checks before every commit, so a violation in a hosted vault means a commit that didn't come through the app. Trailers are claims: they catch bugs and misbehaving models, not someone who can push to the repo.

## 10. Guardrail files

New vaults (and vaults the hosted app adopts) get files that tell agents and tools the rules:

| File | What it says |
| --- | --- |
| `AGENTS.md` | To any AI agent that opens the repo: use the MCP tools, don't edit files, never write secrets outside `remember` with `secret: true` |
| `CLAUDE.md` | Points Claude Code at `AGENTS.md` |
| `_hippo/curator.md` | The curator's house rules (§5) |
| `.github/workflows/validate.yml` | Vault CI (§9) |

To add them to an older vault, copy them from [`vault-template/`](../vault-template/) of the version you run.
