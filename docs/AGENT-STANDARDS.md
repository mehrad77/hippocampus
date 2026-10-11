# Agent-facing standards: what we follow, and when to look again

The hosted app tells agents about itself, and lets them connect, using conventions that are still settling. This page lists each one: how settled it was when we adopted it, what we implemented, and when to check it again. **Next review: 2027-01-11** (three months after 2026-10-11), then every six months.

When you review: check each "Watch for" line, update the code it names, change "Last checked", and move the next review date.

| Convention | Status (2026-10-11) | What we do | Code | Watch for |
| --- | --- | --- | --- | --- |
| [llms.txt](https://llmstxt.org/) | Community proposal. Widely published (~10% of sites); coding agents read it, search crawlers mostly don't | `/llms.txt`: what Hippocampus is, how an agent connects itself (device sign-in) or guides a person, the MCP address and tools, links to guides | `apps/worker/src/discovery.ts` | `/llms-full.txt` or per-page `.md` becoming expected; a `Link: rel="describedby"` habit |
| MCP Server Cards ([SEP-2127](https://modelcontextprotocol.io/seps/2127-mcp-server-cards)) | Final (Extensions Track); the schema lives in [experimental-ext-server-card](https://github.com/modelcontextprotocol/experimental-ext-server-card) and may still evolve | `GET /mcp/server-card` (`application/mcp-server-card+json`, open CORS, 1-hour cache): identity, the remote at `/mcp`, protocol versions, an optional `Authorization` header | `apps/worker/src/discovery.ts` | The repo graduating to `ext-server-card`; field changes in `schema.ts`; clients starting to fetch cards; ETag/304 (we don't send ETags yet) |
| [AI Catalog](https://github.com/Agent-Card/ai-catalog) | Early; referenced by SEP-2127 for domain-level discovery | `/.well-known/ai-catalog.json` (`application/ai-catalog+json`) with one entry pointing at the server card | `apps/worker/src/discovery.ts` | Its `specVersion` and `identifier` format (`urn:air:…`) changing; whether it's registered as a well-known URI |
| Earlier server-card paths (`/.well-known/mcp.json`, `/.well-known/mcp/server-card.json`, SEP-1649, SEP-1960) | Superseded by SEP-2127 (which advises against `.well-known` for the card itself) | Not served | — | Clients that still only look there |
| OAuth 2.1 for MCP: protected resource metadata ([RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)), authorization server metadata ([RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414)), PKCE, resource indicators ([RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707)) | In the MCP spec | Served by `@cloudflare/workers-oauth-provider` for `/mcp` | `apps/worker/src/oauth.ts` | — |
| Client ID Metadata Documents (CIMD) and Dynamic Client Registration | The MCP spec prefers CIMD; reports say the 2026-07-28 revision deprecates DCR (not verified against the spec text) | DCR only (`/oauth/register`, rate-limited by IP). CIMD is off: the library's `client_id_metadata_document_supported` is false and the Worker doesn't set `global_fetch_strictly_public` | `apps/worker/src/oauth.ts`, `app.ts` | Removing DCR once clients use CIMD: turn CIMD on first (its SSRF limits need the `global_fetch_strictly_public` flag) |
| Device sign-in, in the shapes of the OAuth device grant ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)) | RFC 8628 is a standard; MCP doesn't define device flow for agents. Ours issues a **vault key**, not an OAuth token, so it isn't advertised in the authorization server's metadata | `POST /connect/device`, `POST /connect/token`, approval page `/dashboard/connect/` | `apps/worker/src/hosted/device.ts`, `device-routes.ts`, `apps/dashboard/src/islands/ConnectApprove.tsx` | MCP adding a device or agent-delegation flow (then issue OAuth tokens through it and advertise `device_authorization_endpoint`) |
| [AGENTS.md](https://agents.md/) | Widely used by coding agents | In this repo and in every vault (`vault-template/AGENTS.md`) | — | — |
| A2A agent cards (`/.well-known/agent.json`), agents.json | For agents that others call as services; agents.json has little uptake | Not served: Hippocampus is an MCP server, not an agent | — | A2A converging with MCP discovery |

## How the pieces fit

An agent that lands on the instance reads `/llms.txt`, or finds the server card through the AI Catalog. To connect, it either:

- signs in through the device flow: the person approves on the dashboard and picks the vault, the agent and its access; the agent gets a key for that vault and its `/mcp/<vault id>` address; or
- follows the MCP 401 to OAuth (RFC 9728 discovery), which works with clients that support it (Claude.ai and ChatGPT connectors; still in beta here); or
- guides the person to **Setup → Connected apps → Connect an app**.

Nothing these documents serve names a person or a vault.

Last checked: 2026-10-11.
