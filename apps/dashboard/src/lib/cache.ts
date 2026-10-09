import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ApiError, getJson } from "./api.ts";
import type { SessionInfo } from "./types.ts";

// A small stale-while-revalidate cache shared by every island on the page. Pages are full loads
// (the CSP rules out client-side routing), so the last response is kept in sessionStorage
// and painted instantly on the next page, then refreshed.
//
// Whose data it is matters: on the hosted app, two accounts can take turns in one browser. Stored
// copies are keyed by a scope (the signed-in user, the vault and the mode) taken from the session,
// so one account's data is never painted for another. A fresh session with a different scope drops
// everything else; signing out wipes the cache and tells other tabs (through localStorage) to wipe theirs.

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
/** sessionStorage: `{ scope, epoch }` for the copies this tab holds. */
const META = "hippo:cache-meta";
/** localStorage: changes on every sign-out, so other tabs know their copies are stale. */
const EPOCH = "hippo:cache-epoch";
export const SESSION_KEY = "/session";

/** Whose data the cache holds: the signed-in user, the vault, and the mode (which changes once a vault is set up). */
export function scopeOf(session: Partial<Pick<SessionInfo, "user" | "vault" | "mode">>): string {
  const v = session.vault;
  return [session.user?.login ?? "", v?.repo ?? v?.dir ?? v?.url ?? v?.kind ?? "", session.mode ?? ""].join("|");
}

/** Where `key` is stored under `scope`. The session is stored unscoped (it says whose it is); nothing else is stored before the scope is known. */
export function storageKey(key: string, scope: string | undefined): string | undefined {
  if (key === SESSION_KEY) return STORAGE + key;
  return scope === undefined ? undefined : `${STORAGE}${scope}#${key}`;
}

interface Meta {
  scope?: string;
  epoch?: string;
}

let meta: Meta | undefined;
/** Bumped whenever cached data is dropped, so responses to requests made before can't land. */
let generation = 0;

function sessionStore(): Storage | undefined {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}

function epochNow(): string | undefined {
  try {
    return localStorage.getItem(EPOCH) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveMeta(): void {
  try {
    sessionStore()?.setItem(META, JSON.stringify(meta ?? {}));
  } catch {
    // Storage off: the in-memory copy is enough.
  }
}

/** Remove stored copies matching `match` (all of them by default). */
function wipeStorage(match: (storageKey: string) => boolean = () => true): void {
  const s = sessionStore();
  if (!s) return;
  try {
    for (let i = s.length - 1; i >= 0; i--) {
      const k = s.key(i);
      if (k?.startsWith(STORAGE) && match(k)) s.removeItem(k);
    }
  } catch {
    // Nothing to clear.
  }
}

/** This tab's scope and epoch. Copies made before another tab signed out are wiped unread. */
function loadMeta(): Meta {
  if (meta) return meta;
  const epoch = epochNow();
  let saved: Meta = {};
  try {
    saved = JSON.parse(sessionStore()?.getItem(META) ?? "{}") as Meta;
  } catch {
    // Unreadable: start over.
  }
  if (saved.epoch === epoch) meta = { scope: saved.scope, epoch };
  else {
    wipeStorage();
    meta = { epoch };
    saveMeta();
  }
  return meta;
}

function notify(key: string): void {
  for (const fn of listeners.get(key) ?? []) fn();
}

function read(key: string): Resource<unknown> {
  let e = entries.get(key);
  if (!e) {
    e = { loading: false };
    const sk = storageKey(key, loadMeta().scope);
    try {
      const saved = sk ? sessionStore()?.getItem(sk) : undefined;
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
  if (!next.loading && next.data !== undefined && next.at) {
    if (key === SESSION_KEY) adoptScope(scopeOf(next.data as SessionInfo));
    const sk = storageKey(key, loadMeta().scope);
    try {
      if (sk) sessionStore()?.setItem(sk, JSON.stringify({ data: next.data, at: next.at }));
    } catch {
      // Quota or disabled storage: the in-memory copy is enough.
    }
  }
  notify(key);
}

/** A fresh session names whose data this is; if that changed, everything else cached belongs to someone (or some vault) else. */
function adoptScope(scope: string): void {
  const m = loadMeta();
  if (m.scope === scope) return;
  const previous = m.scope;
  m.scope = scope;
  saveMeta();
  if (previous !== undefined) forget((k) => k !== SESSION_KEY, true);
}

/** Drop cached keys (memory and storage). With `refetch`, keys on screen are fetched again for the new owner. */
function forget(match: (key: string) => boolean, refetch: boolean): void {
  generation++;
  wipeStorage((sk) => sk !== STORAGE + SESSION_KEY || match(SESSION_KEY));
  for (const key of [...entries.keys()]) {
    if (!match(key)) continue;
    entries.delete(key);
    inflight.delete(key);
    if (!listeners.get(key)?.size) continue;
    if (refetch) void revalidate(key);
    else notify(key);
  }
}

/** Fetch (or refetch) `key`, merging concurrent requests into one. */
export function revalidate(key: string): Promise<void> {
  const running = inflight.get(key);
  if (running) return running;
  const gen = generation;
  const current = read(key);
  write(key, { ...current, loading: true });
  const p: Promise<void> = getJson<unknown>(key)
    .then((data) => {
      if (gen === generation) write(key, { data, at: Date.now(), loading: false });
    })
    .catch((error: unknown) => {
      if (gen !== generation) return;
      const err = error instanceof ApiError ? error : new ApiError(0, error instanceof Error ? error.message : String(error), "NETWORK");
      if (err.status === 401) clearCache();
      write(key, { ...read(key), error: err, loading: false });
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
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

/** The cached state of `key` right now, without fetching. */
export function peek<T>(key: string): Resource<T> {
  return read(key) as Resource<T>;
}

/**
 * Forget everything cached in this tab (memory and storage). `everywhere` (signing out, deleting
 * the account) also tells the browser's other tabs to drop their copies.
 */
export function clearCache(opts: { everywhere?: boolean } = {}): void {
  generation++;
  wipeStorage();
  entries.clear();
  inflight.clear();
  let epoch = epochNow();
  if (opts.everywhere) {
    epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      localStorage.setItem(EPOCH, epoch);
    } catch {
      // Storage off: other tabs find out on their next request.
    }
  }
  meta = { epoch };
  saveMeta();
}

// Another tab signed out: this tab's copies are stale. Refetching what's on screen shows the sign-in door.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== EPOCH) return;
    meta = { epoch: e.newValue ?? undefined };
    saveMeta();
    forget(() => true, true);
  });
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
