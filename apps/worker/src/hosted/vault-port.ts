import type { VaultRecord } from "./registry.ts";
import type { DashboardUser, VaultGrant, VaultMeta } from "./vault-runtime.ts";

// The Worker's side of each vault's Durable Object (`VaultHost` in vault-host.ts): the RPC methods
// it calls, typed structurally so the Worker's routing and its tests stay free of Workers-only
// modules. worker.ts hands the real namespace in, so the compiler holds these to the class.

export type { DashboardUser, VaultGrant, VaultMeta };

export interface PartyMember {
  id: string;
  title: string;
}

export interface VaultStub {
  /** Tell the vault where it lives. Idempotent. */
  configure(meta: VaultMeta): Promise<void>;
  mcp(request: Request, grant: VaultGrant): Promise<Response>;
  dashboard(request: Request, user: DashboardUser): Promise<Response>;
  party(): Promise<PartyMember[]>;
  /** `via` is who asked, like `@player`, for the commit. */
  addParty(input: { id: string; title: string; lane?: string; authority?: string[] }, via: string): Promise<{ slug: string }>;
  disconnect(reason: string): Promise<void>;
  /** Wipe the vault's Durable Object (account deletion). The repo stays. */
  destroy(): Promise<void>;
}

/** One Durable Object per vault, named by the vault's id. */
export interface VaultHosts {
  get(vaultId: string): VaultStub;
}

export const vaultMeta = (v: Pick<VaultRecord, "id" | "fullName" | "branch" | "repoId" | "installationId">): VaultMeta => ({
  vaultId: v.id,
  fullName: v.fullName,
  branch: v.branch,
  repoId: v.repoId,
  installationId: v.installationId,
});
