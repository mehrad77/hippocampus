// Type-only re-exports: the browser bundle never includes core's code, only its shapes.
import type { HostedConnectedApp, HostedRepo, HostedSetupStatus, HostedVaults } from "@hippocampus/dashboard";

export type {
  Authority,
  EpisodeKind,
  GoalState,
  QuestStatus,
  Attention,
  CadenceView,
  Catalog,
  ChroniclePage,
  ChronicleEntryView,
  ClaimView,
  ClockView,
  DisputeView,
  EntityCard,
  EntityDetail,
  EpisodeView,
  FactDetail,
  FactFinding,
  FactStatus,
  FieldView,
  GoalCard,
  GuidelinesDetail,
  GuidelineView,
  Graph,
  HumanView,
  IntroductionView,
  KindView,
  OverdueView,
  Overview,
  PartyMember,
  ProposalDecision,
  QuestCard,
  Ref,
  SchemaView,
  SearchResult,
  Shown,
  TypeView,
  Upcoming,
  DecisionEntry,
  QuestionEntry,
  Stats,
  SecretFile,
} from "@hippocampus/core";
export type {
  AgentConnect,
  Capabilities,
  CuratorStatus,
  HostedAgentClaim,
  HostedConnectedApp,
  HostedCuratorActionsResult,
  HostedInitRequest,
  HostedInitResult,
  HostedKeyInfo,
  HostedKeyRequest,
  HostedMintedKey,
  HostedRepo,
  HostedSessionInfo,
  HostedSetupStatus,
  HostedVault,
  GitStatus,
  IntroductionDecision,
  IntroductionResult,
  LlmServer,
  LlmSettings,
  LlmSetupRequest,
  LocalVaultStatus,
  PresetInfo,
  ScheduleStatus,
  VaultSetupRequest,
  Job,
  LocalSetupStatus,
  ProposalChoice,
  RuleChoice,
  RuleResult,
  SessionInfo,
  SetupItem,
  SetupState,
  SetupStatus,
  Snippet,
  VaultUpgrade,
} from "@hippocampus/dashboard";

// Shapes of hosted routes the shared contracts don't type yet (apps/worker/src/hosted). Optional
// fields are ones the UI uses when the Worker sends them.

/** `GET setup/status` on the hosted app. */
export type HostedStatus = HostedSetupStatus;
export type { HostedVaults };

/**
 * A repo in `GET setup/repos` (`adoptable`: it already holds a Hippocampus vault). `yours` says it's one of the
 * person's connected vaults here already; `reconnect`, one that's disconnected, so picking it brings it back.
 */
export type HostedRepoView = HostedRepo & { yours?: boolean; reconnect?: boolean };

/** `GET account`. */
export interface AccountInfo {
  id: number;
  login: string;
  status: "waitlisted" | "approved" | "denied" | "deleted";
  admin: boolean;
  vault?: { id: string; fullName: string; status: "bootstrapping" | "ready" | "disconnected" };
}

/** `GET account/apps`: connectors (Claude.ai, ChatGPT, …) signed in with OAuth. */
export type AccountApp = HostedConnectedApp;

/** `GET admin/accounts`. */
export interface AdminAccount {
  id: number;
  login: string;
  status: "waitlisted" | "approved" | "denied" | "deleted";
  note?: string;
  created: string;
  updated: string;
  admin: boolean;
}

/** `GET admin/vaults`. Names and states only, never content. */
export interface AdminVault {
  id: string;
  fullName: string;
  status: "bootstrapping" | "ready" | "disconnected";
  reason?: string;
  login: string;
  created: string;
}
