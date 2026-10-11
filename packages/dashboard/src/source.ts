import type { Catalog, ChroniclePage, EntityDetail, EpisodeData, EpisodeKind, GoalUpdate, Graph, NewPartyMember, Overview, ProposalDecision, QuestUpdate, SearchResult, Shown } from "@hippocampus/core";

/** Where the dashboard's data comes from. `setup` means no vault yet: only Session Zero works. */
export type Mode = "local" | "github" | "mcp" | "worker" | "demo" | "setup";

export interface VaultInfo {
  kind: "dir" | "github" | "mcp" | "memory";
  dir?: string;
  repo?: string;
  branch?: string;
  url?: string;
}

/** Whose name actions are filed under: one of the vault's humans, or (over MCP) the token's agent. */
export interface Actor {
  kind: "human" | "agent";
  id: string;
}

export interface SourceInfo {
  mode: Mode;
  vault: VaultInfo;
  /** The vault's name. */
  name?: string;
  /** @deprecated Same as `name`. */
  campaign: string;
  /** The primary human. */
  human: string;
  /** Every human's id, the primary first. */
  humans?: string[];
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

/** `POST actions/upgrade-vault`: what the owner's Upgrade did. Nothing changed when the vault was current already. */
export interface VaultUpgrade {
  upgraded: boolean;
  from: number;
  to: number;
  /** How many paths the upgrade commit changed. */
  changed: number;
  /** What the owner should know: things carried over in another shape, or left as they were. */
  notes: string[];
}

/** Which of `remember`'s optional inputs a source takes (servers from before them don't). */
export interface RememberFields {
  confidential: boolean;
  data: boolean;
}

export type IntroductionResult = { decision: "approve"; agent: string; path: string } | { decision: "dismiss"; agent: string };

/** A human settles a proposal or a possible merge (merges can only be declined). */
export interface ProposalChoice {
  decision: "accept" | "decline";
  /** A value typed by the human instead of the proposed one (refused for secret fields). */
  value?: string;
  /** Index into the proposal's claims (default: the latest). */
  claim?: number;
}

export interface Remember {
  text?: string;
  kind?: EpisodeKind;
  data?: EpisodeData;
  confidential?: boolean;
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
  goal?(ref: string, update: GoalUpdate): Promise<{ goal: string; changes: string[] }>;
  /** @deprecated The v1 shape of `goal`; sources that have `goal` may leave it out (the API translates). */
  quest?(ref: string, update: QuestUpdate): Promise<{ quest: string; changes: string[] }>;
  proposal?(ref: string, choice: ProposalChoice, via?: string): Promise<ProposalDecision>;
  /** A human withdraws a fact (`field`, or `field` in `scope`): it becomes retconned. */
  retract?(ref: string, field: string, scope?: string, via?: string): Promise<{ entity: string; field: string }>;
  remember?(input: Remember): Promise<{ id: string; path: string }>;
  /** Absent: `remember` takes every field. A source that doesn't answers 501 for the ones it lacks. */
  rememberFields?: RememberFields;
  addParty?(input: NewPartyMember, via?: string): Promise<{ slug: string; path: string }>;
  introduction?(input: IntroductionDecision, via?: string): Promise<IntroductionResult>;
  /** The agent-run sleep (hosted): its open run and history, and aborting a stuck run. */
  curator?: { status(): Promise<CuratorStatus>; abort(run: string, via?: string): Promise<CuratorStatus> };
  /** The owner's Upgrade button (hosted): bring an older vault to the current format. */
  upgradeVault?(via?: string): Promise<VaultUpgrade>;
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
  /** Goal updates (`POST actions/goal`). */
  goal: boolean;
  /** @deprecated Same as `goal`. */
  quest: boolean;
  /** Accept or decline proposals and merges. */
  proposal: boolean;
  /** Withdraw a fact. */
  retract: boolean;
  remember: boolean;
  /** `remember` can mark an episode confidential. */
  confidential: boolean;
  /** `remember` takes a kind's structured `data`. */
  data: boolean;
  party: boolean;
  /** Approve or dismiss agents' introductions. */
  introductions: boolean;
  /** Which Session Zero backend answers `/setup/*`. */
  setup: SetupKind;
  /** The agent-run sleep's status and abort (`GET curator`, `POST actions/curator`). */
  curator: boolean;
  /** The owner can upgrade an older vault from the dashboard (`POST actions/upgrade-vault`). */
  upgrade: boolean;
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
    goal: !!(source?.goal || source?.quest),
    quest: !!(source?.goal || source?.quest),
    proposal: !!source?.proposal,
    retract: !!source?.retract,
    remember: !!source?.remember,
    confidential: !!source?.remember && source.rememberFields?.confidential !== false,
    data: !!source?.remember && source.rememberFields?.data !== false,
    party: !!source?.addParty,
    introductions: !!source?.introduction,
    curator: !!source?.curator,
    upgrade: !!source?.upgradeVault,
    setup,
  };
}
