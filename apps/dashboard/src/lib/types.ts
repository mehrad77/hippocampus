// Type-only re-exports: the browser bundle never includes core's code, only its shapes.
import type { HostedConnectedApp, HostedRepo, HostedSetupStatus } from "@hippocampus/dashboard";

export type {
  Authority,
  EpisodeKind,
  QuestStatus,
  Attention,
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
  Graph,
  IntroductionView,
  Overview,
  PartyMember,
  QuestCard,
  Ref,
  SearchResult,
  Shown,
  Upcoming,
} from "@hippocampus/core";
export type {
  AgentConnect,
  Capabilities,
  CuratorStatus,
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
  ScheduleStatus,
  VaultSetupRequest,
  Job,
  LocalSetupStatus,
  RuleChoice,
  RuleResult,
  SessionInfo,
  SetupItem,
  SetupState,
  SetupStatus,
  Snippet,
} from "@hippocampus/dashboard";

// Shapes of hosted routes the shared contracts don't type yet (apps/worker/src/hosted). Optional
// fields are ones the UI uses when the Worker sends them.

/** `GET setup/status` on the hosted app. */
export type HostedStatus = HostedSetupStatus;

/** A repo in `GET setup/repos`; `adoptable` says it already holds a Hippocampus vault. */
export type HostedRepoView = HostedRepo & { adoptable?: boolean };

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
