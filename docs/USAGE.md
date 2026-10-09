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

With `--github you/my-campaign`, steps 1 and 5 collapse into a single commit made through the API, with no clone needed. Pin the version (`@0.1`) so upgrades are deliberate. To schedule it on macOS, use [ops/com.hippocampus.sleep.plist](../ops/com.hippocampus.sleep.plist). Elsewhere, use cron or systemd. Models that worked well locally are MoE models with ~4B active parameters. Very long "thinking" models can hit the per-call timeout (`HIPPO_LLM_TIMEOUT_MS`). See [.env.example](../.env.example) for all settings.

## 6. The daily loop

1. Open `_hippo/review.md` (the morning review). It lists disputes, unverified rumors, stale facts, orphan notes, and episodes that failed.
2. **Rule on disputes:** open the dispute note and set `ruling: <correct value>`. The next sleep makes it canon.
3. Edit anything in Obsidian. Your word outranks every agent. The curator only rewrites `%% hippo:… %%` regions and the `facts`/`relations` properties, never your prose.
4. Tick quest objectives directly in quest notes.

## 7. Upgrading

Bump the pinned version in your schedule and CI, then run:

```bash
npx @mehrad77/hippocampus@<new> -v ~/vaults/my-campaign migrate
```

The tool refuses to write to a vault whose format version differs from its own. `hippo validate` reports the mismatch, and `migrate` upgrades the files and `_hippo/config.yaml`'s `version`. Read [CHANGELOG.md](../CHANGELOG.md) for format changes.

## 8. Vault CI (optional)

`hippo init` adds `.github/workflows/validate.yml` to your vault. On every push, including agents' inbox commits, it checks that the vault still loads. It also contains a commented-out nightly `sleep` job for hosted models, since a CI runner can't reach your local LM Studio.
