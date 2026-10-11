// Session Zero: the contract between the setup wizard (UI) and the backends that answer it.
// Local (`hippo dashboard`) can act on this machine; hosted (the multi-user Worker) takes an account
// from the waitlist to a vault in their own private repo.
//
// Routes, all under `<base>/api/setup/` (POST bodies are JSON; unknown routes → 404, unsupported → 501):
//
//   all     GET  status            → LocalSetupStatus | HostedSetupStatus
//   local   POST vault             VaultSetupRequest → { ok: true } (the server switches to the new vault in place)
//   local   POST secrets           { reuseExisting?: boolean } → { recipient, identityFile }
//   local   GET  llm               → LlmSettings
//   local   POST llm               LlmSetupRequest → LlmSettings
//   local   GET  llm/models        → { servers: LlmServer[] }  (probes LM Studio :1234 and Ollama :11434)
//   local   POST llm/test          {} → { ok, model, ms, error? }
//   local   GET  git               → GitStatus
//   local   POST git/visibility    {} → { visibility: "public" | "private" | "unknown" }
//   local   GET  schedule          → ScheduleStatus
//   local   POST schedule          { hour, minute } | { remove: true } → ScheduleStatus
//   local   POST jobs              { kind: "sleep-dry-run" | "reindex", limit? } → { id }
//   local   GET  jobs/<id>         → Job
//   local   POST remote/check      { url } → { mcp, oauth, dashboard, error? }
//   local   POST remote            { workerUrl?, embed?: { provider?, baseURL?, model?, apiKey? } } → { ok: true }
//   hosted  POST access            { note } → { ok: true }  (waitlisted accounts ask to be let in)
//   hosted  GET  repos             → { installation: { id }, repos: HostedRepo[] }  (the just-installed app's repos)
//   hosted  POST init              HostedInitRequest → HostedInitResult  (initializes or adopts the repo)
//   hosted  GET  keys              → { keys: HostedKeyInfo[], agents?: HostedAgentClaim[] }
//   hosted  POST keys              HostedKeyRequest → HostedMintedKey
//   hosted  POST keys/revoke       { id } → { ok: true }
//   hosted  POST curator-actions   { enable: boolean } → { enabled, path }  (the vault's nightly sleep on GitHub Actions)
//   hosted  POST vaults/remove     { id, confirm: fullName } → { ok: true }  (forgets the vault; its repo stays)
//
// On the hosted app a person can have several vaults. Every request may name one in the `x-hippo-vault`
// header (VAULT_HEADER); without it the one they used last is meant. Keys, curator-actions and the
// vault's own API act on that vault.
//
// The hosted app's account routes, under `<base>/api/account/`:
//
//   GET  apps                      → { apps: HostedConnectedApp[] }  (apps connected over OAuth)
//   POST apps/revoke               { id } → { ok: true }
//
// And `GET <base>/api/vaults` → HostedVaults: the person's vaults, for the switcher. Sharing, on the
// vault the request picked (owner only, except listing and leaving):
//
//   GET  vaults/members            → HostedMembers
//   POST vaults/members/invite     { role, human, domains?, login? } → HostedNewInvite
//   POST vaults/members/role       { user, role } → { ok: true }
//   POST vaults/members/remove     { user } → { ok: true }
//   POST vaults/invites/revoke     { id } → { ok: true }
//   POST vaults/leave              {} → { ok: true }  (a member or viewer leaves)
//
// Invites to the app itself, and accepting any invite (waitlisted accounts too; accepting approves them):
//
//   GET  invites                   → HostedInvites
//   POST invites                   { login? } → HostedNewInvite
//   POST invites/revoke            { id } → { ok: true }
//   POST invites/peek              { token } → HostedIncomingInvite
//   POST invites/accept            { token } | { id } → { vault?: HostedVault }  (`id` only for an invite addressed to you)
//   POST invites/decline           { id } → { ok: true }
//
// Party members are added through the main API (`POST actions/party`), so it works in every writable mode.

import type { Capabilities, SessionInfo } from "./source.ts";

/** The request header naming which of the person's vaults a hosted request is about. */
export const VAULT_HEADER = "x-hippo-vault";

export type SetupState = "done" | "todo" | "warn" | "error" | "optional" | "na";

export interface SetupItem {
  /** Stable id, also the wizard step it belongs to: vault, party, secrets, llm, git, agents, schedule, remote, oauth, index, tokens, … */
  id: string;
  title: string;
  state: SetupState;
  detail: string;
  /** `performed`: the dashboard can do it for you. `guided`: it shows you exactly what to run. */
  how: "performed" | "guided";
}

