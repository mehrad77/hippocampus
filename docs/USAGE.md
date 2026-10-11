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
| Vault | create one from the template (optionally with a seed and presets), open one, or connect a GitHub repo or MCP server | `hippo migrate` when the format is older |
| Party | add agents (`party/<id>.md`), including unknown agents seen in the inbox | |
| Secrets | forge the age key, or reuse the one on this machine | where to back it up |
| Curator | save the model settings and test them | key pages for hosted providers |
| Git | check that the GitHub repo is private | creating the repo and pushing (never done for you) |
| Agents | | connection snippets per party member |
| Sleep | install the nightly launchd job, and rehearse a dry run | a cron line on Linux |
| Remote | check a hosted app's URL, save embedding settings, rebuild the index | where to use a hosted app, or how to run your own |

Settings that Session Zero saves (curator model and key, default vault, hosted app URL) go to `~/.config/hippocampus/env` (mode 0600; set `HIPPO_CONFIG_DIR` to move it). The CLI reads that file after the shell environment and a local `.env`, so those still win. Keys are never sent back to the browser.

After setup, the same command opens your campaign: the **Tavern** (what happened, what needs you, who you're overdue to contact), **Goals**, the **Council** (disputes, proposals and possible duplicates), the **Satchel** (the inbox), the **Codex** with entity sheets, the relation **Map**, the **Chronicle**, the **Party**, and **Guides**. Use `--github you/my-campaign` for a vault on GitHub, or `--mcp https://…/mcp` with `HIPPO_MCP_TOKEN` for any Hippocampus MCP server. Over MCP, writes are filed as that token's agent and rulings aren't available. `--demo` opens a fictional campaign to explore.

The dashboard has two looks, set under **Setup & health → Personalization** (the last card) and saved in your browser:
- **Plain** (the default): IBM Carbon design, everyday names (Home, Goals, Disputes, Inbox, Records, Timeline, Agents) and Confirmed/Unverified for fact status.
- **Campaign codex**: the tabletop look and names used in this guide.

Personalization also sets the colors (match your device, light or dark) and the text size.

The dashboard listens on 127.0.0.1 only. The terminal prints a one-time sign-in link that sets a cookie for that browser. Other local users and other websites can't use it. Secret values never reach the page, and secret-bearing inbox episodes are shown sealed.

## 1. Create your vault

Start from the empty template, the fictional example campaign, or your own seed directory, and add presets for what the memory is for:

```bash
npx @mehrad77/hippocampus init ~/vaults/my-memory --name "Harbor term" --human sam --preset people student
npx @mehrad77/hippocampus init ~/vaults/my-campaign --seed example-relocation
```

| Flag | |
| --- | --- |
| `--name <name>` | What the memory is about (`--campaign` is the older name) |
| `--human <id>` | A human's id. Repeat it for several people sharing the vault, the primary one first (default `player`) |
| `--preset <name…>` | Presets to add (below) |
| `--seed <name-or-path>` | Copy a seed: a bundled name or a directory |
| `--timezone`, `--domains` | Chronicle days, and the lanes agents can hold authority over |

Then:
- check `_hippo/config.yaml`: `name`, `humans` (give a human `domains` to make them the authority there, and `github:` or, for a vault on GitLab, `gitlab:` for the hosted dashboard), `timezone`, `domains`
- replace the example party in `party/` with your agents, one note each, with `lane` and `authority` domains
- open the folder in Obsidian and install the Dataview community plugin for the dashboards

**Humans.** Everyone listed under `humans` outranks every agent; between humans, the one whose `domains` cover a field wins, and otherwise they dispute. The first is the primary human: a value without `by` is theirs, and the dashboard acts as them unless `hippo dashboard --as <id>` (or, on the hosted app, the signed-in GitHub login, or the connected GitLab username on a GitLab vault) says otherwise.

**Types and kinds.** What the vault holds is written down in it: one note per entity type in `_hippo/schema/types/` (folder, fields, statuses, description and `## Is` / `## Is not` examples the curator reads) and one per episode kind in `_hippo/schema/kinds/`. Edit them like any note. A field can be `human_only` (agents can only propose a value), `secret`, `confidential`, an `identity_key` (an email or url that says two notes are one thing), `succession` (a new employer closes the old one), or `recurs: yearly` (a birthday in the briefing). `hippo validate` lists notes that don't fit, as advice.

**Presets** are bundles of type and kind notes, templates and starter notes:

| Preset | Adds |
| --- | --- |
| `people` | archetypes (stranger, colleague, close friend, family, recruiter, landlord, professor, bureaucrat) with stakes, autonomy (draft, routine, any) and contact cadence that people `extends:`; groups; email, phone and handle as identity keys, birthdays, employer, title and city as succession, sensitivities only you set; your voice per language and `## Never say` / `## Boundaries` sections on your own note; `rollup` (one conversation's numbers, no text) and `moment` kinds |
| `developer` | repositories (url as identity key) and services, `depends_on` ↔ `used_by`, an `incident` kind; decisions logged on the repo they shape |
| `business` | clients, deals and invoices as goals with their own statuses, a `commitment` kind that opens a deal, the `sales` domain |
| `student` | courses (code as identity key), assignments as goals that can repeat weekly, a `lecture` kind kept as a gist |
| `household` | assets (warranty date, secret serial number), chores and bills as repeating goals, a `purchase` kind |

```bash
npx @mehrad77/hippocampus preset list
npx @mehrad77/hippocampus -v ~/vaults/my-memory preset add developer
```

`preset add` copies what the vault doesn't have, merges the preset's fields into your existing types, adds its domains and relations to the config, appends its sections to your note when they're missing, and commits exactly those files. It never replaces a file you have unless you pass `--force`.

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

Every agent should first call `onboard` (or read `HANDBOOK.md` in the vault). The handbook is regenerated on every sleep and explains the conventions, the vault's types and kinds, the party, the lanes, and the open goals.

**MCP (local agents):**

```bash
claude mcp add hippocampus -- npx -y @mehrad77/hippocampus -v ~/vaults/my-campaign serve --agent game-master
```

Or serve over local HTTP at `http://127.0.0.1:8765/mcp?agent=<id>`:

```bash
npx @mehrad77/hippocampus -v ~/vaults/my-campaign serve --http 8765
```

Tools: `onboard`, `introduce`, `remember`, `recall`, `get`, `neighbors`, `ask_canon`, `briefing` (with `about`, a brief on one person before contacting them), `update_goal` (`update_quest` still works), plus the curator's `sleep_*` tools (§5).

`remember` takes any of the vault's kinds with its typed `data`, for example a call that is only data: `kind: interaction, data: { with: "[[migration-agency]]", channel: call }`. `scope` says where a memory holds (`lang:pt`), and `confidential: true` keeps it out of search, summaries and the chronicle. From the terminal: `hippo remember -k moment --data with=[[migration-agency]] --data trigger=first_contact "First message, in Portuguese"`.

**Confidential** values stay in your notes but out of search, summaries, the chronicle and every agent's view, except an agent bound to its id (a single-agent key, an OAuth connection, `serve --agent`) with authority over them. The curator sees them while curating. For remote agents and Claude.ai or ChatGPT connectors, use the hosted app (§8).

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

**The Claude Code plugin.** This repo is also a Claude Code plugin marketplace. The plugin connects Claude Code to a vault over HTTP (it reads `HIPPO_MCP_URL` and `HIPPO_KEY`) and adds three skills: `/hippocampus:memory` for everyday agents, `/hippocampus:sleep` for the curator, and `/hippocampus:sleep-setup` to set up nightly sleep.

```bash
claude plugin marketplace add mehrad77/hippocampus
claude plugin install hippocampus@hippocampus
```

```bash
export HIPPO_MCP_URL=https://<your-instance>/mcp/<vault id>
export HIPPO_KEY=<your curator key>
```

The plugin's environment is one vault. For a project that should use another, set both in that project's `.claude/settings.local.json` (`"env": { "HIPPO_MCP_URL": "…", "HIPPO_KEY": "…" }`).

Then run `/hippocampus:sleep` in Claude Code. Without the plugin, the server's prompt does the same: `/mcp__hippocampus__sleep`.

**On a schedule.** Once a day suits most vaults; every hour suits agents that write a lot. A cron line on a machine that's on at that hour:

```bash
30 3 * * * HIPPO_MCP_URL=https://<your-instance>/mcp HIPPO_KEY=<your curator key> claude -p "/hippocampus:sleep" --allowedTools "mcp__hippocampus__*"
```

Scheduled tasks in Claude Code, Claude Desktop or Cursor work too. Schedule this prompt where the server is connected with the curator key: "Run the Hippocampus sleep procedure as the vault's curator: call sleep_start with your model name, then answer its questions until the run is done."

**The Actions curator (hosted app).** On the hosted app's setup page you can turn on a workflow, `.github/workflows/sleep.yml`, which the app adds to your vault repo. It runs Claude nightly on GitHub Actions with the curator key, through MCP only. It doesn't check the repo out, and its GitHub token has no permissions. It needs, under the repo's Settings → Secrets and variables → Actions:

| Name | Kind | Value |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Secret | A token from your Claude subscription (Pro or Max): run `claude setup-token`. Runs count against the subscription's usage, with no API bill |
| `ANTHROPIC_API_KEY` | Secret | Or an Anthropic API key; runs are billed to it. Set one of the two |
| `HIPPO_CURATOR_KEY` | Secret | A curator key |
| `HIPPO_MCP_URL` | Variable | The vault's MCP URL, from the setup page |
| `HIPPO_CURATOR_MODEL` | Variable | Optional: `sonnet` (default) or `opus`, say |

Turning it off on the setup page removes the file.

**Locally.** `hippo serve` offers the same tools, with no key: connect your agent with `claude mcp add hippocampus -- npx -y @mehrad77/hippocampus -v ~/vaults/my-campaign serve` and run `/mcp__hippocampus__sleep`. Commit and push the result yourself, or keep using `hippo sleep`.

### House rules

`_hippo/curator.md` in your vault holds the curator's house rules, in plain words: what to keep, how to match notes, how careful to be with facts and secrets. Whichever curator runs sleep follows them on top of its built-in rules. Edit them like any note; changes apply from the next run. Vaults from older versions don't have the file; `hippo sleep` and the relay then use only the built-in rules.

## 6. The daily loop

1. Open the dashboard's Tavern, or `_hippo/review.md` (the morning review). Both list disputes, proposals, possible duplicates, new guidelines, unverified rumors, stale facts, shape notes, orphan notes, and episodes that failed.
2. **Rule on disputes:** in the dashboard's Council, pick the right claim or type the value; it becomes canon immediately, by you. Or open the dispute note in Obsidian and set `ruling: <correct value>`, and the next sleep makes it canon. **Proposals** (an agent's value for a field only you set) and **possible duplicates** are accepted or declined the same way.
3. **Approve introductions:** an agent that isn't in the party yet can call `introduce` with a title, its lane, host, model and a few lines about itself. It lands in `inbox/<agent>/_introduction-<id>.md` and shows on the Party page and in the Tavern. **Approve** adds `party/<agent>.md` with the authority domains you choose; **Dismiss** removes the introduction, and the agent's word stays a rumor. Older tools ignore these files (the `_` prefix), so no format change was needed.
4. Edit anything in Obsidian. Your word outranks every agent. The curator only rewrites `%% hippo:… %%` regions and the `facts`/`relations` properties, never your prose.
5. Tick objectives, move progress and set due dates and repeats on the dashboard's Goals page, or directly in goal notes. A repeating goal (rent every month, a weekly problem set) comes back with its next due date when it's done.
6. Recount contact stats from the chronicle with `hippo fmt --stats` if you edited them by hand.

## 7. Upgrading

Bump the pinned version in your schedule and CI, then run:

```bash
npx @mehrad77/hippocampus@<new> -v ~/vaults/my-campaign migrate
```

The tool refuses to write to a vault whose format version differs from its own. `hippo validate` reports the mismatch (this release still passes a v1 vault, with a hint, so pinned CI keeps working), and `migrate` upgrades the files and `_hippo/config.yaml`'s `version`. In a git vault it commits exactly the files it changed, as `Hippo-Actor: migration`; `--dry-run` lists them. It prints what it couldn't carry over as it was (an extra clock becomes an objective, for example). The hosted app never migrates by itself: until the owner clicks Upgrade on the dashboard, agents get `VAULT_UPGRADE_NEEDED` and the dashboard shows only the Upgrade banner. Read [CHANGELOG.md](../CHANGELOG.md) for format changes.

## 8. The hosted app

`apps/worker` is a multi-user Hippocampus on Cloudflare. People sign in with GitHub; each keeps their vaults (up to five) in private repos of their own, which the app reads and writes through a GitHub App installed on those repos. It serves MCP for agents, the dashboard for the human, and agent-run sleep. [SECURITY.md](../SECURITY.md) says what an operator can and can't see.

### Using a hosted instance

1. **Sign in** with GitHub on the instance's welcome page and ask for access, with an optional note. An admin approves accounts by hand; the setup page unlocks once you're in.
2. **Create a private repo.** The setup page opens GitHub's form, filled in (`vault`, private). It must be empty, or hold only a README, LICENSE or .gitignore. A repo that already holds a Hippocampus vault is adopted instead: only missing guardrail files are added.
3. **Install the app** on that repo only. GitHub asks you to authorize it, then sends you back.
4. **Pick the repo and name the vault:** your id, time zone and domains, optionally the fictional example campaign and presets. A key for secret facts is made in your browser; download the key file and keep it safe. Only its public half goes into the vault.
5. **Set up the vault.** One commit puts the template into the repo.
6. **Connect agents** (below) and **set up a curator** (§5).

**Several vaults.** Add another from the vault menu at the top of the sidebar, or **Setup → Your vaults → Add a vault**: the same steps, for another repo (add it to the GitHub App's installation, or pick another GitLab project). Each vault has its own keys, its own curator and its own MCP address, `https://<your-instance>/mcp/<vault id>`. The vault menu switches the dashboard between them; each browser tab keeps its own, and a new tab opens the one you used last. **Remove** forgets a vault here (its keys, connected apps, index and cache); its repo stays where it is, and you can add it again.

**Using GitLab instead.** If the instance offers it, step 2 lets you choose GitLab. Create an empty private project in your **personal namespace** (not a group), then **Connect GitLab**: you authorize the Hippocampus application on GitLab (scope `api`), pick the project, and go on from step 4. Differences from GitHub:

- The connection isn't limited to one project (GitLab has no narrower permission that can write files), so it reaches every project you can. Hippocampus uses it only for your vault. [SECURITY.md](../SECURITY.md) has the details.
- You need Developer access or better, and Maintainer if the default branch is protected against Developers pushing.
- `internal` projects are refused like public ones.
- The nightly curator workflow is GitHub Actions only. On GitLab, run sleep with your own curator agent (§5).
- Reconnecting: GitLab sends no webhooks, so the app checks every six hours. If you revoke the app on GitLab, delete the project or make it non-private, the vault disconnects within hours; fix it on GitLab and press **Connect GitLab** again if needed.

**Sharing a vault.** The owner invites people under **Setup → People**, by GitHub username or with a one-time link (valid for 7 days). Each joins as a human of their own in the vault, as a **member** (adds memories, settles disputes and approves agents as themselves, makes keys for their own agents) or a **viewer** (reads only). Accepting an invite approves the account. Removing someone, or their leaving, revokes the keys they made and the apps they connected for that vault; their human stays in the config with everything they wrote. A vault can be shared with up to 19 people.

**Inviting people to the app.** Anyone approved can invite someone to the hosted app itself (**Setup → Invite someone to Hippocampus**): it lets them in without the waitlist and shares nothing. Ten open invites at a time; admins have no cap, and can turn a person's invites off.

**Connecting apps.** **Setup → Connected apps → Connect an app** asks which app, what it may do (**Remember and recall**: `read`, `remember`, `goal`; or **Only look things up**: `read`), and what it's called in the memory (its agent id, which it can be seated as right away). It shows the snippet for that app with the key in it, once (only a hash is stored), then waits for the app's first call. A key opens only its own vault: used at another vault's address, it's refused (`403 wrong_vault`), so a mixed-up config fails loudly instead of writing to the wrong vault. The list shows every connection, keys and sign-in apps alike, and disconnects any of them at once.

| Kind | Scopes | For |
| --- | --- | --- |
| Single-agent key (the default) | `read`, plus `remember` and `goal` as chosen | One app, as one agent; it sees confidential values it has authority over |
| Shared key (Advanced) | `read`, `remember`, `goal` | Several agents, each naming itself (`agent`) on every call. A name another connection already holds is refused |
| Curator key (Nightly curation) | `read`, `curate` | The agent that runs sleep. It sees secret and confidential memories in plain text while curating |

```bash
claude mcp add --transport http hippo-vault https://<your-instance>/mcp/<vault id> --header "Authorization: Bearer hippo_…"
```

The setup page has snippets for Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, any MCP app over HTTP and scripts. Each names the server after the vault's repo (`hippo-vault`, `hippo-lisbon-vault`), so one app can hold several vaults side by side. The plain `https://<your-instance>/mcp` still works: the key alone decides the vault.

**Agents connecting themselves.** An agent that can run commands can ask to connect: it calls `POST https://<your-instance>/connect/device`, shows you a code, and you approve it at `/dashboard/connect/` (the vault, the agent's name, what it may do). It then collects a key for that vault. `/llms.txt` on the instance tells agents how, and the plugin's `/hippocampus:connect` skill does it in Claude Code. See [AGENT-STANDARDS.md](AGENT-STANDARDS.md) for the conventions behind it.

**Nightly curation.** **Setup → Nightly curation** asks where the curator runs (one of your own agents, such as Claude Code or a Grok bot, at no new charge; a cron line; or GitHub Actions, which needs Claude paid for), makes its key and shows what to run there. Give curation a bot of its own that only curates. In Claude Code, `/hippocampus:sleep-setup` does the same, step by step.

**Sign-in apps (Claude.ai, ChatGPT; beta).** Add a custom connector with the URL `https://<your-instance>/mcp`. The app signs you in with GitHub and shows a consent page: pick the vault it connects to (one per connection), the agent id the app acts as (a party member, or a new one you can seat right away) and what it may do. Allowing curating makes the app a curator, with a curator key's view of secrets. Your account menu lists connected apps and disconnects them.

**Reconnecting.** If the app is uninstalled or suspended, the repo is removed from the installation or deleted, or the repo is made public, the vault is disconnected and stops answering. The setup page says why. Undo it on GitHub (install again, make the repo private) and it reconnects. On GitLab, make the project private again, or connect GitLab again if you revoked the app.

**Limits.** Per vault: 2,000 episodes waiting in the inbox, 20 waiting introductions, 20,000 files, 50 MB of text, 24 sleep runs a day, and 50 keys. Requests are rate-limited per key, account and IP. An admin can raise these for one vault (`POST /dashboard/api/admin/vaults/quotas` with `{"id", "quotas": {"sleepRunsPerDay": 96}}`); `null` restores the defaults.

**Deleting your account.** Your account menu deletes everything the app holds for you, after you type your GitHub login: keys stop working, connected apps are signed out, the GitHub App is uninstalled (or your GitLab connection is revoked), and your account and every vault's index and cache are erased. Your vault repos stay where they are, untouched.

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

**3b. GitLab (optional).** To let people keep their vault in a GitLab project, create an OAuth application on gitlab.com (User Settings → Applications, or Admin → Applications on a self-managed instance) with the redirect URI `https://<your-host>/oauth/gitlab/callback`, the `api` scope, and **Confidential** ticked. Then set all three, plus `GITLAB_URL` for a self-managed instance:

| Secret | Value |
| --- | --- |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | From the application's page |
| `HIPPO_TOKEN_KEY` | Seals the stored GitLab tokens: `openssl rand -base64 32 \| pnpm exec wrangler secret put HIPPO_TOKEN_KEY`. Losing it means everyone reconnects GitLab; changing it does too |
| `GITLAB_URL` | Optional: the instance's https origin. Default `https://gitlab.com` |

All three must be set together or the Worker says what's missing. One GitLab host per instance. A Cron Trigger (`wrangler.jsonc`) checks GitLab vaults every six hours.

**4. Deploy.** From the repository root. This builds the dashboard, applies the registry's migrations (`apps/worker/migrations/`), then deploys:

```bash
pnpm deploy:worker
```

Run it again to upgrade. To serve a custom domain, add it to `wrangler.jsonc` as `"routes": [{ "pattern": "<your-host>", "custom_domain": true }]` with `"workers_dev": false`. The Worker answers on one origin only, the one in `HIPPO_PUBLIC_URL`.

Sign in at your Worker's address. Admins are approved on sign-in and find an Admin page in their account menu, where they approve or deny the waitlist, see which vaults exist (names and states, never content), and see who invited whom: a referral graph and table, where they can also stop someone's invites.

**Semantic recall (optional).** Uncomment the `ai` binding in `wrangler.jsonc` and set `HIPPO_EMBED_PROVIDER` to `workers-ai` (it uses `@cf/baai/bge-m3`), or point the `HIPPO_EMBED_*` settings at any OpenAI-compatible embeddings API. `HIPPO_EMBED_DAILY_LIMIT` caps the texts embedded per vault per day (default 5000); past it, search falls back to keywords until the next day.

**Logs.** Invocation logs are off in `wrangler.jsonc`, since they would record every request's URL. The Worker logs one line per request itself: the route name, status, timing and a hashed vault id, never content or error messages.

**Upgrading from the single-vault Worker.** Deployments from before the hosted app need a few one-time steps; see [MIGRATING-WORKER.md](MIGRATING-WORKER.md).

**Local development** runs against a fake GitHub; see [DEVELOPING.md](DEVELOPING.md#the-hosted-app).

## 9. Vault CI and `hippo audit` (optional)

`hippo init` and the hosted app add `.github/workflows/validate.yml` to your vault. It has two jobs:

- **validate**, on every push and pull request (except pushes that only add inbox memories, and the app's own `[skip ci]` commits): checks that the vault still loads.
- **audit**, once a day: runs `hippo audit` over the last day's commits.

Every commit Hippocampus makes names its actor in a trailer: `Hippo-Actor: agent:<id>`, `curator`, `human`, `bootstrap` or `migration`. The curator's commits also carry `Hippo-Model` (and, from the relay, `Hippo-Curator` and `Hippo-Run`). `hippo audit` checks each commit with a non-human actor against what that actor may do:

- agents only add episodes and introductions to their own inbox folder (and edit goal props and objectives with the `goal` scope);
- the curator writes canon, the chronicle, disputes and secrets, but never your prose, facts you set, `human_only` fields, the config, the schema, the party or the vault's CI, and never writes a secret or confidential value in plain text;
- a migration only rewrites the config, schema, templates, dashboards and Handbook, and moves notes without changing your prose, facts or relations;
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
