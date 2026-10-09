---
name: memory
description: Use the person's Hippocampus memory, shared by all their AI agents. Use it at the start of any task about their plans, people, places, documents or projects, before acting on a fact, and whenever you learn something durable worth keeping.
---

# Using Hippocampus memory

Hippocampus is shared memory for one person's agents. You add memories to an inbox; a curator agent consolidates them into notes each night; the person settles disagreements. Everything goes through the `hippocampus` MCP tools. Never edit the vault's files directly.

## 1. Start with `onboard`

Call `onboard` with your agent id: lowercase letters, digits and dashes, describing your job (for example `home-finder` or `job-scout`). Use the same id every time. Never use the person's own name or `human`.

- If you're a known party member, it tells you your lane (what you're responsible for) and the quests you own.
- If you're unknown, call `introduce` with a `title`, your `lane` (one sentence), the `host` you run in, your `model` and a short `about`. Then carry on: until the person approves you on the dashboard, your memories count as rumors.

## 2. Read before you act

Use `recall` (search), `get` (one note), `neighbors`, `ask_canon` (a question answered from confirmed facts only) and `briefing` (what changed lately).

- ✓ **canon**: confirmed. Rely on it.
- ? **rumor**: reported once, unconfirmed. Say so if you use it.
- ! **disputed**: agents disagree. Don't pick a side; the person decides.

## 3. Remember what lasts

Call `remember` once per durable thing you learn:

- One memory per call. Exact values: ISO dates (2026-10-14), amounts with currency, full names.
- Say how you know it (`confidence`) and which notes it's `about`.
- Corrections are new memories ("the appointment moved to 2026-10-20"), not edits.
- ID, passport, account or card numbers and passwords: set `secret: true`, and never put them in other memories, titles or messages.
- Skip chit-chat, guesses and passing states.

Use `update_quest` to tick objectives or change a quest's status when the quest is yours.
