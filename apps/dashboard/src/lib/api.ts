import { API } from "./routes.ts";
import { forgetVault, vaultHeaders } from "./vault.ts";

/** An API failure with the server's stable `code` (e.g. NO_VAULT, LOCAL_TOKEN, CONFLICT). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response, picked: boolean): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    // The tab's vault is gone (removed, or no longer shared): fall back to the server's choice.
    if (picked && res.status === 404 && body.code === "NO_VAULT") {
      forgetVault();
      location.reload();
    }
    throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`, body.code ?? "ERROR");
  }
  return body as T;
}

export async function getJson<T>(path: string): Promise<T> {
  const vault = vaultHeaders();
  return handle<T>(await fetch(`${API}${path}`, { headers: { accept: "application/json", ...vault }, credentials: "same-origin" }), Object.keys(vault).length > 0);
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const vault = vaultHeaders();
  return handle<T>(
    await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...vault },
      credentials: "same-origin",
      body: JSON.stringify(body),
    }),
    Object.keys(vault).length > 0,
  );
}