/** A copy-paste snippet, generated server-side with real paths and URLs. */
export interface Snippet {
  label: string;
  lang: "bash" | "json" | "text" | "toml" | "yaml";
  code: string;
  note?: string;
}

export interface AgentConnect {
  agent: string;
  title: string;
  lastSeen?: string;
  snippets: Snippet[];
}

export interface Job {
  id: string;
  kind: "sleep-dry-run" | "reindex";
  state: "running" | "done" | "error";
  started: string;
  log: string[];
  /** A short, human summary once done. */
  summary?: string;
  error?: string;
}

// ── Local (CLI) ───────────────────────────────────────────────────────────────

export interface LocalVaultStatus {
  kind: "dir" | "github" | "mcp";
  dir?: string;
  repo?: string;
  branch?: string;
  url?: string;
  version: "current" | "older" | "newer" | "unknown";
  /** Saved as HIPPO_VAULT / HIPPO_GITHUB_REPO in the user env file, so `hippo dashboard` opens it next time. */
  isDefault: boolean;
}

export interface SecretsStatus {
  identityFile: string;
  identity: boolean;
  recipient?: string;
  /** The vault's `secrets.recipient` belongs to the identity on this machine. */
  matches: boolean;
}

export interface LlmSettings {
  provider: string;
  model: string;
  baseURL?: string;
  /** Write-only: the dashboard never sends keys back. */
  apiKey: "set" | "unset";
  /** Settings coming from the shell or a cwd `.env`, which win over the user env file. */
  overriddenBy: string[];
}

export interface LlmServer {
  name: string;
  url: string;
  models: string[];
}

export interface GitStatus {
  repo: boolean;
  branch?: string;
  /** Host and path only; credentials in remote URLs are stripped. */
  remote?: { name: string; host: string; path: string };
  upstream?: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
  ghAvailable: boolean;
}

export interface ScheduleStatus {
  platform: string;
  /** launchd install is supported on macOS; elsewhere the wizard shows a cron line. */
  supported: boolean;
  label: string;
  /** Where the launchd agent lives (or would), e.g. `~/Library/LaunchAgents/<label>.plist`. */
  plistPath?: string;
  installed: boolean;
  loaded?: boolean;
  hour?: number;
  minute?: number;
  nextRun?: string;
  cron: string;
}

export interface LocalSetupStatus {
  kind: "local";
  items: SetupItem[];
  vault?: LocalVaultStatus;
  defaults: { dir: string; timezone?: string; seeds: string[]; domains: string[]; presets?: PresetInfo[] };
  secrets: SecretsStatus;
  llm: LlmSettings;
  git?: GitStatus;
  schedule: ScheduleStatus;
  remote: { workerUrl?: string; embed?: { provider?: string; model?: string; baseURL?: string; apiKey?: "set" | "unset" } };
  agents: AgentConnect[];
  /** Agents seen in the inbox or chronicle without a party note. */
  unknownAgents: string[];
  envFile: string;
}

/** A preset a new vault can start with (see `presets/` and `hippo preset list`). */
export interface PresetInfo {
  name: string;
  description: string;
}

export type VaultSetupRequest =
  | { action: "create"; dir: string; campaign: string; human: string; timezone: string; domains: string[]; seed?: string; presets?: string[]; makeDefault?: boolean }
  | { action: "open"; dir: string; makeDefault?: boolean }
  | { action: "github"; repo: string; branch?: string; token?: string; makeDefault?: boolean }
  | { action: "mcp"; url: string; token?: string };

export interface LlmSetupRequest {
  provider: string;
  model: string;
  baseURL?: string;
  /** Omitted keeps the saved key, `null` removes it. */
  apiKey?: string | null;
}

export type SetupStatus = LocalSetupStatus;

/**
 * A Session Zero backend. The API owns transport and security; the port owns the routes under
 * `/setup/` (`status` is required, the rest are up to each runtime).
 */
export interface SetupPort {
  kind: "local";
  status(): Promise<SetupStatus>;
  /** `path` is relative to `/setup/` (e.g. `vault`, `jobs/abc`). Throw `HttpError(404)` for unknown routes. */
  handle(method: "GET" | "POST", path: string, body: unknown, url: URL): Promise<unknown>;
}

// ── Hosted (multi-user Worker) ────────────────────────────────────────────────

export interface HostedRepo {
  /** The provider's repo (GitLab: project) id: what `init` takes. */
  id: number;
  fullName: string;
  private: boolean;
  /** No commits yet. Unknown (absent) when it wasn't checked, e.g. for public repos. */
  empty?: boolean;
}

