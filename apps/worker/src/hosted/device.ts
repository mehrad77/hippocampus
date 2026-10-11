import { HttpError } from "@hippocampus/dashboard";
import type { SqlDriver } from "@hippocampus/index";
import { base64url } from "../github-login.ts";
import { hashToken } from "../auth.ts";
import { agentId } from "./registry.ts";

// An agent connecting on a person's behalf, the way command-line apps sign in (the shapes of the OAuth
// device grant, RFC 8628, issuing a vault key rather than an OAuth token):
//
//   agent   POST /connect/device { client_name, agent?, access? }  → device_code, user_code, verification_uri…
//   person  opens verification_uri_complete, signed in, and approves: which vault, which agent, what it may do
//   agent   POST /connect/token { grant_type, device_code } every `interval` seconds
//           → authorization_pending | slow_down | access_denied | expired_token, or the key and the vault's address
//
// The key is minted when the agent collects it and never stored; the request expires after ten minutes.
// Schema: migrations/0006_device_connect.sql.

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_PATH = "/connect/device";
export const DEVICE_TOKEN_PATH = "/connect/token";
/** The dashboard page where the person approves (`?code=` fills it in). */
export const DEVICE_VERIFY_PAGE = "/dashboard/connect/";
const TTL_MS = 10 * 60_000;
const INTERVAL_S = 5;
/** RFC 8628 §6.1: no vowels, so codes don't spell words; no look-alikes. */
const CODE_CHARS = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

/** What a connection may do; `curate` makes a curator key, which only a vault's owner can approve. */
export const DEVICE_ACCESS = ["remember", "read", "curate"] as const;
export type DeviceAccess = (typeof DEVICE_ACCESS)[number];

export interface DeviceRequest {
  id: string;
  userCode: string;
  /** The app's name, as it gave it (not verified). */
  client: string;
  /** The agent id it asked for, if any. */
  agent?: string;
  access?: DeviceAccess;
  status: "pending" | "approved" | "denied";
  vaultId?: string;
  approvedBy?: string;
  created: string;
  expires: string;
  polled?: string;
}

interface Row {
  id: string;
  user_code: string;
  client: string;
  agent: string | null;
  access: DeviceAccess | null;
  status: DeviceRequest["status"];
  vault_id: string | null;
  approved_by: string | null;
  created: string;
  expires: string;
  polled: string | null;
}

const toRequest = (r: Row): DeviceRequest => ({
  id: r.id,
  userCode: r.user_code,
  client: r.client,
  ...(r.agent ? { agent: r.agent } : {}),
  ...(r.access ? { access: r.access } : {}),
  status: r.status,
  ...(r.vault_id ? { vaultId: r.vault_id } : {}),
  ...(r.approved_by ? { approvedBy: r.approved_by } : {}),
  created: r.created,
  expires: r.expires,
  ...(r.polled ? { polled: r.polled } : {}),
});

/** `ABCD-EFGH` from any spelling the person typed (case, spaces, dash). */
export const normalizeUserCode = (raw: string) => {
  const c = raw.toUpperCase().replace(/[^A-Z]/g, "");
  return `${c.slice(0, 4)}-${c.slice(4, 8)}`;
};

export class DeviceRequests {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private stamp(offset = 0) {
    return new Date(this.now().getTime() + offset).toISOString();
  }

