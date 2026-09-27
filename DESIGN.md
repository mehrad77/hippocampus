# Hippocampus — Design

## Context

People increasingly run **several specialist agents** for one project or one life. Examples: an agent for residence-permit paperwork, one for university admin, one for housing, one for the job search, a fact-checker, and a "game master" who narrates progress. They live on different hosts: Grok, Claude, ChatGPT, self-hosted bots, and local coding agents. Each keeps its own memory, so facts drift apart. Two agents quote different appointment dates, an email address exists in three spellings, and someone ends up building a *fact-checker agent* whose only job is to reconcile the others.

Hippocampus replaces that with **one shared, curated memory**:

- **Storage:** an Obsidian-openable markdown vault, shaped like a TTRPG campaign wiki and linked as a graph.
- **Access:** through a GitHub repo (the lowest common denominator), plus an MCP server for agents that speak MCP.
- **Ownership:** Hippocampus owns the shape of memory. Agents submit observations. Hippocampus consolidates them into canon, links them, resolves conflicts, and hands agents a briefing.

The name describes the mechanism. Agents write fast *episodic* memory. A nightly "sleep" pass consolidates it into *semantic* memory, the canonical entity notes.

A motivating setup, anonymized as the bundled [`seeds/example-relocation`](seeds/example-relocation):

> This room is the ops table for the relocation arc, one place to coordinate so lanes don't collide.
> **Residency Agent**: residence permit end-to-end · **Campus Agent**: university admin · **Home Finder**: housing · **Job Scout**: paid work · **Archivist**: canonical facts when numbers disagree · **Game Master**: quest board and story framing; stamps beats, never steals lanes.

Hippocampus absorbs the Archivist's job (canonical facts, disputes). The Game Master stays an agent that narrates from the vault.

**Design decisions**

| Topic | Decision |
| --- | --- |
| Clients | Any agent that can use GitHub (a connector or the API) or MCP |
| Curation | Hybrid: fast inbox writes, then an async LLM curator |
| Deployment | The GitHub vault repo is the source of truth. v1 is serverless: agents append to the inbox, and `hippo sleep` runs nightly on the owner's machine. A Cloudflare Worker MCP server comes later |
| Curator LLM | Provider-agnostic. Local LM Studio or Ollama (OpenAI-compatible) by default; Anthropic and xAI are supported |
| Sensitive data | Private vault repo. Secret fields are encrypted in an `age` sidecar and gated by scope |
| Disputes | Resolved by lane authority, then corroboration, then recency. Anything still ambiguous becomes a dispute note for the human to rule on |
| Memory scope | One shared world; no private per-agent memory |
| Stack | TypeScript, a pnpm + turbo monorepo, vitest |

---

## 1. Architecture

```
 Agents (Grok / Claude.ai / ChatGPT / own bots / Claude Code)
     │ remote MCP (HTTPS, bearer or OAuth)       │ GitHub (connector or API)
     ▼                                            ▼
 ┌────────────── Cloudflare Worker (later) ─────┐   writes only inbox/<agent>/*.md
 │ MCP server (McpAgent, streamable HTTP)       │   + reads HANDBOOK.md & canon
 │ OAuth provider + per-agent tokens/scopes     │
 │ Durable Object "Scribe" = single git writer  │──► private GitHub repo (vault) ◄── the human, in Obsidian (obsidian-git)
 │ D1 index (FTS5 + links + claims)             │◄── push webhook → reindex
 │ Curator API (claim batch / apply patch)      │
 └──────────────────────────────────────────────┘
     ▲ curator API (HTTPS)
 Curator "sleep" runner: runs on the owner's machine (LM Studio/Ollama), later a cron/queue with a hosted LLM
```

Key properties:
- **Git is the source of truth.** Any index can be rebuilt from the repo.
- **One writer.** Agents only append new files to `inbox/`, so agent writes never collide. Everything else is written by the curator (and the human). In the Worker, every GitHub write goes through the Scribe Durable Object as an atomic multi-file commit.
- **The curator is a client, not a component.** It pulls pending episodes and writes structured changes back, so it can run wherever the LLM is, including next to a local model.
- **Human edits win.** The human's word outranks every agent. The curator only rewrites *managed regions* of a note and never touches human prose.
- **Ports and adapters.** `core` defines a `VaultStore` port. Adapters: filesystem (local) now, GitHub API (Worker) later.

## 2. Vault structure (TTRPG campaign wiki)

The vault is a separate private repo, created from `vault-template/` with `hippo init`.

