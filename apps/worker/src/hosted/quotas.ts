import { isIntroductionPath, type Change, type VaultStore } from "@hippocampus/core";
import { HttpError } from "@hippocampus/dashboard";
import type { SqlStorageLike } from "@hippocampus/index";
import type { RunStore } from "@hippocampus/curator/relay";
import { onPut } from "./run-store.ts";

// What one hosted vault may hold and do. A vault lives in one Durable Object (128 MB of memory, a
// CPU budget per request), and every pending episode goes through the curator's prompts, so the
// limits keep one busy vault from starving its object or running up its curator's bill.

/** Episodes waiting in the inbox. Sleep empties it; until then `remember` is refused. */
export const MAX_PENDING_EPISODES = 2000;
/** Introductions waiting for the human. */
export const MAX_PENDING_INTRODUCTIONS = 20;
/** Files in the repo (every path, not just notes). */
export const MAX_VAULT_FILES = 20_000;
/** Text a request may load from the vault. */
export const MAX_VAULT_BYTES = 50 * 1024 * 1024;
/** Sleep runs started per UTC day. */
export const MAX_SLEEP_RUNS_PER_DAY = 24;

export interface Quotas {
  pendingEpisodes: number;
  pendingIntroductions: number;
  vaultFiles: number;
  vaultBytes: number;
  sleepRunsPerDay: number;
}

export const QUOTAS: Quotas = {
  pendingEpisodes: MAX_PENDING_EPISODES,
  pendingIntroductions: MAX_PENDING_INTRODUCTIONS,
  vaultFiles: MAX_VAULT_FILES,
  vaultBytes: MAX_VAULT_BYTES,
  sleepRunsPerDay: MAX_SLEEP_RUNS_PER_DAY,
};

const QUOTA_KEYS = Object.keys(QUOTAS) as (keyof Quotas)[];
/** Past this an override is a typo, not a plan. */
const MAX_OVERRIDE = 1_000_000;

/** An admin's overrides of the limits, checked: whole numbers for the limits named, nothing else. `null` or nothing means none. */
export function quotaOverrides(input: unknown): Partial<Quotas> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, `quotas: an object of limits (${QUOTA_KEYS.join(", ")}), or null`, "INVALID");
  const out: Partial<Quotas> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!QUOTA_KEYS.includes(key as keyof Quotas)) throw new HttpError(400, `quotas: unknown limit ${key}; choose from ${QUOTA_KEYS.join(", ")}`, "INVALID");
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_OVERRIDE)
      throw new HttpError(400, `quotas.${key}: a whole number from 0 to ${MAX_OVERRIDE}`, "INVALID");
    out[key as keyof Quotas] = value as number;
  }
  return out;
}

