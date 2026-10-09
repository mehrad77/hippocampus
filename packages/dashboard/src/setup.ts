// Session Zero: the contract between the setup wizard (UI) and the two backends that answer it.
// Local (`hippo dashboard`) can act on this machine; remote (the Worker) reports health and manages tokens.
//
// Routes, all under `<base>/api/setup/` (POST bodies are JSON; unknown routes → 404, unsupported → 501):
//
//   both    GET  status            → LocalSetupStatus | RemoteSetupStatus
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
//   remote  GET  tokens            → { tokens: TokenInfo[] }
//   remote  POST tokens            { agent, scopes } → MintedToken
//   remote  POST tokens/revoke     { id } → { ok: true }
//
// Party members are added through the main API (`POST actions/party`), so it works in every writable mode.

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
  defaults: { dir: string; timezone?: string; seeds: string[]; domains: string[] };
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

export type VaultSetupRequest =
  | { action: "create"; dir: string; campaign: string; human: string; timezone: string; domains: string[]; seed?: string; makeDefault?: boolean }
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

// ── Remote (Worker) ────────────────────────────────────────────────────────────

export interface TokenInfo {
  /** SHA-256 of the token (the KV key); the token itself is never stored. */
  id: string;
  agent: string;
  scopes: string[];
  created?: string;
}

export interface RemoteSetupStatus {
  kind: "remote";
  items: SetupItem[];
  publicUrl?: string;
  oauth: { on: boolean; owners: number; missing: string[] };
  repo: { name: string; branch: string; head?: string; private?: boolean };
  index: { entities?: number; embedder?: string; lastError?: string };
  agents: AgentConnect[];
  unknownAgents: string[];
}

export interface MintedToken extends TokenInfo {
  /** Shown exactly once. */
  token: string;
  snippets: Snippet[];
}

export type SetupStatus = LocalSetupStatus | RemoteSetupStatus;

/**
 * A Session Zero backend. The API owns transport and security; the port owns the routes under
 * `/setup/` (`status` is required, the rest are up to each runtime).
 */
export interface SetupPort {
  kind: "local" | "remote";
  status(): Promise<SetupStatus>;
  /** `path` is relative to `/setup/` (e.g. `vault`, `jobs/abc`). Throw `HttpError(404)` for unknown routes. */
  handle(method: "GET" | "POST", path: string, body: unknown, url: URL): Promise<unknown>;
}