```
HANDBOOK.md                 # "Player's Handbook" for agents: conventions, lanes, how to write (generated)
campaigns/lisbon-arc.md     # arcs / campaigns
quests/                     # goals: objectives checklist, status, clocks, owner lane, deadlines
characters/                 # people & the PC (characters/player.md = the player character)
factions/                   # orgs: migration agency, university, employers…
locations/                  # places: apartments, campus, offices
items/                      # documents & artifacts: passport, residence card, insurance policy, lease
lore/                       # procedures/rules & topic knowledge ("how the permit portal works")
party/                      # agents as party members: lane, authority domains, host
chronicle/YYYY/MM/DD.md     # session log: consolidated episodes per day (episodic memory)
inbox/<agent>/<file>.md     # raw episodes awaiting consolidation (agent-writable)
disputes/                   # contradictions awaiting the human's ruling
secrets/<entity>/<field>.age  # encrypted secret fields
_hippo/config.yaml          # entity types, relation vocabulary, domains, curator settings
_hippo/templates/           # Obsidian templates per entity type
_hippo/dashboards/          # Dataview: quest board, disputes, activity
_hippo/review.md            # generated morning review
attachments/
```

**TTRPG concepts that do real work:**
- **Canon vs. rumor.** Every fact has `status: rumor | canon | disputed | retconned`. An unverified agent report is a rumor. It becomes canon through lane authority or corroboration.
- **Clocks** (Blades in the Dark style). Deadlines and progress, e.g. `Paperwork ■■■□□□ 3/6 · due 2026-11-30`.
- **Quests.** Objectives (a checklist you can tick in Obsidian), owner lane, status, deadline.
- **Party sheets.** Each agent's lane and authority domains live in `party/<agent>.md`. The curator uses them for dispute resolution, and `onboard` uses them to brief the agent.
- **Chronicle.** An append-only, day-by-day history. The game master narrates from it.

**Note format** (Obsidian-native: properties + wikilinks, so the graph view works out of the box):
```markdown
---
type: faction
title: Migration Agency
aliases: [Agência de Migração, the agency]
tags: [residency]
relations:
  - { rel: handles, target: "[[residence-permit]]" }
  - { rel: located_in, target: "[[lisbon]]" }
facts:
  appointment_date: { value: 2026-10-14T10:30, status: canon, by: residency-agent, at: 2026-09-26T11:00:00Z, src: [ep-01J9…] }
  case_number: { value: "secret://migration-agency/case_number", status: canon, by: residency-agent }
updated_by: curator
---
%% hippo:begin summary %%
LLM-maintained summary paragraph with [[wikilinks]].
%% hippo:end summary %%

%% hippo:begin relations %%
- handles:: [[residence-permit]]
%% hippo:end relations %%

## Notes
Free human prose — never touched by the curator.
```
`%% … %%` is an Obsidian comment, so the region markers are invisible in reading view. Relations are rendered as Dataview inline fields, so both Obsidian's graph and Dataview see typed edges.

## 3. Agent-facing MCP surface (small, verb-oriented)

| Tool | Purpose |
| --- | --- |
| `onboard()` | The handbook for *this* agent: conventions, its lane, its authority domains, its active quests. Call at session start. |
| `remember(text, about?, kind?, confidence?, secret?, at?)` | Append an episode to `inbox/`. Returns immediately; never blocks on the LLM. |
| `recall(query, types?, limit?)` | Full-text search plus graph expansion plus recent unconsolidated episodes (read-your-writes). |
| `get(entity)` | The full note: facts with status and provenance, neighbors, objectives, open disputes. |
| `neighbors(entity, rel?, depth?)` | Graph traversal. |
| `ask_canon(question)` | The fact-checker's job: the best canonical facts for a question, with status and any open dispute. |
| `briefing(since?, horizon_days?)` | "Previously on…": chronicle, recently changed notes, upcoming deadlines and clocks, open disputes. |
| `update_quest(quest, status?, complete?, add?, clock?, deadline?, owner?)` | Structured quest and clock edits, applied directly. |

Resources: `hippo://handbook`, `hippo://entity/{slug}`.

**GitHub path:** an agent reads `HANDBOOK.md` and commits `inbox/<agent>/<timestamp>-<slug>.md` with the documented frontmatter. The curator ingests these exactly like MCP episodes.

## 4. Curator ("sleep") pipeline

Each step is a small, schema-validated LLM call, so small local models can cope.

