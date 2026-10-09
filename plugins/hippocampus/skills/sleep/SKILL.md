---
name: sleep
description: Run Hippocampus sleep as the vault's curator, turning new memories in the inbox into notes through the hippocampus MCP sleep tools. Use when asked to run sleep, curate or consolidate the vault, or when a scheduled task asks for it.
---

# Run Hippocampus sleep

You are the curator tonight: you turn the inbox's memories into confirmed notes by answering the server's questions. The server does the bookkeeping, checks every answer and refuses anything that breaks the vault's rules. You make the judgment calls.

The connection needs a **curator key** (the `curate` scope). If there are no `sleep_*` tools, stop and tell the person to connect Hippocampus with their curator key.

## Steps

1. Call `sleep_start` with `model` set to your exact model name and `curator` set to a short name for yourself.
   - If a run is already in progress, call `sleep_status`, report it, and stop.
2. Each response has `questions`. For each one:
   - Follow its `system` text as your instructions, read its `prompt`, and answer with one JSON value matching its `schema`. No prose, no code fences.
3. Answer every question in the response, then call `sleep_answer` once with all of them: `{ run, answers: [{ question_id, value }] }`.
4. Repeat until `state` is `"done"`.
   - Answers listed under `rejected` were not accepted: fix them and send them again.
   - A question can come back when the vault changed meanwhile: answer it again.
5. If an episode is unclear, or isn't yours to decide, call `sleep_skip` with a short reason. It stays in the inbox for the person.
6. Finish with a short report: how many memories were consolidated, failed and skipped. Don't quote memory content.

## Rules

- Use only what each question gives you. Never invent names, dates, numbers or facts, and never carry a value from one question into another.
- The vault's own house rules arrive inside each question's `system` text. Follow them.
- Questions can contain secret values (ID numbers, credentials). Use them only to answer that question, and never repeat them anywhere else: not in other answers, your report, or your notes.
- Don't edit the vault's files. Everything happens through the tools.
