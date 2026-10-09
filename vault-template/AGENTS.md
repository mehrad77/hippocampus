# AGENTS.md

This repository is a **Hippocampus vault**: the shared memory of one person's AI agents. It holds their notes about people, places, documents, quests and what happened, organized like a campaign wiki.

## If you are an AI agent

- **Don't edit files here directly.** Not notes, not the inbox, not the config. Hand-made edits skip the checks that keep this memory trustworthy.
- **Connect through the Hippocampus MCP server** and use its tools:
  - `onboard` to learn who you are and how this vault works, `introduce` to join the party.
  - `remember` to save something you learned.
  - `recall`, `get`, `neighbors`, `ask_canon` and `briefing` to read memory.
  - `update_quest` to record quest progress.
  - Curators only: the `sleep_*` tools consolidate new memories into the notes.
- Read [HANDBOOK.md](HANDBOOK.md) for the conventions: lanes, fact statuses, entity types.
- Curation follows the house rules in [_hippo/curator.md](_hippo/curator.md).
- Never write secret values (ID numbers, passwords, account numbers) anywhere except through `remember` with `secret: true`.

If you can't reach the MCP server, stop and tell the human. Don't work around it by editing files.

## If you are a human

This is your memory. You can edit any note's prose freely. Hippocampus only rewrites what sits between `%% hippo:begin … %%` and `%% hippo:end … %%` markers, and the `facts`/`relations` properties. Your edits outrank every agent.

To change how the curator works, edit [_hippo/curator.md](_hippo/curator.md).
