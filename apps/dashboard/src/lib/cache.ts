import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ApiError, getJson } from "./api.ts";

// A small stale-while-revalidate cache shared by every island on the page. Pages are full loads
// (the CSP rules out client-side routing), so the last response is kept in sessionStorage
// and painted instantly on the next page, then refreshed.

export interface Resource<T> {
  data?: T;
  error?: ApiError;
  loading: boolean;
  /** When `data` was fetched (ms). */
  at?: number;
}

type Listener = () => void;

const entries = new Map<string, Resource<unknown>>();
const listeners = new Map<string, Set<Listener>>();
const inflight = new Map<string, Promise<void>>();
const STORAGE = "hippo:cache:";

function read(key: string): Resource<unknown> {
  let e = entries.get(key);
  if (!e) {
    e = { loading: false };
    try {
      const saved = sessionStorage.getItem(STORAGE + key);
      if (saved) {
        const { data, at } = JSON.parse(saved) as { data: unknown; at: number };
        e = { data, at, loading: false };
      }
    } catch {
      // Private mode or storage disabled: just fetch.
    }
    entries.set(key, e);
  }
  return e;
}

function write(key: string, next: Resource<unknown>): void {
  entries.set(key, next);
  if (next.data !== undefined && next.at) {
    try {
      sessionStorage.setItem(STORAGE + key, JSON.stringify({ data: next.data, at: next.at }));
    } catch {
      // Quota or disabled storage: the in-memory copy is enough.
    }
  }
  for (const fn of listeners.get(key) ?? []) fn();
}

/** Fetch (or refetch) `key`, merging concurrent requests into one. */
export function revalidate(key: string): Promise<void> {
  const running = inflight.get(key);
  if (running) return running;
  const current = read(key);
  write(key, { ...current, loading: true });
  const p = getJson<unknown>(key)
    .then((data) => write(key, { data, at: Date.now(), loading: false }))
    .catch((error: unknown) => {
      const err = error instanceof ApiError ? error : new ApiError(0, error instanceof Error ? error.message : String(error), "NETWORK");
      if (err.status === 401) clearCache();
      write(key, { ...read(key), error: err, loading: false });
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Refetch every cached key that matches (all of them by default); call after an action. */
export function invalidate(match: (key: string) => boolean = () => true): Promise<void[]> {
  return Promise.all([...entries.keys()].filter(match).map((k) => revalidate(k)));
}

/** Optimistic local edit; pair with `invalidate` to settle on the server's answer. */
export function patch<T>(key: string, fn: (data: T) => T): void {
  const e = read(key) as Resource<T>;
  if (e.data !== undefined) write(key, { ...e, data: fn(e.data) });
}

export function clearCache(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(STORAGE)) sessionStorage.removeItem(k);
    }
  } catch {
    // Nothing to clear.
  }
}

/**
 * Read `key` (an API path like `/overview`) through the cache. Revalidates on mount, when the tab
 * becomes visible again, and every `poll` ms while visible. `null` skips fetching.
 */
export function useResource<T>(key: string | null, opts: { poll?: number } = {}): Resource<T> & { reload: () => Promise<void> } {
  const subscribe = useCallback(
    (fn: Listener) => {
      if (!key) return () => {};
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(fn);
      return () => listeners.get(key)?.delete(fn);
    },
    [key],
  );
  const snapshot = useCallback(() => (key ? read(key) : EMPTY), [key]);
  const state = useSyncExternalStore(subscribe, snapshot, () => EMPTY) as Resource<T>;

  useEffect(() => {
    if (!key) return;
    void revalidate(key);
    const onVisible = () => {
      if (document.visibilityState === "visible") void revalidate(key);
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = opts.poll
      ? window.setInterval(() => {
          if (document.visibilityState === "visible") void revalidate(key);
        }, opts.poll)
      : undefined;
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) window.clearInterval(timer);
    };
  }, [key, opts.poll]);

  const reload = useCallback(() => (key ? revalidate(key) : Promise.resolve()), [key]);
  return { ...state, loading: state.loading || (!!key && state.data === undefined && !state.error), reload };
}

const EMPTY: Resource<unknown> = { loading: false };
