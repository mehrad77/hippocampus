import { GitLabApiError, GitLabAuthError, type GitLabAccess } from "./gitlab.ts";
import type { DisconnectReason, Registry, VaultRecord } from "./registry.ts";

// GitLab has no app-level webhooks (no "uninstalled", "made public" or "removed" events), so a
// periodic check does what GitHub's webhooks do: it asks GitLab how each GitLab vault's project
// stands and brings the registry in line. Run from a Cron Trigger.

/** Reasons the check itself set, and so may lift when the project is healthy again. */
const LIFTABLE: DisconnectReason[] = ["token_revoked", "repo_deleted", "public"];

export interface HealthDeps {
  registry: Registry;
  access: GitLabAccess;
  /** A vault's registry row changed: tell its Durable Object. */
  onVaultChanged?: (vaultId: string) => void | Promise<void>;
}

type Verdict = { ok: true; fullName: string } | { ok: false; reason: DisconnectReason } | { unknown: true };

async function verdict(v: VaultRecord, { access }: HealthDeps): Promise<Verdict> {
  try {
    const token = await access.tokenFor(v.accountId)();
    const project = await access.client.project(token, v.repoId);
    // `internal` shows the project to every signed-in user of the instance: as bad as public here.
    if (project.visibility !== "private") return { ok: false, reason: "public" };
    return { ok: true, fullName: project.fullName };
  } catch (err) {
    if (err instanceof GitLabAuthError) return { ok: false, reason: "token_revoked" };
    if (err instanceof GitLabApiError && err.status === 404) return { ok: false, reason: "repo_deleted" };
    // GitLab being down says nothing about the project.
    return { unknown: true };
  }
}

/** Check every GitLab vault once. Returns the vaults whose standing changed. */
export async function checkGitLabVaults(deps: HealthDeps): Promise<string[]> {
  const changed: string[] = [];
  for (const v of await deps.registry.gitlabVaults()) {
    const r = await verdict(v, deps);
    if ("unknown" in r) continue;
    let touched = false;
    if (!r.ok) {
      if (v.status === "ready" || (v.status === "disconnected" && v.reason !== r.reason && LIFTABLE.includes(v.reason as DisconnectReason))) {
        await deps.registry.setVaultStatus(v.id, "disconnected", r.reason);
        touched = true;
      }
    } else {
      if (v.fullName !== r.fullName) {
        await deps.registry.renameVault(v.id, r.fullName);
        touched = true;
      }
      if (v.status === "disconnected" && LIFTABLE.includes(v.reason as DisconnectReason)) {
        await deps.registry.setVaultStatus(v.id, "ready");
        touched = true;
      }
    }
    if (touched) {
      changed.push(v.id);
      await deps.onVaultChanged?.(v.id);
    }
  }
  return changed;
}