export interface HostedVault {
  id: string;
  fullName: string;
  branch: string;
  status: "bootstrapping" | "ready" | "disconnected";
  /** Why it's disconnected: uninstalled, suspended, repo_removed, repo_deleted, public, bootstrap_failed, token_revoked. */
  reason?: string;
  /** Where the repo lives; absent means GitHub. */
  provider?: "github" | "gitlab";
  /** The repo's page on its host, for links. */
  url?: string;
  /** What the signed-in person may do with it: everything, act as their human, or only read. */
  role?: HostedRole;
  /** For a vault shared with them: the human they are in it. */
  human?: string;
}

export type HostedRole = "owner" | "member" | "viewer";

/** Someone a vault is shared with (or its owner). */
export interface HostedMember {
  /** Their user id here. */
  user: string;
  login: string;
  role: HostedRole;
  human?: string;
  since: string;
}

/** An open invite, as whoever made it sees it. */
export interface HostedInvite {
  id: string;
  /** Unset: an invite to the app alone. */
  vault?: string;
  role?: Exclude<HostedRole, "owner">;
  human?: string;
  /** Only this GitHub login can accept it. */
  login?: string;
  created: string;
  expires: string;
}

/** An invite as the person it's for sees it, before accepting. */
export interface HostedIncomingInvite {
  id: string;
  /** Who sent it (their login). */
  from: string;
  vault?: { id: string; fullName: string };
  role?: Exclude<HostedRole, "owner">;
  human?: string;
  /** Only this login can accept it. */
  login?: string;
  expires: string;
}

/** `GET vaults/members`: who's in the vault; for its owner also the open invites. */
export interface HostedMembers {
  members: HostedMember[];
  invites?: HostedInvite[];
  /** The signed-in person's user id, to mark them in the list. */
  you: string;
}

/** A new invite and its link (shown once). */
export interface HostedNewInvite {
  invite: HostedInvite;
  link: string;
}

/** `GET invites`: the person's invites to the app, and invites waiting for them. */
export interface HostedInvites {
  sent: HostedInvite[];
  /** How many of their invites were accepted. */
  accepted: number;
  canInvite: boolean;
  /** How many open app invites they may have; absent for admins (no cap). */
  limit?: number;
  incoming: HostedIncomingInvite[];
}

/** `GET /vaults`: the person's vaults, oldest first, and which one requests without VAULT_HEADER act on. */
export interface HostedVaults {
  vaults: HostedVault[];
  current?: string;
  /** How many vaults one person may have. */
  limit: number;
}

/** The account's GitLab connection, when the instance offers GitLab. */
export interface HostedGitLab {
  connected: boolean;
  /** The GitLab username, once connected. */
  login?: string;
  /** Their projects a vault could use (private or not; `private` and `empty` say which are fit). */
  repos?: HostedRepo[];
  /** Why the projects couldn't be listed, or that the connection must be redone. */
  error?: string;
  /** Where to send the person to connect (GitLab's consent page, via the Worker). */
  connectUrl: string;
  /** GitLab's new-project form. */
  newRepoUrl: string;
}

/** An agent name and the connection that holds it: `key:<key id>` or `oauth:<grant id>`. Who has spoken through what. */
export interface HostedAgentClaim {
  agent: string;
  credential: string;
  since: string;
}

/** A vault key, without the key: only its SHA-256 is stored. */
export interface HostedKeyInfo {
  id: string;
  /** `agent`: any agent, which names itself; `curator`: the curator's key; `bound`: one agent. */
  kind: "agent" | "curator" | "bound";
  agent?: string;
  scopes: string[];
  label: string;
  /** The app it was made for (`claude-code`, `cursor`…), when known. */
  app?: string;
  created: string;
  lastUsed?: string;
}

export interface HostedMintedKey extends HostedKeyInfo {
  /** Shown exactly once. */
  token: string;
  snippets: Snippet[];
}

export interface HostedSetupStatus {
  kind: "hosted";
  account: { login: string; status: "waitlisted" | "approved" | "denied"; requested: boolean; admin: boolean };
  /** Install the GitHub App (choosing the repo there). */
  installUrl: string;
  /** GitHub's new-repo form, prefilled with a private repo. */
  newRepoUrl: string;
  /** The hosts a vault can live on. GitHub always; GitLab when the instance has it set up. Absent means GitHub only. */
  providers?: ("github" | "gitlab")[];
  /** The GitLab connection, until a vault is set up. Present when `providers` has `gitlab`. */
  gitlab?: HostedGitLab;
  /** The installation just made, until a vault is set up on it. */
  installation?: { id: number; repos: HostedRepo[]; error?: string };
  /** The vault this status is about (VAULT_HEADER's, else the last one used). */
  vault?: HostedVault;
  /** All of the person's vaults, oldest first. */
  vaults?: HostedVault[];
  /** How many vaults one person may have. */
  vaultLimit?: number;
  keys?: HostedKeyInfo[];
  /** Whether the vault runs sleep nightly on GitHub Actions (its `.github/workflows/sleep.yml`). Absent when it couldn't be checked, and for GitLab vaults. */
  curatorActions?: boolean;
  publicUrl: string;
  mcpUrl: string;
  /** Presets a new vault can start with. */
  presets?: PresetInfo[];
  items: SetupItem[];
}

