---
name: memory
description: Use the person's Hippocampus memory, shared by all their AI agents. Use it at the start of any task about their plans, people, places, documents or projects, before acting on a fact, and whenever you learn something durable worth keeping.
---

# Using Hippocampus memory

Hippocampus is shared memory for one person's agents. You add memories to an inbox; a curator agent consolidates them into notes each night; the person settles disagreements. Everything goes through the `hippocampus` MCP tools. Never edit the vault's files directly.

## 1. Start with `onboard`

Call `onboard` first, with your agent id. A connection is usually made for an app, not for one agent, so you name yourself: pass the same `agent` id on every call. Make it `<platform>-<role>`, lowercase letters, digits and dashes, like `claude-code-home-finder` or `grok-bot-trip-planner`. Use the same id every session. Never use the person's own name, `human`, `curator`, `unknown` or `hippocampus`, and don't take an id another app uses: the vault refuses it. (If the connection is bound to one agent, the server says so and ignores the argument.)

Each connection serves **one vault**, named in the server's instructions. If the person has several, each has its own server; remember into the one the task belongs to.

- If you're a known party member, it tells you your lane (what you're responsible for) and the goals you own. It also lists this vault's kinds of memory: the person may have added some (with presets) beyond the usual ones.
- If you're unknown, call `introduce` with a `title`, your `lane` (one sentence), the `host` (the app you run in), your `model` and a short `about`. You join the person's agents at once, with no authority: your memories count as rumors until they make you responsible for a domain. Then carry on.

## 2. Read before you act

Use `recall` (search), `get` (one note, with its guidelines, stats and open questions), `neighbors`, `ask_canon` (a question answered from confirmed facts only) and `briefing` (what changed lately, what's due, who's overdue a contact).

Before contacting or writing to someone, call `briefing` with `about` set to them: their confirmed facts, guidelines (theirs and those they inherit, some only for a language or channel), recent interactions, open goals with them and contact stats. Follow the guidelines; never act beyond what the person's notes allow you to send on your own.

- ✓ **canon**: confirmed. Rely on it.
- ? **rumor**: reported once, unconfirmed. Say so if you use it.
- ! **disputed**: agents disagree. Don't pick a side; the person decides.

## 3. Remember what lasts

Call `remember` once per durable thing you learn:

- One memory per call. Exact values: ISO dates (2026-10-14), amounts with currency, full names.
- Say how you know it (`confidence`) and which notes it's `about`.
- Pick the `kind` that fits (the handbook lists them): `fact`, `decision`, `question`, `task`, `interaction`, and any the vault adds. Some kinds take typed `data` (for example `{ "with": "[[migration-agency]]", "channel": "call" }`) and need no text; some keep only a short gist.
- Use `scope` when it only holds somewhere (`lang:pt`).
- Private matters (health, money, family): set `confidential: true`. It stays out of search, summaries and the chronicle.
- Corrections are new memories ("the appointment moved to 2026-10-20"), not edits.
- ID, passport, account or card numbers and passwords: set `secret: true`, and never put them in other memories, titles or messages.
- Skip chit-chat, guesses and passing states.

Use `update_goal` to tick objectives, move progress, or change a goal's status, due date or repeat when the goal is yours (`update_quest` is its old name).
