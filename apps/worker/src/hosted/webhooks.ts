import { json } from "@hippocampus/dashboard";
import { verifyWebhook } from "./github-app.ts";
import type { DisconnectReason, Registry, VaultRecord } from "./registry.ts";

// `POST /github/webhook`: GitHub telling us an installation or repo changed under a vault. Each
// event only flips registry state; nothing here reads or writes vault content.

export const WEBHOOK_PATH = "/github/webhook";
/** GitHub caps payloads at 25 MB; ours are small, and this bounds what an unsigned request can make us hash. */
const MAX_BODY = 5 * 1024 * 1024;

export interface WebhookDeps {
  secret: string;
  registry: Registry;
  /** A vault's row changed (status, name): the Worker tells its Durable Object. */
  onVaultChanged?: (vaultId: string) => void | Promise<void>;
}

interface Payload {
  action?: string;
  installation?: { id?: number };
  repository?: { id?: number; full_name?: string };
  repositories_removed?: { id?: number }[];
  repositories_added?: { id?: number }[];
  sender?: { id?: number };
}

export async function handleWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed", code: "METHOD" }, { allow: "POST" });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json(413, { error: "Payload too large", code: "TOO_LARGE" });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { error: "Payload too large", code: "TOO_LARGE" });
  if (!(await verifyWebhook(deps.secret, raw, request.headers.get("x-hub-signature-256")))) return json(401, { error: "Bad signature", code: "SIGNATURE" });

  const event = request.headers.get("x-github-event") ?? "";
  const delivery = request.headers.get("x-github-delivery") ?? "";
  let payload: Payload;
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    return json(400, { error: "Body is not JSON", code: "INVALID" });
  }
  if (delivery && !(await deps.registry.claimDelivery(delivery))) return json(200, { ok: true, duplicate: true });
  try {
    const changed = await applyWebhook(event, payload, deps.registry);
    for (const id of changed) await deps.onVaultChanged?.(id);
    return json(200, { ok: true, changed: changed.length });
  } catch (err) {
    // Give the delivery back, so GitHub's retry is handled rather than dropped as a duplicate.
    if (delivery) await deps.registry.releaseDelivery(delivery);
    throw err;
  }
}

/** Apply one event to the registry. Returns the vaults whose rows changed. */
export async function applyWebhook(event: string, p: Payload, registry: Registry): Promise<string[]> {
  const changed: string[] = [];
  const set = async (vaults: (VaultRecord | undefined)[], status: "ready" | "disconnected", reason?: DisconnectReason, only?: (v: VaultRecord) => boolean) => {
    for (const v of vaults) {
      if (!v || (only && !only(v))) continue;
      if (v.status === status && v.reason === reason) continue;
      await registry.setVaultStatus(v.id, status, reason);
      changed.push(v.id);
    }
  };
  // Only a disconnect for this reason is undone by its opposite event.
  const disconnectedFor = (reason: DisconnectReason) => (v: VaultRecord) => v.status === "disconnected" && v.reason === reason;
  const installation = p.installation?.id;
  const byInstallation = () => (installation === undefined ? Promise.resolve([]) : registry.vaultsByInstallation(installation));
  const byRepo = async (id: number | undefined) => (id === undefined ? undefined : registry.vaultByRepo(id));

  switch (`${event}.${p.action ?? ""}`) {
    case "installation.deleted":
      await set(await byInstallation(), "disconnected", "uninstalled");
      break;
    case "installation.suspend":
      await set(await byInstallation(), "disconnected", "suspended", (v) => v.status !== "disconnected");
      break;
    case "installation.unsuspend":
      await set(await byInstallation(), "ready", undefined, disconnectedFor("suspended"));
      break;
    case "installation_repositories.removed":
      for (const r of p.repositories_removed ?? []) await set([await byRepo(r.id)], "disconnected", "repo_removed", (v) => v.installationId === installation && v.status !== "disconnected");
      break;
    case "installation_repositories.added":
      for (const r of p.repositories_added ?? []) await set([await byRepo(r.id)], "ready", undefined, (v) => v.installationId === installation && disconnectedFor("repo_removed")(v));
      break;
    case "repository.renamed":
    case "repository.transferred": {
      const v = await byRepo(p.repository?.id);
      const name = p.repository?.full_name;
      if (v && name && v.fullName !== name) {
        await registry.renameVault(v.id, name);
        changed.push(v.id);
      }
      break;
    }
    case "repository.publicized":
      // Memory must never sit in a public repo: stop serving it until it's private again.
      await set([await byRepo(p.repository?.id)], "disconnected", "public");
      break;
    case "repository.privatized":
      await set([await byRepo(p.repository?.id)], "ready", undefined, disconnectedFor("public"));
      break;
    case "repository.deleted":
      await set([await byRepo(p.repository?.id)], "disconnected", "repo_deleted");
      break;
    case "github_app_authorization.revoked":
      // They took back the app's sign-in: end every session they have here.
      if (typeof p.sender?.id === "number") await registry.bumpEpoch(p.sender.id);
      break;
  }
  return changed;
}
