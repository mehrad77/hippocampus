import { useEffect } from "react";
import { useResource } from "../lib/cache.ts";
import { useSession } from "../lib/session.ts";
import type { Overview } from "../lib/types.ts";

/** Keeps the nav's badges and campaign name current (the nav itself is static HTML). */
export function NavStatus() {
  const session = useSession();
  const ready = !!session.data && session.data.mode !== "setup";
  const overview = useResource<Overview>(ready ? "/overview" : null, { poll: 60_000 });
  useEffect(() => {
    const o = overview.data;
    const set = (key: string, n: number | undefined) => {
      for (const el of document.querySelectorAll<HTMLElement>(`[data-badge="${key}"]`)) {
        el.textContent = n ? String(n) : "";
        el.hidden = !n;
        el.title = n ? `${n} waiting` : "";
      }
    };
    set("council", o?.counts.disputes);
    set("satchel", o?.counts.inbox);
  }, [overview.data]);
  // The admin link is static and hidden; only admins of the hosted app see it.
  const admin = !!session.data?.account?.admin;
  useEffect(() => {
    if (!admin) return;
    for (const el of document.querySelectorAll<HTMLElement>("[data-admin-link]")) el.hidden = false;
  }, [admin]);
  useEffect(() => {
    const name = session.data?.campaign;
    if (!name) return;
    for (const el of document.querySelectorAll<HTMLElement>("[data-campaign]")) el.textContent = name;
  }, [session.data?.campaign]);
  return null;
}
