import type { Catalog, ChroniclePage, EntityDetail, EpisodeKind, Graph, NewPartyMember, Overview, QuestUpdate, SearchResult, Shown } from "@hippocampus/core";

/** Where the dashboard's data comes from. `setup` means no vault yet: only Session Zero works. */
export type Mode = "local" | "github" | "mcp" | "worker" | "demo" | "setup";

export interface VaultInfo {
  kind: "dir" | "github" | "mcp" | "memory";
  dir?: string;
  repo?: string;
  branch?: string;
  url?: string;
}

/** Whose name actions are filed under: the human, or (over MCP) the token's agent. */
export interface Actor {
  kind: "human" | "agent";
  id: string;
}

export interface SourceInfo {
  mode: Mode;
  vault: VaultInfo;
  campaign: string;
  human: string;
  actor: Actor;
}

export interface RuleChoice {
  /** Index into the dispute's claims. */
  claim?: number;
  /** A new value typed by the human (refused for secret fields). */
  value?: string;
  /** Apply the `ruling:` already written in the dispute note. */
  pending?: boolean;
}

export type RuleResult = { dispute: string; entity: string; field: string } & Shown;

/** The human's answer to an agent's introduction: approve it (with their own choices) or dismiss it. */
export interface IntroductionDecision {
  agent: string;
  decision: "approve" | "dismiss";
  title?: string;
  lane?: string;
  authority?: string[];
}

export type IntroductionResult = { decision: "approve"; agent: string; path: string } | { decision: "dismiss"; agent: string };

export interface Remember {
  text: string;
  kind?: EpisodeKind;
  about?: string[];
  confidence?: number;
  secret?: boolean;
  at?: string;
}

/**
 * Everything the dashboard reads and does. The optional methods are capabilities: when one is
 * missing (say, rulings over MCP) the API answers 501 and the UI hides the action.
 */
export interface DashboardSource {
  info(): Promise<SourceInfo>;
  overview(): Promise<Overview>;
  catalog(): Promise<Catalog>;
  entity(ref: string): Promise<EntityDetail>;
  graph(): Promise<Graph>;
  chronicle(month?: string): Promise<ChroniclePage>;
  search(query: string, limit?: number): Promise<SearchResult>;
  rule?(dispute: string, choice: RuleChoice, via?: string): Promise<RuleResult>;
  quest?(ref: string, update: QuestUpdate): Promise<{ quest: string; changes: string[] }>;
  remember?(input: Remember): Promise<{ id: string; path: string }>;
  addParty?(input: NewPartyMember, via?: string): Promise<{ slug: string; path: string }>;
  introduction?(input: IntroductionDecision, via?: string): Promise<IntroductionResult>;
  /** The agent-run sleep (hosted): its open run and history, and aborting a stuck run. */
  curator?: { status(): Promise<CuratorStatus>; abort(run: string, via?: string): Promise<CuratorStatus> };
}

/** Mirrors the relay's `RunStatus` (packages/curator/src/relay.ts) without depending on the curator. No memory content. */
export interface CuratorStatus {
  run?: { id: string; curator: string; model: string; started: string; leaseUntil: string; live: boolean; progress: { done: number; total: number; unit: string } };
  history: {
    id: string;
    curator: string;
    model: string;
    started: string;
    ended: string;
    outcome: "done" | "expired" | "aborted";
    consolidated: number;
    failed: number;
    skipped: number;
    summaries: number;
    remaining: number;
    /** How many commits the run made. */
    commits: number;
  }[];
}

export type SetupKind = "local" | "hosted" | "none";

export interface Capabilities {
  rule: boolean;
  quest: boolean;
  remember: boolean;
  party: boolean;
  /** Approve or dismiss agents' introductions. */
  introductions: boolean;
  /** Which Session Zero backend answers `/setup/*`. */
  setup: SetupKind;
  /** The agent-run sleep's status and abort (`GET curator`, `POST actions/curator`). */
  curator: boolean;
}

/** `GET /session`: what the UI needs before rendering anything. */
export interface SessionInfo extends Partial<Omit<SourceInfo, "mode">> {
  mode: Mode;
  /** Signed-in GitHub user (Worker only). */
  user?: { login: string };
  /** The hosted app's account (Worker only): drives the waitlist screens and the admin link. */
  account?: { status: "waitlisted" | "approved"; admin: boolean };
  capabilities: Capabilities;
  /** Set when a vault is configured but can't be loaded (e.g. an older format): the UI explains and links to setup. */
  error?: { code: string; message: string };
}

export function capabilities(source: DashboardSource | undefined, setup: SetupKind): Capabilities {
  return {
    rule: !!source?.rule,
    quest: !!source?.quest,
    remember: !!source?.remember,
    party: !!source?.addParty,
    introductions: !!source?.introduction,
    curator: !!source?.curator,
    setup,
  };
}