/** Overrides as the registry stored them. Anything that doesn't check out is ignored, so a bad row never breaks a vault's reads. */
export function storedQuotas(raw: string | null | undefined): Partial<Quotas> | undefined {
  if (!raw) return undefined;
  try {
    const out = quotaOverrides(JSON.parse(raw));
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Counts per kind for the current UTC day, in the vault's own SQLite. Only today's rows are kept. */
export class DailyCounter {
  constructor(
    private readonly sql: SqlStorageLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private ensure(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS quota_day (kind TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (kind, day))").toArray();
  }

  used(kind: string): number {
    this.ensure();
    const [row] = this.sql.exec("SELECT n FROM quota_day WHERE kind = ? AND day = ?", kind, utcDay(this.now())).toArray() as { n: number }[];
    return row?.n ?? 0;
  }

  /** Adds `n` to today's count, unless that would pass `limit`: then nothing is counted and it answers false. */
  take(kind: string, n: number, limit: number): boolean {
    const day = utcDay(this.now());
    const used = this.used(kind);
    if (used + n > limit) return false;
    this.sql.exec("DELETE FROM quota_day WHERE kind = ? AND day <> ?", kind, day).toArray();
    this.sql.exec("INSERT INTO quota_day (kind, day, n) VALUES (?, ?, ?) ON CONFLICT (kind, day) DO UPDATE SET n = n + excluded.n", kind, day, n).toArray();
    return true;
  }
}

export interface InboxCounts {
  episodes: number;
  introductions: number;
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Pending episodes and introductions among `paths`, as `Vault.load` tells them apart. */
export function inboxCounts(paths: Iterable<string>, inbox: string): InboxCounts {
  const out = { episodes: 0, introductions: 0 };
  for (const path of paths) {
    if (!path.startsWith(`${inbox}/`)) continue;
    if (isIntroductionPath(path)) out.introductions++;
    else if (path.endsWith(".md") && !fileName(path).startsWith("_") && fileName(path) !== "README.md") out.episodes++;
  }
  return out;
}

/**
 * Refuses a change set that grows the inbox past its limits. Only growth is refused: a sleep that
 * empties an over-full inbox, or an approval that settles an introduction, always goes through.
 */
export function checkInbox(before: string[], changes: Change[], inbox: string, q: Pick<Quotas, "pendingEpisodes" | "pendingIntroductions">): void {
  const paths = new Set(before);
  for (const c of changes) {
    if ("remove" in c) paths.delete(c.path);
    else paths.add(c.path);
  }
  const was = inboxCounts(before, inbox);
  const now = inboxCounts(paths, inbox);
  if (now.episodes > q.pendingEpisodes && now.episodes > was.episodes)
    throw new HttpError(
      429,
      `The inbox already holds ${was.episodes} memories waiting for sleep (the hosted limit is ${q.pendingEpisodes}). Run sleep to consolidate them, then try again.`,
      "INBOX_FULL",
    );
  if (now.introductions > q.pendingIntroductions && now.introductions > was.introductions)
    throw new HttpError(
      429,
      `${was.introductions} introductions are already waiting for the human (the hosted limit is ${q.pendingIntroductions}). They need approving or dismissing first.`,
      "INTRODUCTIONS_FULL",
    );
}

export const vaultTooLarge = (what: string) =>
  new HttpError(413, `This vault is too large for the hosted app (${what}). Archive old notes or chronicle pages in the repo, or run Hippocampus locally.`, "VAULT_TOO_LARGE");

/** A store that refuses to load a vault past the size limits, and remembers that it did. */
export interface SizeGuarded extends VaultStore {
  /** The refusal, once a read tripped it. */
  readonly tripped?: HttpError;
}

/**
 * `inner` with the vault size checked as it loads: the file count on first use, and the text read
 * so far (each path once) on every read. Git trees carry no sizes, so the text is counted as it
 * arrives rather than up front; a load stops at the limit instead of reading on.
 */
export function sizeGuard(inner: VaultStore, q: Pick<Quotas, "vaultFiles" | "vaultBytes">): SizeGuarded {
  let counted: Promise<void> | undefined;
  let seen = new Map<string, number>();
  let bytes = 0;
  let tripped: HttpError | undefined;
  const trip = (err: HttpError): never => {
    tripped = err;
    throw err;
  };
  const check = () =>
    (counted ??= inner.list().then((paths) => {
      if (paths.length > q.vaultFiles) trip(vaultTooLarge(`${paths.length} files; the limit is ${q.vaultFiles}`));
    }));
  return {
    get tripped() {
      return tripped;
    },
    async list(prefix) {
      await check();
      return inner.list(prefix);
    },
    async read(path) {
      await check();
      const content = await inner.read(path);
      if (content !== undefined && !seen.has(path)) {
        seen.set(path, content.length);
        bytes += content.length;
        if (bytes > q.vaultBytes) trip(vaultTooLarge(`more than ${Math.round(q.vaultBytes / 1024 / 1024)} MB of text`));
      }
      return content;
    },
    write: (path, content) => inner.write(path, content),
    remove: (path) => inner.remove(path),
    apply: inner.apply && ((changes, meta) => inner.apply!(changes, meta)),
    refresh: inner.refresh && (async () => {
      await inner.refresh!();
      // A new head is a new vault to measure.
      counted = undefined;
      seen = new Map();
      bytes = 0;
    }),
  };
}

/** `runs` with each new run counted against the day's limit, so `start` fails before any work. */
export function limitRuns(runs: RunStore, counter: DailyCounter, perDay: number): RunStore {
  return onPut(runs, async (s, next) => {
    if (!(await runs.get()) && !counter.take("sleep_runs", 1, perDay))
      throw new HttpError(429, `This vault has started ${perDay} sleep runs today (UTC), the hosted limit. Try again tomorrow.`, "SLEEP_LIMIT");
    return next(s);
  });
}
