---
name: sleep-setup
description: Set up the nightly Hippocampus sleep (curation) for a vault, step by step, in plain words. Use when someone asks to set up, schedule or automate sleep or curation, or asks why their inbox never empties.
---

# Set up nightly sleep

Sleep is the nightly curation: a curator agent turns the memories waiting in the vault's inbox into notes. This skill helps the person choose where it runs and sets it up. Go one step at a time, say what each step does before doing it, and keep the words plain.

**Never ask for a key in the chat, and never write one into a file yourself.** Keys are shown once on the person's dashboard; they paste them where they belong.

## 1. See what's connected

Look for the `sleep_*` tools (`sleep_status`, `sleep_start`, …) on any Hippocampus server.

- **Found them:** call `sleep_status`. Tell the person which vault this connection serves (the server's instructions name it), and whether a run is going or when the last one finished. If it's already scheduled the way they want, say so and stop.
- **Not found:** the curator isn't connected here yet. That's step 3.

## 2. Choose where it runs

Offer these three, cheapest first, and let the person pick:

1. **One of your agents** (recommended): an agent they already use and pay for, such as Claude Code or a Grok bot, runs sleep on a schedule or when they ask. No new charge. Suggest **a bot of its own that only curates**: its own Claude Code project or scheduled task, its own Grok bot, with its own curator key. Not the agent they chat with every day.
2. **A script or cron line**: their own machine runs Claude Code (or another agent) every night.
3. **GitHub Actions** (vaults on GitHub only): a workflow in the vault's repository runs it every night, so nothing of theirs has to stay on. But it needs Claude paid for: a token from their Claude subscription or a paid Anthropic API key. Mention the cost before they choose it.

Whichever they pick, say this once: **the curator sees every new memory in full, secret ones included**, so it should be an agent and an AI provider they trust with them. One curator per vault is enough.

## 3. Get a curator connection

On the hosted app, the person opens the dashboard → **Setup & health → Nightly curation**, picks the same place, and clicks **Create the curator key**. The page then shows exactly what to run, with the key already in it: for Claude Code, Grok's CLI, a Grok bot on the xAI API, or a cron line.

- For **Claude Code** (choices 1 and 2), it's a `claude mcp add …` line that adds the curator as its own server, named after the vault (like `hippo-lisbon-vault-curator`). It sits beside their everyday connection and never replaces it. Ask them to run it in their terminal, then restart Claude Code or start a new session, so the `sleep_*` tools appear.
- For **GitHub Actions**, it's two `gh` commands that store the key and the vault's address in the repo. The workflow also needs Claude: either a token from their Claude subscription (they run `claude setup-token`, then `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>`; no API bill) or an Anthropic API key (`gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>`). Each command asks for the value. Then they click **Turn it on** on the same page, which adds the workflow to the repo.

On a self-hosted or local vault, the person makes a curator key or token the way their setup does it; the steps after this are the same.

## 4. Schedule it

- **One of your agents:** in Claude Code, create a daily task (its scheduling, for example `/schedule`, or the desktop app's scheduled tasks) at a quiet hour in the vault's time zone, with the prompt `Run Hippocampus sleep with the sleep skill (/hippocampus:sleep).` For another agent or bot, schedule the sleep prompt the dashboard shows. Once a day suits most vaults; hourly suits agents that write a lot.
- **A script or cron line:** give them this line to adapt, with their own values put in by them, never by you:

  ```bash
  30 3 * * * HIPPO_MCP_URL=<the vault's address> HIPPO_KEY=<the curator key> claude -p "/hippocampus:sleep" --allowedTools "mcp__hippocampus__*"
  ```

  It needs the Hippocampus plugin installed (`claude plugin install hippocampus@hippocampus`) on that machine.
- **GitHub Actions:** nothing more; the workflow runs nightly at 03:23 UTC. Offer to check after the first night.

## 5. Check it

If the `sleep_*` tools are here now, offer to run the first night together: follow the `sleep` skill. Otherwise call `sleep_status` after the first scheduled run, or ask them to look at **Setup & health → Curator** on the dashboard, which lists every run.

Finish with a two-line summary: where sleep runs, and when.
