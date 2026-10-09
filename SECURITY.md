# Security

Hippocampus holds people's memories: plans, documents, people they deal with, and sometimes ID numbers and passwords. This page says what it protects, from whom, and where the limits are. It covers the hosted app (`apps/worker`) and the local CLI.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub's **Security → Report a vulnerability** on this repository, or by email to **[security contact: to be set by the maintainer]**. Include what you found and how to reproduce it, with fictional data only (see [AGENTS.md](AGENTS.md)). Never attach real vault files, inbox episodes or `secrets/*.age` files to an issue, a PR or a report.

We aim to acknowledge reports within a few days, and to credit reporters who want it.

## What lives where

| Place | What | Who controls it |
| --- | --- | --- |
| Your vault repo on GitHub | Every note, the inbox, the chronicle, disputes, age-encrypted secrets | You. It's your private repo |
| Your age identity (key file) | The only thing that can decrypt secrets | You. It never reaches the app |
| The hosted app's registry (D1) | Your GitHub id and login, your access note, your vault's repo name and status, a SHA-256 hash of each key with its label and scopes | The operator |
| Your vault's Durable Object | A search index (note text, and embeddings if on), a cache of the repo's files, sleep runs in progress, the current installation token | The operator |
| KV (`OAUTH_KV`) | Sign-in sessions, OAuth clients and grants (a grant's details are stored encrypted) | The operator |
| Logs | Route name, status, timing and a hashed vault id per request | The operator |

## What the operator of a hosted app can see

Whoever runs a hosted instance acts as a **data processor** for the vaults on it. Be clear about what that means:

- **The vault repo.** The GitHub App has Contents and Workflows read and write, and Metadata read, on the repos people install it on. The app's private key can mint tokens for any of those repos. Someone with that key, or with control of the Worker, can read and change any installed vault.
- **The index and cache.** Note text sits in each vault's Durable Object storage on Cloudflare. Inbox files are the exception: they can hold secrets in plain text until sleep encrypts them, so their contents are cached in memory only, never stored at rest. They still pass through the Worker while it serves a request.
- **The registry.** Who has an account, which repo is whose vault, and when keys were last used. Admins see names and states on the admin page, never vault content, but an operator with database access sees the same rows.
- **Embeddings.** With semantic recall on, note text goes to the configured embeddings provider (Workers AI or another API).

The operator never sees: the age identity, any key or session in plain form (only hashes are stored), or what a curator agent's model provider does with what it reads.

If you can't accept this, run the CLI locally, or [run your own instance](docs/USAGE.md#running-your-own-instance).

## Keys and what each can do

Keys are shown once when minted. Only their SHA-256 hash is stored, and revoking one stops it at once. Each kind's scopes are fixed by the server, whatever the key row says.

| Kind | Scopes | Notes |
| --- | --- | --- |
| Agent key | `read`, `remember`, `quest` | Any agent; each names itself per call. An agent can only file under its own id's inbox folder, so it can't rewrite another agent's memories, but it can claim any unused id |
| Single-agent key | `read` plus `remember` and/or `quest` | Bound to one agent id; commits under another id are refused |
| Curator key | `read`, `curate` | Runs sleep. **It sees every new memory in full, including secret values in plain text**, so whoever holds it, and its model's provider, do too |

OAuth connectors (Claude.ai, ChatGPT) get a grant for one agent id and the scopes you approve on the consent page. Approving `curate` gives the app what a curator key gives. They're listed under your account and can be disconnected there.

Agent ids are exact slugs. The vault's human id and the reserved ids `human`, `curator`, `unknown` and `hippocampus` are refused, so an agent can't pass itself off as you or the curator. A memory is capped at 8 KB.

## Secrets

Secret facts are encrypted with [age](https://age-encryption.org) to `secrets/<entity>/<field>.age`; notes hold only `secret://…` references. Encrypting needs only the public recipient in `_hippo/config.yaml`, so the curator, the hosted app and the dashboard can store secrets but never read them back.

On the hosted app, the key pair is generated **in your browser** during setup. Only the public half is sent, to be written into your vault's config. You download the identity file and keep it; the page never uploads it. Reading a secret later takes that file and `hippo secrets show` on your own machine. Locally, `hippo secrets keygen` writes it to `~/.config/hippocampus/age-identity.txt`. Back it up: without it, secret facts can't be recovered.

Limits:
- A secret-bearing memory waits in the inbox in plain text until the next sleep, and stays in the repo's git history after that.
- The curator (a local model, a hosted model, or a curator agent) reads it while extracting the value.

## Audit and commit trailers

Every commit Hippocampus makes names its actor in a `Hippo-Actor` trailer (`agent:<id>`, `curator`, `human` or `bootstrap`), with `Hippo-Model`, `Hippo-Curator` and `Hippo-Run` where they apply.

- **Before a hosted commit**, the app checks the trailer against the caller's actual credentials (a key can't commit as the curator or the human), then audits the change set against what that actor may do (`packages/core/src/audit.ts`). Agents may only add files to their own inbox folder, or edit quests with the `quest` scope. The curator may not touch human prose, facts the human set, the config, the party or `.github/`, and may not write a secret value in plain text anywhere. A refused change is never committed.
- **Before `hippo sleep` writes**, it runs the same audit on its own changes.
- **Afterwards**, the vault's CI runs `hippo audit` daily over the last day's commits. It prints commit, path and rule, never content.

Trailers are claims. Anyone who can push to the vault repo can forge them, so the audit catches bugs and misbehaving models, not a hostile pusher. Keep push access to the repo to yourself.

Each vault also has a house-rules file (`_hippo/curator.md`) and guardrail files (`AGENTS.md`, `CLAUDE.md`) that tell agents not to edit files directly. Those are instructions, not enforcement; the audit is the enforcement.

## Tenant isolation

- Each vault is served by its own Durable Object, named by the vault's id. It holds that vault's storage, caches, index and sleep runs, and nothing else.
- The Worker authenticates every request (key, OAuth grant or session) before forwarding it to the one object the credentials belong to. Credentials are stripped before the object sees the request.
- Each object's installation token is narrowed to its own repo and to Contents and Metadata. Only vault setup and the curator-workflow switch get Workflows.
- The app refuses public repos. If a vault's repo is made public, the app is uninstalled or suspended, or the repo leaves the installation, a signed GitHub webhook disconnects the vault and it stops answering.
- Per-vault quotas and per-key, per-account and per-IP rate limits keep one busy vault from starving others.

## The web side

- Sign-in is GitHub's, through the GitHub App. Sessions are `__Host-` cookies (HttpOnly, Secure, SameSite=Lax), last 7 days, and are stored hashed. Deleting the account, or revoking the app's authorization in your GitHub settings, bumps a per-account epoch that ends every session at once.
- Writes from the dashboard must come from the app's own origin.
- Pages carry a strict content security policy and can't be framed. The OAuth consent page is bound to the browser that started it.
- Admins are listed by numeric GitHub user id (`HIPPO_ADMINS`), since logins can be renamed and reclaimed. The list is re-read on every request.

## Logging

Invocation logs are off, since they'd record every URL. The Worker writes one line per request: the route name (never ids or query strings from the URL), status, timing, an error code, and a hashed vault id that's enough to group lines but not to look the vault up. Error messages aren't logged, because they can quote vault content. Operators should state their log retention in their privacy notice.

## Deleting an account

From the account menu, after typing your GitHub login:
1. all your keys are revoked, and connected apps are signed out;
2. your vault's Durable Object is wiped (index, cache, tokens, runs);
3. the GitHub App is uninstalled from your account;
4. your account and vault rows are removed. A tombstone of the account id remains, so old sessions can't come back to life.

Your vault repo is yours and stays on GitHub, untouched.

## The local CLI

- `hippo dashboard` listens on 127.0.0.1 only, opens through a one-time link, and refuses requests that don't name a loopback host or that come from another origin.
- `hippo serve --http` listens on 127.0.0.1 with no authentication: any program on the machine can connect as any agent. Use it only for agents you run yourself.
- Settings saved by Session Zero go to `~/.config/hippocampus/env` with mode 0600. API keys entered there are never sent back to the browser.
- With a hosted model provider for `hippo sleep`, episode text, secrets included, goes to that provider.

## This repository

This repo is public and must never contain real vault content. A privacy test (`scripts/privacy.test.ts`) runs in `pnpm test`, CI and a pre-commit hook, and `pnpm pack:check` checks the npm tarball. See [docs/DEVELOPING.md](docs/DEVELOPING.md).
