# Hippocampus — Design

## Context

People increasingly run **several specialist agents** for one project or one life. Examples: an agent for residence-permit paperwork, one for university admin, one for housing, one for the job search, a fact-checker, and a "game master" who narrates progress. They live on different hosts: Grok, Claude, ChatGPT, self-hosted bots, and local coding agents. Each keeps its own memory, so facts drift apart. Two agents quote different appointment dates, an email address exists in three spellings, and someone ends up building a *fact-checker agent* whose only job is to reconcile the others.

Hippocampus replaces that with **one shared, curated memory**:

- **Storage:** an Obsidian-openable markdown vault, linked as a graph. It began as a TTRPG campaign wiki for a party of agents; its types and kinds are now notes in the vault, and presets shape it for people, software, business, study or a household.
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
| Clients | Any agent that speaks MCP. Local tools that can't may write inbox files instead |
| Curation | Hybrid: fast inbox writes, then an async curator. The curator is either `hippo sleep` with a model of your choice, or an agent the human trusts, answering the server's questions over MCP |
| Deployment | The GitHub vault repo is the source of truth. Two runtimes: the local CLI, and a hosted multi-user app on Cloudflare (a GitHub App, one Durable Object per vault) |
| Curator LLM | Provider-agnostic. Locally: LM Studio or Ollama (OpenAI-compatible) by default; Anthropic and xAI are supported. Hosted: whichever agent holds the curator key |
| Sensitive data | Private vault repo. Secret fields are encrypted in an `age` sidecar and gated by scope |
| Disputes | Resolved by lane authority, then corroboration, then recency. Anything still ambiguous becomes a dispute note for the human to rule on |
| Memory scope | One shared world; no private per-agent memory |
| Stack | TypeScript, a pnpm + turbo monorepo, vitest |

---

## 1. Architecture

```
 Agents (Claude.ai / ChatGPT / Claude Code / Cursor / own bots)        Curator agent (curator key)
     │ remote MCP (HTTPS): vault key or OAuth connector                    │ sleep_* tools over MCP
     ▼                                                                     ▼
 ┌──────────────────────── Cloudflare Worker (hosted app) ─────────────────────────┐
 │ GitHub sign-in, waitlist + admin, onboarding, keys, OAuth consent, webhooks     │
 │ D1 REGISTRY: accounts, vault ↔ repo, hashed keys (never vault content)          │
 │        │ authenticated request + grant                                          │
 │        ▼                                                                        │
 │ Durable Object VaultHost, one per vault:                                        │
 │   MCP + dashboard API · audited single writer · search index in its SQLite      │
 │   sleep relay (one run at a time, leased) · blob cache · quotas · alarms        │
 └────────┬────────────────────────────────────────────────────────────────────────┘
          │ GitHub App installation token, scoped to the one repo
          ▼
 private GitHub repo (vault) ◄── the human, in Obsidian and on the dashboard
          │ vault CI: validate on push, `hippo audit` daily, optional Actions curator (sleep.yml)

 Locally instead: `hippo serve` (MCP over stdio or 127.0.0.1), `hippo dashboard`, `hippo sleep` with a local or hosted model
```

