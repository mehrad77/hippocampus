import { clearCache, useResource } from "./cache.ts";
import { AUTH, href } from "./routes.ts";
import type { SessionInfo } from "./types.ts";

export function useSession() {
  return useResource<SessionInfo>("/session");
}

/**
 * Sign out of the hosted app: end the session on the Worker, forget everything cached in this
 * browser (other tabs too), and go to the public welcome page.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch(`${AUTH}/logout`, { method: "POST", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    // Offline: the cookie stays until it expires, but this browser forgets the data either way.
  }
  clearCache({ everywhere: true });
  location.assign(href.page("welcome"));
}
