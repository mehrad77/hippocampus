import { API } from "./routes.ts";

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

async function handle<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`, body.code ?? "ERROR");
  return body as T;
}

export async function getJson<T>(path: string): Promise<T> {
  return handle<T>(await fetch(`${API}${path}`, { headers: { accept: "application/json" }, credentials: "same-origin" }));
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(
    await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    }),
  );
}
