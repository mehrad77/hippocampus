# Migrating a single-vault Worker to the hosted app

Before the hosted app, `apps/worker` served one vault: it read the repo with a fine-grained token (`GITHUB_REPO`, `GITHUB_TOKEN`), wrote through the `Scribe` Durable Object, kept its index in D1 (`INDEX`) and agent tokens in KV (`TOKENS`), and let `HIPPO_OWNERS` sign in. The hosted app replaces all of that with a GitHub App, a registry, and one `VaultHost` Durable Object per vault.

**This is a breaking change.** Old agent tokens and old OAuth connections stop working, and the Worker won't start until the new settings are in place. Your vault repo itself needs nothing: the app adopts it as it is. Plan for a few minutes when agents can't reach memory.

## Before you start

- Your vault must be on the format version this release expects. In a checkout of the vault, run `npx @mehrad77/hippocampus@<new> validate`, and `migrate` if it reports an older version. The app refuses to adopt a vault whose `_hippo/config.yaml` doesn't load.
- The vault repo must be private.
- Let pending episodes wait: nothing in the inbox is lost, and the next sleep picks them up.

## 1. Create the GitHub App

Follow [USAGE.md §8, "Running your own instance", step 1](USAGE.md#running-your-own-instance). Use your existing Worker's address for the callback and webhook URLs. Convert the private key to PKCS#8.

## 2. Add the registry

```bash
cd apps/worker
pnpm exec wrangler d1 create hippocampus-registry
```

In your local `wrangler.jsonc`, start from this release's file and copy in:
- the new `REGISTRY` database id;
- your existing `OAUTH_KV` id (it's reused for sign-in and OAuth grants).

Leave out the old `INDEX` database, `TOKENS` namespace and `SCRIBE` binding: the new file doesn't have them. Keep the `migrations` list exactly as shipped. Its `v2` step deletes the `Scribe` class, which only held a cache.

Then create the registry's tables:

```bash
pnpm exec wrangler d1 migrations apply REGISTRY --remote
```

## 3. Set the new secrets, remove the old ones

```bash
pnpm exec wrangler secret put HIPPO_ADMINS
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_APP_SLUG
pnpm exec wrangler secret put GITHUB_APP_CLIENT_ID
pnpm exec wrangler secret put GITHUB_APP_CLIENT_SECRET
pnpm exec wrangler secret put GITHUB_APP_WEBHOOK_SECRET
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pkcs8.pem
```

`HIPPO_ADMINS` takes GitHub user ids (numbers), not logins: `gh api users/<your-login> --jq .id`. Keep `HIPPO_PUBLIC_URL` as it is. If you set `HIPPO_EMBED_*`, they keep working.

Remove the settings the new Worker doesn't read:

```bash
pnpm exec wrangler secret delete GITHUB_REPO
pnpm exec wrangler secret delete GITHUB_TOKEN
pnpm exec wrangler secret delete HIPPO_OWNERS
pnpm exec wrangler secret delete GITHUB_OAUTH_CLIENT_ID
pnpm exec wrangler secret delete GITHUB_OAUTH_CLIENT_SECRET
```

## 4. Deploy

From the repository root:

```bash
pnpm deploy:worker
```

Open the Worker's address. If a setting is missing, it shows a page naming it.

## 5. Sign in and adopt the vault

1. Sign in with GitHub. As an admin, you're approved at once.
2. On the setup page, install the GitHub App on your **existing** vault repo (only that repo).
3. Pick the repo. Because it already has `_hippo/config.yaml`, the app **adopts** it: nothing is rewritten, and only the guardrail files it lacks are added in one commit (`AGENTS.md`, `CLAUDE.md`, `_hippo/curator.md`, `.github/workflows/validate.yml`). The campaign step still asks for a name and your id, but an adopted vault keeps its own config.

An existing `validate.yml` is left alone, so it won't have the daily audit job. To get it, copy the file from this release's [`vault-template/`](../vault-template/.github/workflows/validate.yml).

## 6. Reconnect agents

- **Agents with tokens:** mint new keys on the setup page (an agent key, or a single-agent key per agent) and replace the old `Authorization` header in each client.
- **Claude.ai and ChatGPT connectors:** remove the connector and add it again with the same `/mcp` URL. Old connections answer "Connect it again".
- **Curator:** your local `hippo sleep` keeps working. To curate through the app instead, mint a curator key; see [USAGE.md §5](USAGE.md#5-the-curator-sleep).

## 7. Clean up

Once agents work again, delete what the old Worker used. These hold no vault content you need: the index rebuilds itself in each vault's Durable Object.

```bash
pnpm exec wrangler d1 delete hippocampus-index
pnpm exec wrangler kv namespace delete --namespace-id <old TOKENS id>
```

On GitHub, revoke the fine-grained token the old Worker used, and delete the old OAuth app (Settings → Developer settings → OAuth Apps), since sign-in now goes through the GitHub App.