export interface HostedInitRequest {
  /** Where the repo lives; default `github`. */
  provider?: "github" | "gitlab";
  /** The repo's id at that provider. */
  repoId: number;
  /** What the memory is about. One of `name` and `campaign` is required. */
  name?: string;
  /** @deprecated The older name of `name`. */
  campaign?: string;
  /** Shorthand for `humans: [{ id: human }]`; one of the two is required. */
  human?: string;
  /** The vault's humans, primary first. Without a `github:` on any of them, the signed-in login goes on the first. */
  humans?: { id: string; github?: string; domains?: string[] }[];
  timezone: string;
  domains: string[];
  seed?: "example-relocation";
  /** age public key for `secrets.recipient`. */
  recipient?: string;
  /** Presets to lay over the template, in order (names from `HostedSetupStatus.presets`). */
  presets?: string[];
}

export interface HostedInitResult {
  vault: HostedVault;
  /** `initialized`: the template went in; `adopted`: an existing vault got only its missing guardrail files. */
  mode: "initialized" | "adopted";
  /** Adopted a vault that already has a different secrets recipient: the key made at setup was not used. */
  recipientKept?: boolean;
}

export interface HostedKeyRequest {
  kind: "agent" | "curator" | "bound";
  label?: string;
  /** Bound keys only. */
  agent?: string;
  /** Bound keys only, from read, remember, quest (read required). */
  scopes?: string[];
}

/** `POST curator-actions`: turn the vault's nightly GitHub Actions curator on or off. */
export interface HostedCuratorActionsResult {
  enabled: boolean;
  /** The workflow file in the vault repo. */
  path: string;
}

/** An app connected over OAuth (Claude.ai, ChatGPT…), as the account sees it. */
export interface HostedConnectedApp {
  /** The grant's id, for revoking it. */
  id: string;
  /** The app's name as it registered itself (not verified). */
  client: string;
  scopes: string[];
  /** The agent it acts as. */
  agent?: string;
  /** The vault it's connected to (its id). */
  vault?: string;
  created: string;
}

/**
 * Session Zero on the hosted app. Kept apart from `SetupPort` so local and remote consumers stay
 * exhaustive until the UI learns this kind.
 */
export interface HostedSetupPort {
  kind: "hosted";
  /** `?add` in `url`: the person is setting up another vault. */
  status(url?: URL): Promise<HostedSetupStatus>;
  handle(method: "GET" | "POST", path: string, body: unknown, url: URL): Promise<unknown>;
}

/** `GET /session` on the hosted app while the account has no ready vault: only Session Zero works. */
export interface HostedSessionInfo extends Omit<SessionInfo, "mode" | "user" | "capabilities"> {
  mode: "setup";
  user: { login: string };
  capabilities: Omit<Capabilities, "setup"> & { setup: "hosted" };
  account: { status: "waitlisted" | "approved"; admin: boolean };
}

/** `GET admin/referrals`: everyone, and who invited whom (oldest first). Logins and states only. */
export interface AdminReferrals {
  people: { user: string; login: string; status: "waitlisted" | "approved" | "denied" | "deleted"; invitedBy?: string; canInvite: boolean }[];
  /** `from` invited `to`, who accepted at `at`; `vault` names the vault the invite shared, if any. */
  edges: { from: string; to: string; at: string; vault?: string }[];
}

/**
 * `GET connect?code=`: an app asking to connect on the person's behalf (device sign-in), for them to
 * approve with `POST connect/approve { code, vault, agent?, access, seat? }` or refuse with `POST connect/deny { code }`.
 */
export interface HostedDeviceRequest {
  code: string;
  /** The app's name, as it gave it (not verified). */
  client: string;
  /** The agent id it asked for. */
  agent?: string;
  access?: "remember" | "read" | "curate";
  expires: string;
  /** The person's vaults it could connect to. */
  vaults: HostedVault[];
  current?: string;
}
