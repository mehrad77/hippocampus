import { HttpError, json, type HostedDeviceRequest, type HostedVault } from "@hippocampus/dashboard";
import { mcpServerName } from "@hippocampus/dashboard/connect";
import { DEVICE_ACCESS, DEVICE_GRANT, DEVICE_INTERVAL_S, DEVICE_TTL_MS, DEVICE_VERIFY_PAGE, DeviceRequests, USER_CODE, deviceStart, type DeviceAccess } from "./device.ts";
import { hostedVault } from "./onboarding.ts";
import { agentId, keyRequest, type MemberVault, type Registry } from "./registry.ts";
import type { Caller } from "./routes.ts";
import type { HostedSettings } from "./settings.ts";

// Device sign-in's routes (device.ts has the flow): the agent's two, which need no session, and the
// dashboard's, where the signed-in person sees and answers a request. RFC 8628's names and error codes.

export interface DeviceRouteDeps {
  db: DeviceRequests;
  registry: Registry;
  settings: HostedSettings;
  /** Seat a new agent in a vault's party (the person ticked "add it to your agents"). */
  seatAgent?: (vault: MemberVault, agent: { id: string; title: string }, via: string) => Promise<void>;
}

/** A form (RFC 8628's encoding) or a JSON body, as a flat record. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(await request.text()));
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Send JSON or a form.", "INVALID");
  }
}

const oauthError = (error: string, description: string, status = 400) => json(status, { error, error_description: description }, { "cache-control": "no-store" });

/** Who may approve what: members connect agents; only an owner hands out the curator's view of secrets. */
const mayApprove = (v: MemberVault, access: DeviceAccess) => v.status === "ready" && (access === "curate" ? v.role === "owner" : v.role === "owner" || v.role === "member");

