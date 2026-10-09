import { useResource } from "./cache.ts";
import type { SessionInfo } from "./types.ts";

export function useSession() {
  return useResource<SessionInfo>("/session");
}