  /** A new request: the device code (the agent's secret, stored hashed) and the code the person types. */
  async create(input: { client: string; agent?: string; access?: DeviceAccess }): Promise<{ deviceCode: string; request: DeviceRequest }> {
    await this.db.all("DELETE FROM device_requests WHERE expires < ?", [this.stamp()]);
    const deviceCode = `hdev_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const id = await hashToken(deviceCode);
    for (let attempt = 0; attempt < 5; attempt++) {
      const pick = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
      const userCode = `${pick.slice(0, 4)}-${pick.slice(4)}`;
      try {
        const [row] = await this.db.all<Row>(
          "INSERT INTO device_requests (id, user_code, client, agent, access, status, created, expires) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING *",
          [id, userCode, input.client, input.agent ?? null, input.access ?? null, this.stamp(), this.stamp(TTL_MS)],
        );
        return { deviceCode, request: toRequest(row!) };
      } catch (err) {
        if (!/UNIQUE/i.test(String(err))) throw err;
      }
    }
    throw new HttpError(503, "Couldn't make a code; try again.", "BUSY");
  }

  /** An open request by the code the person typed. */
  async byUserCode(code: string): Promise<DeviceRequest | undefined> {
    const [row] = await this.db.all<Row>("SELECT * FROM device_requests WHERE user_code = ? AND expires > ?", [normalizeUserCode(code), this.stamp()]);
    return row && toRequest(row);
  }

  /** The person's answer, once, while the request is open. */
  async decide(code: string, decision: { approve: true; vaultId: string; agent?: string; access: DeviceAccess; by: string } | { approve: false }): Promise<DeviceRequest> {
    const at = this.stamp();
    const [row] = decision.approve
      ? await this.db.all<Row>(
          "UPDATE device_requests SET status = 'approved', vault_id = ?, agent = ?, access = ?, approved_by = ? WHERE user_code = ? AND status = 'pending' AND expires > ? RETURNING *",
          [decision.vaultId, decision.agent ?? null, decision.access, decision.by, normalizeUserCode(code), at],
        )
      : await this.db.all<Row>("UPDATE device_requests SET status = 'denied' WHERE user_code = ? AND status = 'pending' AND expires > ? RETURNING *", [normalizeUserCode(code), at]);
    if (!row) throw new HttpError(410, "This code was used, or it expired. Ask the app to start again.", "CODE_GONE");
    return toRequest(row);
  }

  /**
   * The agent's poll. Returns the request when it's been decided (and forgets it: a device code works
   * once), or the RFC 8628 error to answer with.
   */
  async poll(deviceCode: string): Promise<{ request: DeviceRequest } | { error: "authorization_pending" | "slow_down" | "expired_token" }> {
    const id = await hashToken(deviceCode);
    const [row] = await this.db.all<Row>("SELECT * FROM device_requests WHERE id = ?", [id]);
    if (!row || row.expires < this.stamp()) return { error: "expired_token" };
    if (row.status === "pending") {
      const tooSoon = row.polled && Date.parse(row.polled) > this.now().getTime() - (INTERVAL_S - 1) * 1000;
      await this.db.all("UPDATE device_requests SET polled = ? WHERE id = ?", [this.stamp(), id]);
      return { error: tooSoon ? "slow_down" : "authorization_pending" };
    }
    // Taken once: a second poll with the same code finds nothing.
    const [taken] = await this.db.all<Row>("DELETE FROM device_requests WHERE id = ? RETURNING *", [id]);
    return taken ? { request: toRequest(taken) } : { error: "expired_token" };
  }
}

/** `{ client_name, agent?, access? }` (JSON or a form), checked. */
export function deviceStart(body: Record<string, unknown>): { client: string; agent?: string; access?: DeviceAccess } {
  const client = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 80) : "";
  if (!client) throw new HttpError(400, "client_name: the app's name, so the person knows what they approve", "INVALID");
  const agent = body.agent === undefined || body.agent === "" ? undefined : agentId(body.agent);
  const access = body.access === undefined || body.access === "" ? undefined : (DEVICE_ACCESS as readonly unknown[]).includes(body.access) ? (body.access as DeviceAccess) : undefined;
  if (body.access !== undefined && body.access !== "" && !access) throw new HttpError(400, `access: one of ${DEVICE_ACCESS.join(", ")}`, "INVALID");
  return { client, ...(agent ? { agent } : {}), ...(access ? { access } : {}) };
}

export { INTERVAL_S as DEVICE_INTERVAL_S, TTL_MS as DEVICE_TTL_MS };