Key properties:
- **Git is the source of truth.** Any index can be rebuilt from the repo.
- **One writer per vault.** Agents only append new files to `inbox/`, so agent writes never collide. Everything else is written by the curator (and the human). In the hosted app, every write goes through the vault's Durable Object, one atomic multi-file commit at a time, based on the commit its writer read. A batch whose paths moved meanwhile is redone or refused, never overwritten.
- **Every write is audited.** A commit names its actor in a `Hippo-Actor` trailer. The hosted app checks the claim against the caller's credentials and the change set against what that actor may do (`packages/core/src/audit.ts`) before committing. `hippo sleep` runs the same audit before it flushes. `hippo audit` re-checks history in the vault's CI.
- **The curator is a client, not a component.** It pulls pending episodes and writes structured changes back, so it can run wherever the model is: next to a local model (`hippo sleep`), or as an agent answering the server's questions (the relay, §4b).
- **Human edits win.** The human's word outranks every agent. The curator only rewrites *managed regions* of a note and never touches human prose.
- **Tenants are isolated.** Each vault has its own Durable Object (storage, caches, index, sleep runs), and its installation token is narrowed to that vault's repo. The Worker authenticates every caller before forwarding to the one object its key or session belongs to.
- **Ports and adapters.** `core` defines a `VaultStore` port. Adapters: filesystem (local) and GitHub API (no checkout; the hosted app's backend). Stores with `apply()` persist each flush as one atomic batch.

## 2. Vault structure: generic building blocks

The vault is a separate private repo, created from `vault-template/` with `hippo init` (or by the hosted app).

```
HANDBOOK.md                 # the Handbook for agents: conventions, types, kinds, lanes (generated)
arcs/                       # long stretches that group goals (capability `arc`)
goals/                      # things to get done: status, owner, counterparty, due, progress, repeat, objectives (capability `goal`)
characters/                 # people, the humans included (characters/<human>.md)
factions/ locations/ items/ lore/   # organizations, places, things, know-how
party/                      # the AI agents: lane, authority domains, host (capability `actor`)
chronicle/YYYY/MM/DD.md     # consolidated episodes per day (episodic memory)
inbox/<agent>/<file>.md     # raw episodes awaiting consolidation (agent-writable)
disputes/                   # conflicts, proposals and possible merges awaiting the human
secrets/<entity>/<field>.age  # encrypted secret fields
_hippo/config.yaml          # name, humans, domains, relations, presets, curator and briefing settings
_hippo/schema/types/*.md    # one note per entity type: folder, fields, capabilities, statuses, examples
_hippo/schema/kinds/*.md    # one note per episode kind: behaviour, text policy, typed data, examples
_hippo/templates/           # Obsidian templates per type
_hippo/dashboards/          # Dataview: goal board, disputes, activity
_hippo/review.md            # generated morning review
```

**Schema as notes.** What a vault holds is itself written down in it. A type note's frontmatter is its definition and its body is the description, with `## Is` / `## Is not` examples the curator's prompts quote. Code never names a type: it asks the registry (`schema-registry.ts`) for a **capability**:

- `goal`: status (a type's own words mapped onto `active | blocked | done | failed | dormant`), owner, counterparty, due, progress, repeat, objectives (`goal.ts`).
- `actor`: an agent's lane, authority and host (`actor.ts`).
- `arc`: groups goals.

Types `extend` other types (fields, capabilities, statuses and template carry over; at most three levels). Fields are typed (`text | number | bool | date | ref | enum`) and may be `human_only`, `secret`, `confidential`, `identity_key` (implies confidential), `succession`, `recurs: yearly`, or owned by a lane `domain`. Validation is advisory: shape notes in the review and `hippo validate`, never a refused write.

**Kinds.** An episode's `kind` is any string; its kind note gives it a **behaviour** (`observation | fact | decision | question | task | interaction`), a text policy (`required | optional | gist | forbidden`), typed `data`, whether it counts as contact, and (for tasks) the goal type its commitments become. Unknown kinds are filed as observations with a warning.

**Managed memory** lives in frontmatter and is drawn into regions: `guidelines` (rules for how to treat an entity, optionally `scope`d, rumor until corroborated), `decisions` (what, why, alternatives, revisit), `questions` (open until an episode answers them) and `stats` (contact counts per kind and channel, `first_met`, `last_contact`; rebuildable from the chronicle with `hippo fmt --stats`). Entities can `extends:` another entity (or name an `inheritable` one in their tags) to inherit its defaults, guidelines and contact `cadence`; along the chain the nearest cadence wins, and parallel sources (mixins, groups) mesh with any `none` winning.

**Facts** carry `status: rumor | canon | disputed | retconned`, provenance (`by`, `at`, `src`), up to five prior values (`was`, each with why it left: `replaced | succeeded | retconned | ruled`), and optional qualifiers: a scope that is part of the key (`greeting@lang:pt`), `valid_from` / `valid_until`, `confidence` and `confidential`.

**Presets.** Use cases ship as data, not code: `presets/<name>/` holds type and kind notes, templates, starter notes and sections for the human's note (`people`, `developer`, `business`, `student`, `household`). `hippo init --preset`, Session Zero, or `hippo preset add` lay them over a vault (`presets.ts`); a `merge: true` schema note merges its fields into the vault's own type.

**Where the TTRPG flavour went.** Hippocampus started as a campaign wiki for a party of agents, and the vocabulary stays where it helps: canon and rumor, the party (agents), the chronicle, the human's rulings, the dashboard's Tavern and Council. Quests became goals and campaigns became arcs (v2, migrated by `hippo migrate`), and clocks became one `progress`.

**Note format** (Obsidian-native: properties + wikilinks, so the graph view works out of the box):
```markdown
---
type: character
title: Case Officer
aliases: [the officer]
extends: "[[colleague]]"
relations:
  - { rel: works_at, target: "[[harbor-university]]", role: lecturer }
facts:
  employer: { value: Harbor University, status: canon, by: campus-agent, at: 2026-09-26T11:00:00Z, src: [ep-01J9…] }
  greeting@lang:pt: { value: "Bom dia", status: rumor, by: home-finder, seen_by: [home-finder] }
  email: { value: officer@lisbon.example, status: canon }# identity key: confidential
guidelines:
  - { rule: Write in Portuguese, scope: "lang:pt", status: canon }
stats: { first_met: 2026-09-01, last_contact: 2026-09-26, counts: { interaction: 3 } }
---
%% hippo:begin summary %%
LLM-maintained summary paragraph with [[wikilinks]].
%% hippo:end summary %%

## Notes
Free human prose — never touched by the curator.
```
`%% … %%` is an Obsidian comment, so the region markers are invisible in reading view. Relations are rendered as Dataview inline fields, so both Obsidian's graph and Dataview see typed edges; a relation may declare an inverse (`depends_on` ↔ `used_by`) and is stored once, forward.

## 3. Agent-facing MCP surface (small, verb-oriented)

| Tool | Purpose |
| --- | --- |
| `onboard()` | The handbook for *this* agent: conventions, its lane, its authority domains, its open goals. Call at session start. |
| `introduce(title, lane?, host?, model?, about?)` | An unknown agent asks to join the party: `inbox/<agent>/_introduction-<ulid>.md`. The human approves (seats it with chosen authority) or dismisses it on the dashboard. |
| `remember(text?, kind?, data?, about?, scope?, confidential?, confidence?, secret?, at?)` | Append an episode to `inbox/`, checked against its kind (text policy, typed data). Returns immediately; never blocks on the LLM. At most 8 KB. |
| `recall(query, types?, limit?)` | Full-text search plus graph expansion plus recent unconsolidated episodes (read-your-writes). Confidential facts and identity keys are never indexed. |
| `get(entity)` | The full note: qualified facts with status and provenance, neighbors, goal props, guidelines (own and inherited), decisions, questions, stats, cadence, open disputes. |
| `neighbors(entity, rel?, depth?)` | Graph traversal. |
| `ask_canon(question)` | The fact-checker's job: the best canonical facts for a question, with status and any open dispute. |
| `briefing(since?, horizon_days?, about?)` | "Previously on…": chronicle, recently changed notes, upcoming due dates and yearly dates, overdue contacts, open disputes. With `about`, a brief on one person or thing: canon facts, guidelines, recent interactions, open goals with them, proposals, stats. |
| `update_goal(goal, status?, complete?, reopen?, add?, progress?, due?, owner?, counterparty?, repeat?)` | Structured goal edits, applied directly. A repeating goal marked done rolls to its next due date. `update_quest` is the old name, kept as an alias. |

Agent ids are exact: lowercase slugs, never the human's id or a reserved one (`human`, `curator`, `unknown`, `hippocampus`), and never matched by alias (`assertAgentId` in `ops.ts`).

Scopes: `read`, `remember`, `goal` (`quest` is its old name, still accepted and stored alongside), and `curate` for the curator's `sleep_*` tools and `sleep` prompt (§4b). Tools outside a connection's scopes are removed, so clients never see them. Confidential values are masked for everyone except **bound** callers (an OAuth grant's agent, a bound key, a local `--agent`) with authority over them; the curator sees them to curate, and the consent page says so.

Resources: `hippo://handbook`, `hippo://entity/{slug}`. The dashboard's read models are also served as resource templates under `hippo://dashboard/…` (`overview`, `catalog`, `graph`, `whoami`, `entity/{slug}`, `chronicle/{month}`, `search{?q,limit}`). They are left out of `resources/list` so agent hosts never see them. A dashboard can therefore run on top of any Hippocampus MCP server with a `read` token.

## 3b. The human's dashboard

Agents get small, verb-oriented tools. The human gets a different view: everything at once, structured, and with secrets masked in one place (`packages/core/src/views.ts`).

- **Read models** (pure functions over the vault):
  - `overview`: counts, attention, goals, upcoming dates, overdue contacts, party, humans, inbox, chronicle, and activity.
  - `catalog`, `entityDetail` (facts with full provenance), `graph` and `chroniclePage`.
  - Secret refs, prior secret values, and secret-bearing inbox episodes never leave as plain text.
- **Human actions** are the human's edits, so they carry human authority:
  - Rule on a dispute (`rule`, which applies at once through the same `applyRuling` the sleep uses), accept or decline a proposal, retract a fact.
  - Tick and reopen objectives, move progress, set due dates and repeats (`updateGoal` as the signed-in human).
  - Scribe a memory into the inbox (`remember` as the human).
  - Add a party member.
  - Typed rulings on secret fields are refused, so a secret can't land in a note as plain text.
- **One API, two runtimes.** `packages/dashboard` is a web-standard `Request → Response` router over a `DashboardSource` port:
  - Sources: a `HippoService` (local dir, `--github`, a hosted vault, the demo) or an MCP client.
  - `hippo dashboard` serves it on 127.0.0.1 with a launch-token cookie, a Host allowlist and same-origin JSON writes.
  - The hosted app serves it behind GitHub sign-in; each account reaches only its own vault's Durable Object.
  - The UI (`apps/dashboard`, Astro + React islands) is one static build served by both, with a hash-based CSP.
- **Session Zero.** The dashboard is also the setup path. A `SetupPort` per runtime does what the machine can do:
  - Locally: create the vault (with presets), forge keys, save curator settings to `~/.config/hippocampus/env`, install the launchd job, and rehearse a dry-run sleep.
  - It shows the rest as snippets to copy, such as creating the private repo and pushing.
  - On the hosted app it walks a new account from the waitlist through creating a private repo, installing the GitHub App and bootstrapping the vault, then mints keys and sets up a curator. An admin page approves accounts.

**File path:** a local tool that can't use MCP writes `inbox/<agent>/<timestamp>-<slug>.md` with the frontmatter `HANDBOOK.md` documents. The curator ingests these exactly like MCP episodes. Agents are otherwise told (in the vault's `AGENTS.md` and the handbook) not to edit files, since the tools run the checks.

## 4. Curator ("sleep") pipeline

Each step is a small, schema-validated LLM call, so small local models can cope. Kinds decide which steps run: a kind that forbids text (or an episode with only data) skips the model entirely.

1. **Rulings.** Apply `ruling:` values the human wrote into disputes, and the human's accepted or declined proposals.
2. **Mentions.** List the entities an episode says something about. Type descriptions and `## Is` / `## Is not` examples come from the schema notes.
3. **Resolve.** Match via aliases and the episode's `about` hints and `data` links first, then search candidates plus an LLM "same thing?" choice. Otherwise create a new entity, tagged with domains (falling back to the reporting agent's lane). Identity keys decide: a key match files a new name under the existing note; a key that belongs to another note raises a `merge` proposal; a name alone never teaches a keyed type a new alias.
4. **Claims.** Extract facts (with scope, validity, confidential), relations (with role), goal progress, commitments, guidelines and answered questions about the resolved entities. Existing field names are shown so they get reused.
5. **Reconcile** (deterministic; `packages/core/src/reconcile.ts`). Precedence: **human > lane authority > corroboration > recency**.
   - Humans rank by domain: a human whose `domains` cover the field outranks the other humans; two humans with equal standing dispute.
   - A new value from a non-authoritative agent is a rumor. Once enough distinct agents repeat it, it becomes canon. A source may correct its own earlier report.
   - An authoritative value beats a non-authoritative one. Peers who disagree, or an agent contradicting a human, produce a dispute.
   - A `succession` field (an employer) closes the old value into `was` when a newer, equally ranked report comes in, and backfills older reports there; it never closes a human's value.
   - A `human_only` field takes only a human's word: anyone else's value becomes a **proposal** for the human.
6. **Kind reducers.** By behaviour, deterministically: contact `stats` for interactions, the decision log, open and answered questions, and commitments that become goals (of the kind's `goal_type`, or the default goal type), updating an open goal with the same title and counterparty instead of duplicating it.
7. **Apply** in memory, then **chronicle** the episode (secrets and confidential values redacted; a gist kind keeps only its gist; a data-only kind gets a data line) and remove it from the inbox. A confidential episode's words never reach the chronicle, summaries, guidelines or objectives.
8. **Summaries** for touched notes, then regenerate `HANDBOOK.md` and `_hippo/review.md` (disputes, proposals, possible duplicates, new guidelines, rumors, stale canon, shape notes, failures).
9. **Audit**, then **commit** as *Hippocampus* with `Hippo-Actor: curator` and `Hippo-Model` trailers, staging only the curator's paths, and push. The audit refuses the flush if it would break the curator's rules, for example a secret or confidential value appearing in plain text.

If an episode fails, it stays in the inbox for the next night. The vault's house rules (`_hippo/curator.md`, plain words the human edits) are added to every step's instructions.

## 4b. Agent-run sleep (the relay)

The hosted app has no model of its own. Instead, an agent holding a **curator key** (scope `curate`) runs sleep through `SleepRelay` (`packages/curator/src/relay.ts`):

- `sleep_start` opens a run (one at a time per vault, held by a 15-minute lease that every answer renews) and returns the first questions. Each question is one curator LLM call from the pipeline above: `system`, `prompt` and a JSON Schema.
- The agent answers with `sleep_answer`. The server validates each answer with the same zod schemas, records it, and replays the current unit (the rulings, one episode, or the finish) from a fresh vault until the unit commits. If the vault moved underneath, only questions whose inputs changed are asked again.
- `sleep_skip` leaves an unclear episode in the inbox for the human. `sleep_status` and `sleep_abort` show and stop runs. A run its curator abandons expires when its lease does, from a Durable Object alarm.
- Commits carry `Hippo-Actor: curator`, `Hippo-Model`, `Hippo-Curator` and `Hippo-Run` trailers, and pass the same audit.
- Secret values consolidated earlier in a run are kept only as seeded fingerprints, so later units can be checked for leaks without holding the value.

`SLEEP_PROCEDURE` is the shared instruction text: served as the MCP `sleep` prompt and mirrored by the Claude Code plugin's `/hippocampus:sleep` skill. `hippo serve` offers the same tools locally. A vault on the hosted app can also turn on an Actions curator: a `sleep.yml` workflow in the vault repo that runs Claude nightly with the curator key, through MCP only, without checking the repo out.

## 5. Secrets

Fields flagged secret by the model, by the episode (`secret: true`), or by the type (`fields.<name>.secret`) are stored as `secret://<entity>/<field>`. The value is encrypted with `age` to `secrets/<entity>/<field>.age`. Encrypting needs only the public recipient in `_hippo/config.yaml`, so the curator can store secrets but never read them back. `hippo secrets show` decrypts with the private identity from `~/.config/hippocampus/`. On the hosted app, the key pair is generated in the browser during setup; only the public recipient is sent, and the person downloads the identity file.

**Confidential** is a softer tier: values stay in the note (the human reads them in Obsidian) but are kept out of search, summaries, the chronicle and prompts other than the extraction itself, and masked in every read model except for a bound caller with authority. Identity keys (emails, phone numbers, repo urls) are confidential by definition.

## 6. Code layout

```
packages/core        schemas, schema registry (types, kinds, capabilities), markdown + managed regions, vault model,
                     reconcile, ops, goals, actors, kinds + reducers, inheritance, identity keys, presets, shape
                     validation, search, handbook, service, secrets, audit + commit trailers, format migrations,
                     introductions, buildVaultFiles (bootstrap), views
packages/curator     LLM adapter (AI SDK), prompts, sleep pipeline, SleepRelay (agent-run sleep)
packages/mcp         MCP tools/resources/prompts over the service
packages/index       FTS5 + relations + vectors index; node:sqlite, D1 and Durable Object SQLite drivers
packages/embeddings  Embedder adapters (OpenAI-compatible, Workers AI)
packages/store-github VaultStore over the GitHub API; SQLite blob cache; FakeGitHub
packages/template    vault-template/, seeds/ and presets/ bundled as data (`pnpm gen:template`), for the Worker and the CLI
packages/dashboard   the dashboard's JSON API, sources (service, MCP), Session Zero contract, demo campaigns
apps/dashboard       the dashboard UI (Astro + React islands), guides, Session Zero wizards (local and hosted)
apps/worker          the hosted app: OAuth, sign-in, registry, onboarding, webhooks, VaultHost Durable Object
apps/cli             `hippo`: init, preset, serve, dashboard, sleep, audit, migrate, fmt, validate, handbook, remember, secrets, index
plugins/hippocampus  Claude Code plugin: MCP server config + memory and sleep skills
vault-template/      starter vault: config, guardrails (AGENTS.md, CLAUDE.md, _hippo/curator.md), CI, templates
seeds/               example campaigns (fictional)
presets/             people, developer, business, student, household: schema notes, templates, starter notes
```

## 7. Roadmap

- **M0–M2 (done):** vault spec and template, local MCP, curator with local models, `hippo sleep` with git.
- **M3–M5 (done):** GitHub-API `VaultStore`, the Worker, OAuth connectors, embeddings for semantic recall, the dashboard.
- **M6–M7 (done):** the hosted multi-user app (GitHub App, registry, one Durable Object per vault), agent-run sleep, audit and trailers, introductions, the Claude Code plugin.
- **M8 (done):** generic building blocks (vault format v2): schema notes and capabilities, kinds, several humans, qualified and confidential facts, guidelines, decisions, questions, stats, goals, proposals, presets.
- **Next:** staleness jobs, per-vault usage reporting, more connector hosts.

## 8. Risks

- **MCP support varies by host.** The GitHub path guarantees a working route either way.
- **Small local models make weak curation decisions.** Mitigations: small steps, strict schemas, deterministic reconcile, and a golden test suite.
- **Mixed languages.** Canonical titles stay in their original spelling. Other spellings and translations go in `aliases`. Matching folds diacritics, including Turkish ı/İ.

## 9. Distribution and privacy model

- **One-way dependency.** The tool is public (this repo, published to npm as `@mehrad77/hippocampus`). Each user's vault is a separate **private** repo that runs a pinned version of the tool. The tool never contains, references, or knows about a real vault.
- **Guards.** `.gitignore` blocks vault paths. `scripts/privacy.test.ts` (in `pnpm test`, CI, and the pre-commit hook) rejects vault content and any term from a local, untracked `.privacy-denylist`. `pnpm pack:check` rejects vault data in the npm tarball.
- **Releases.** `main` is protected (PRs only). Every merge publishes the CLI to npm, versioned from conventional commits since the last `v*` tag. The tag is the version of record, so nothing is committed back to `main`. Then the hosted app deploys to the official instance, whose host and resource ids live in a GitHub environment rather than in `wrangler.jsonc` (`scripts/deploy.mjs`). The deploy applies registry migrations first, probes the live Worker afterwards, and rolls back if the probe fails.
- **Versioning.** The tool follows semver ([CHANGELOG.md](CHANGELOG.md), GitHub Releases). The on-disk vault format has its own integer `version` in `_hippo/config.yaml`. The tool refuses to write to a vault with a different version, and `hippo migrate` runs ordered migrations (`packages/core/src/migrations.ts`).
- **Evals.** Public evals are fictional (`ScriptedLLM` golden tests, `seeds/example-relocation`). Evals built from real memories stay in the private vault (`_hippo/evals/`).
- **CI.** The public repo's CI typechecks, tests, builds, checks the pack, runs the Worker end to end in workerd against a fake GitHub, and lints every workflow. The vault template ships `.github/workflows/validate.yml`, which validates every push to a private vault with `npx @mehrad77/hippocampus@<major> validate`, and runs `hippo audit` over the last day's commits once a day.

---

## Implementation status

| Area | State | Notes |
| --- | --- | --- |
| Vault spec + template + example seed | ✅ | `vault-template/`, `seeds/example-relocation/`, `hippo init --seed <name-or-path>`; format v2 with `hippo migrate` from v1 (on the hosted app, the owner clicks Upgrade on the dashboard) |
| Core model | ✅ | zod schemas, managed regions, alias/ID/link resolution, typed relations (roles, scopes, inverses) as Dataview inline fields |
| Schema registry | ✅ | Type and kind notes in `_hippo/schema/`, inline overrides in the config, `extends`, capabilities instead of type names (a grep test keeps it that way), advisory shape validation |
| Presets | ✅ | `presets/` (people, developer, business, student, household), `hippo init --preset`, `hippo preset add`, the Session Zero picker; golden nights per preset |
| Reconcile | ✅ | Pure function, table-tested: several humans, domains, succession and backfill, scoped keys, human-only proposals |
| Disputes + human rulings | ✅ | `ruling:` is applied on the next sleep, or immediately from the dashboard's Council |
| Secrets | ✅ | age, one file per field; the curator needs only the public key |
| Search | ✅ | `Searcher` port. CLI default: persistent SQLite FTS5 index (`packages/index`, `node:sqlite`, a cache in `~/.cache/hippocampus`) that syncs by content hash, with trigram typo fallback and a relations table. In-memory MiniSearch remains the fallback (`--no-index`) |
| Curator pipeline | ✅ | mentions → resolve → claims → reconcile → apply → chronicle → summaries → review + handbook |
| LLM adapter | ✅ | `prompt` structured mode (default for local servers) and `native` (hosted). Per-call timeout and token cap |
| MCP (stdio + local HTTP) | ✅ | 10 agent tools (`update_quest` is an alias of `update_goal`), 5 curator tools and a `sleep` prompt, 2 resources |
| `hippo sleep` with git | ✅ | pull --rebase --autostash → curate → stage own paths → commit → push |
| GitHub API store | ✅ | `packages/store-github`: reads pinned to one commit, blob cache by sha, each flush is one commit via the Git Data API, rebases past unrelated pushes, `StoreConflictError` on same-file races. `hippo --github owner/repo` |
| Distribution | ✅ | npm package (tsup bundle + template + seeds), vault format version + `hippo migrate`, privacy guard + pre-commit hook, CI for this repo and for vaults |
| Hosted app | ✅ | `apps/worker`: a GitHub App (Contents and Workflows read/write, Metadata read) with user authorization on install; D1 registry (accounts, vaults, hashed keys of kind `agent`, `curator` or `bound`); waitlist and admin approval; bootstrap of an empty private repo, or adoption of an existing vault (only missing guardrail files are added); a `VaultHost` Durable Object per vault with installation tokens stored in its SQLite, an audited single writer, the search index, a SQLite blob cache (inbox blobs stay in memory), the sleep run store and alarms; quotas; rate limits; webhooks that disconnect a vault when the app is uninstalled or the repo goes public; account deletion |
| Agent-run sleep | ✅ | `SleepRelay` behind the `curate` scope: questions and schema-checked answers, leased runs, replay on conflict. Served by the hosted app and `hippo serve`; the plugin skill and the Actions curator drive it |
| Audit | ✅ | `auditChanges` per actor (agent, curator, human, bootstrap, migration) before every hosted commit and every `hippo sleep` flush: human-only fields, goal-scope limits, confidential leaks, migrations that only move notes; `Hippo-*` commit trailers; `hippo audit` over git history, daily in vault CI |
| Introductions | ✅ | `introduce` tool, `inbox/<agent>/_introduction-*.md` (the `_` prefix keeps older tools from reading it as an episode), approve or dismiss on the dashboard |
| Semantic recall | ✅ | `packages/embeddings`: `Embedder` adapters for OpenAI-compatible servers (LM Studio, Ollama, hosted) and Workers AI, opt-in via `HIPPO_EMBED_*`. The index stores one normalized vector per doc version and model, mirrored in memory, and embeds only what changed. Search fuses FTS and cosine hits with reciprocal rank fusion, then lets the top hits lift related candidates (never above themselves). Embedder failures fall back to keywords |
| OAuth for connectors | ✅ | `@cloudflare/workers-oauth-provider`: the Worker is authorization server and resource (RFC 9728 discovery, DCR, PKCE, refresh). `/authorize` signs the person in to the hosted app, then shows a consent page (agent id and scopes per app; unframeable, browser-bound) for their own vault. OAuth scopes come from the token, so refreshes can narrow them. Vault keys are accepted through `resolveExternalToken` |
| Dashboard | ✅ | `packages/dashboard` + `apps/dashboard`: Tavern (with overdue contacts), Goals, Council (disputes, proposals, merges), Satchel, Codex, entity sheets (qualifiers, guidelines, stats, decisions, questions, inheritance), Map, Chronicle, Party (agents and humans), Guides, ⌘K, plus the curator panel, admin page and account menu on the hosted app. Sources: local dir, `--github`, `--mcp`, the hosted app, `--demo` (fictional, in memory) |
| Session Zero onboarding | ✅ | Local `SetupPort` in the CLI (vault, party, secrets, curator model, git visibility, agent snippets, launchd schedule, dry-run sleep, remote check). The hosted port runs the waitlist, GitHub App install, repo pick, vault bootstrap with a browser-made age key, keys and the curator |
| Push webhook reindex, CIMD | ⏳ | Every request syncs the index with the vault it loads, so a reindex webhook only matters once reads stop loading the whole vault. Client ID Metadata Documents need `global_fetch_strictly_public`, which would block the local fake GitHub in `wrangler dev`; DCR covers today's connectors |

**Lessons from local models.** LM Studio with a reasoning model returned grammar-constrained JSON in `reasoning_content`, and constrained decoding suppressed its thinking, which made classification worse. Local providers therefore default to `prompt` mode:
- The JSON Schema goes in the system prompt.
- The model thinks freely.
- The first balanced JSON object is extracted and validated with zod.
- If validation fails, the call is retried with the errors fed back.

Reasoning models can also loop, so every call has a timeout (`HIPPO_LLM_TIMEOUT_MS`, default 180 s). MoE models with ~4B active parameters have been a good speed/quality balance, at roughly 1–2 minutes per episode.

**Known limitations**
- Episodes that agents commit to GitHub stay in git history even after secrets are redacted from the chronicle.
- The curator sees secret values while extracting them. With a local model they never leave the machine; with a hosted model or a curator agent, its provider sees them. Summaries never see them.
- Commit trailers are claims. The hosted app enforces them against credentials, but anyone who can push to the vault repo can forge them, so `hippo audit` catches bugs and misbehaving models, not a hostile pusher.