export function deviceRoutes(deps: DeviceRouteDeps) {
  const { db, registry, settings } = deps;
  const publicUrl = settings.publicUrl;

  return {
    /** `POST /connect/device`: an agent asks to connect. */
    async start(request: Request): Promise<Response> {
      if (request.method !== "POST") return json(405, { error: "Method not allowed" }, { allow: "POST" });
      const input = deviceStart(await readBody(request));
      const { deviceCode, request: r } = await db.create(input);
      const verify = `${publicUrl}${DEVICE_VERIFY_PAGE}`;
      return json(
        200,
        {
          device_code: deviceCode,
          user_code: r.userCode,
          verification_uri: verify,
          verification_uri_complete: `${verify}?code=${r.userCode}`,
          expires_in: DEVICE_TTL_MS / 1000,
          interval: DEVICE_INTERVAL_S,
        },
        { "cache-control": "no-store" },
      );
    },

    /** `POST /connect/token`: the agent polls; once approved, it gets a key for one vault, minted now. */
    async token(request: Request): Promise<Response> {
      if (request.method !== "POST") return json(405, { error: "Method not allowed" }, { allow: "POST" });
      const body = await readBody(request);
      if (body.grant_type !== DEVICE_GRANT) return oauthError("unsupported_grant_type", `grant_type must be ${DEVICE_GRANT}`);
      if (typeof body.device_code !== "string" || !body.device_code) return oauthError("invalid_request", "device_code is required");
      const polled = await db.poll(body.device_code);
      if ("error" in polled) {
        const words = { authorization_pending: "Waiting for the person to approve.", slow_down: `Poll every ${DEVICE_INTERVAL_S} seconds.`, expired_token: "This request expired, or its key was collected already. Start again." };
        return oauthError(polled.error, words[polled.error]);
      }
      const r = polled.request;
      if (r.status === "denied") return oauthError("access_denied", "The person said no.");
      // Still theirs to give, now that the key is made: the approver must still be in the vault, with the role it takes.
      const approver = r.approvedBy ? await registry.accountByUser(r.approvedBy) : undefined;
      const vault = approver ? (await registry.vaultsOf(approver)).find((v) => v.id === r.vaultId) : undefined;
      const access = r.access ?? "remember";
      if (!approver || approver.status !== "approved" || !vault || !mayApprove(vault, access)) return oauthError("access_denied", "Whoever approved this can no longer connect apps to that vault.");
      const label = r.client.slice(0, 80);
      const req =
        access === "curate"
          ? keyRequest({ kind: "curator", label })
          : keyRequest({ kind: "bound", label, agent: r.agent, scopes: access === "read" ? ["read"] : ["read", "remember", "goal"] });
      const { token, key } = await registry.mintKey(vault.id, req, approver.user);
      const mcpUrl = `${publicUrl}/mcp/${vault.id}`;
      const server = mcpServerName(vault.fullName, access === "curate");
      return json(
        200,
        {
          access_token: token,
          token_type: "Bearer",
          scope: key.scopes.join(" "),
          mcp_url: mcpUrl,
          server_name: server,
          vault: { id: vault.id, full_name: vault.fullName },
          ...(key.agent ? { agent: key.agent } : {}),
          claude_code: `claude mcp add --transport http ${server} ${mcpUrl} --header "Authorization: Bearer ${token}"`,
        },
        { "cache-control": "no-store" },
      );
    },

    /** The dashboard's `connect` section: `GET ?code=`, `POST approve`, `POST deny`. */
    async dashboard(method: string, sub: string, body: unknown, url: URL, caller: Caller): Promise<unknown> {
      const code = String((method === "GET" ? url.searchParams.get("code") : (body as { code?: unknown } | undefined)?.code) ?? "").trim();
      if (!USER_CODE.test(code.toUpperCase().replace(/[^A-Z-]/g, ""))) throw new HttpError(400, "code: the 8 letters the app showed you, like BCDF-GHJK", "INVALID");
      const r = await db.byUserCode(code);
      if (!r || r.status !== "pending") throw new HttpError(410, "This code was used, or it expired. Ask the app to start again.", "CODE_GONE");
      const vaults = caller.vaults.filter((v) => v.status === "ready" && v.role !== "viewer");
      if (sub === "" && method === "GET") {
        const found: HostedDeviceRequest = {
          code: r.userCode,
          client: r.client,
          ...(r.agent ? { agent: r.agent } : {}),
          ...(r.access ? { access: r.access } : {}),
          expires: r.expires,
          vaults: vaults.map((v): HostedVault => hostedVault(v, settings)),
          ...(caller.vault && vaults.some((v) => v.id === caller.vault!.id) ? { current: caller.vault.id } : {}),
        };
        return found;
      }
      if (method !== "POST") throw new HttpError(404, `No such route: ${method} connect/${sub}`, "NOT_FOUND");
      if (sub === "deny") {
        await db.decide(code, { approve: false });
        return { ok: true };
      }
      if (sub !== "approve") throw new HttpError(404, `No such route: ${method} connect/${sub}`, "NOT_FOUND");
      if (caller.account.status !== "approved") throw new HttpError(403, "Your account is waiting for an admin's approval.", "NOT_APPROVED");
      const b = (body ?? {}) as { vault?: unknown; agent?: unknown; access?: unknown; seat?: unknown };
      const access = (DEVICE_ACCESS as readonly unknown[]).includes(b.access) ? (b.access as DeviceAccess) : (r.access ?? "remember");
      const vault = vaults.find((v) => v.id === b.vault);
      if (!vault) throw new HttpError(400, "vault: one of your vaults that's ready", "INVALID");
      if (!mayApprove(vault, access)) throw new HttpError(403, access === "curate" ? "Only the vault's owner can approve a curator." : "You can only read this vault.", "OWNER_ONLY");
      const agent = access === "curate" ? undefined : agentId(b.agent ?? r.agent);
      await db.decide(code, { approve: true, vaultId: vault.id, ...(agent ? { agent } : {}), access, by: caller.account.user });
      if (agent && b.seat === true) await deps.seatAgent?.(vault, { id: agent, title: r.client.slice(0, 80) }, `@${caller.account.login}`).catch(() => undefined);
      return { ok: true, vault: vault.fullName, ...(agent ? { agent } : {}) };
    },
  };
}