1. **Rulings.** Apply `ruling:` values the human wrote into dispute notes.
2. **Mentions.** List the entities an episode says something about.
3. **Resolve.** Match via aliases first, then search candidates plus an LLM "same thing?" choice. Otherwise create a new entity, tagged with domains (falling back to the reporting agent's lane).
4. **Claims.** Extract atomic facts, relations, and quest progress about the resolved entities. Existing field names are shown so they get reused.
5. **Reconcile** (deterministic; `packages/core/src/reconcile.ts`). Precedence: **human > lane authority > corroboration > recency**.
   - A new value from a non-authoritative agent is a rumor. Once enough distinct agents repeat it, it becomes canon.
   - A source may correct its own earlier report.
   - An authoritative value beats a non-authoritative one.
   - Peers who disagree, or an agent contradicting the human, produce `disputes/<entity>-<field>.md`.
6. **Apply** in memory, then **chronicle** the episode (secrets redacted) and remove it from the inbox.
7. **Summaries** for touched notes, then regenerate `HANDBOOK.md` and `_hippo/review.md` (disputes, rumors, stale canon, orphans, failures).
8. **Commit** as *Hippocampus*, staging only the curator's paths, and push.

If an episode fails, it stays in the inbox for the next night.

## 5. Secrets

Fields flagged secret by the model, by the episode (`secret: true`), or by the type's `secret_fields` are stored as `secret://<entity>/<field>`. The value is encrypted with `age` to `secrets/<entity>/<field>.age`. Encrypting needs only the public recipient in `_hippo/config.yaml`, so the curator can store secrets but never read them back. `hippo secrets show` decrypts with the private identity from `~/.config/hippocampus/`.

## 6. Code layout

```
packages/core      schemas, markdown + managed regions, vault model, reconcile, ops, search, handbook, service, secrets
packages/curator   LLM adapter (AI SDK), prompts, sleep pipeline
packages/mcp       MCP tools/resources over the service
apps/cli           `hippo`: init, serve, sleep, fmt, validate, handbook, remember, secrets
vault-template/    starter vault: config, Obsidian templates, Dataview dashboards
seeds/             example campaigns (fictional)
```

## 7. Roadmap

- **M0–M2 (done):** vault spec and template, local MCP, curator with local models, `hippo sleep` with git.
- **M3:** Cloudflare Worker with a GitHub-API `VaultStore`, the Scribe DO, a D1 index with webhook reindex, and per-agent bearer tokens and scopes.
- **M4:** OAuth for Claude.ai and ChatGPT connectors, and client snippets for self-hosted bots.
- **M5:** embeddings for semantic recall, a cloud curator via cron/queue, and staleness jobs.

## 8. Risks

- **MCP support varies by host.** The GitHub path guarantees a working route either way.
- **Small local models make weak curation decisions.** Mitigations: small steps, strict schemas, deterministic reconcile, and a golden test suite.
- **Mixed languages.** Canonical titles stay in their original spelling. Other spellings and translations go in `aliases`. Matching folds diacritics, including Turkish ı/İ.

---

## Implementation status (v1)

| Area | State | Notes |
| --- | --- | --- |
| Vault spec + template + example seed | ✅ | `vault-template/`, `seeds/example-relocation/`, `hippo init --seed <name-or-path>` |
| Core model | ✅ | zod schemas, managed regions, alias/ID/link resolution, typed relations as Dataview inline fields |
| Reconcile | ✅ | Pure function, table-tested |
| Disputes + human rulings | ✅ | `ruling:` is applied on the next sleep |
| Secrets | ✅ | age, one file per field; the curator needs only the public key |
| Search | ✅ | In-memory MiniSearch with diacritic folding, rebuilt per request (small vaults, runs anywhere) |
| Curator pipeline | ✅ | mentions → resolve → claims → reconcile → apply → chronicle → summaries → review + handbook |
| LLM adapter | ✅ | `prompt` structured mode (default for local servers) and `native` (hosted). Per-call timeout and token cap |
| MCP (stdio + local HTTP) | ✅ | 8 tools + 2 resources |
| `hippo sleep` with git | ✅ | pull --rebase --autostash → curate → stage own paths → commit → push |
| Worker, OAuth, embeddings | ⏳ | M3–M5 |

**Lessons from local models.** LM Studio with a reasoning model returned grammar-constrained JSON in `reasoning_content`, and constrained decoding suppressed its thinking, which made classification worse. Local providers therefore default to `prompt` mode:
- The JSON Schema goes in the system prompt.
- The model thinks freely.
- The first balanced JSON object is extracted and validated with zod.
- If validation fails, the call is retried with the errors fed back.

Reasoning models can also loop, so every call has a timeout (`HIPPO_LLM_TIMEOUT_MS`, default 180 s). MoE models with ~4B active parameters have been a good speed/quality balance, at roughly 1–2 minutes per episode.

**Known v1 limitations**
- Episodes that agents commit to GitHub stay in git history even after secrets are redacted from the chronicle.
- With local models, the curator sees secret values while extracting them (they never leave the machine). Summaries never see them.
