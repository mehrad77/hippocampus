import { VaultError, type Failures, type Vault } from "@hippocampus/core";
import {
  HOSTED_CURATOR,
  RunBusyError,
  SET_ASIDE_AFTER,
  hostedLLM,
  mixLabel,
  priceOf,
  standbyVerdict,
  waitingWork,
  STEPS,
  type GateVerdict,
  type HostedProvider,
  type LLM,
  type Meter,
  type RunCost,
  type RunStore,
  type RunSummary,
  type SleepGate,
  type SleepRelay,
  type StepMix,
} from "@hippocampus/curator";
import { HttpError, type HostedVaultCurator } from "@hippocampus/dashboard";
import type { SqlDriver, SqlStorageLike } from "@hippocampus/index";
import { nextNight, type AlarmBook } from "./alarms.ts";
import { logEvent } from "./limits.ts";
import type { LlmAccess, LlmSettings } from "./llm-access.ts";
import { AccountMeter, monthSpend, type RunLedger } from "./llm-spend.ts";

// Hippocampus running a vault's nightly sleep itself, with its owner's model key: in the vault's
// Durable Object, driven by its alarm one slice at a time. Also the standby gate, which tells an
// agent curator when it isn't needed, and the line every agent's `onboard` gets about who curates.
// What it keeps in the object's SQLite is ids, numbers, names and times: never memory content.

/** What the Durable Object needs from the Worker for hosted curation. Absent when the instance has no `HIPPO_TOKEN_KEY`. */
export interface HostedCuratorDeps {
  access: LlmAccess;
  /** The registry, where the account's budget is kept. */
  db: SqlDriver;
  /** The account that owns the vault (`vaults.account_id`). */
  accountOf(vaultId: string): Promise<number | undefined>;
  /** The operator's kill switch (`HIPPO_HOSTED_CURATOR=off`). */
  off?: boolean;
  /** A local fake provider, on a loopback Worker only (settings.ts). */
  urls?: Partial<Record<HostedProvider, string>>;
  /** The model; tests swap it for a scripted one. */
  answerer?: (o: { provider: HostedProvider; key: string; mix: StepMix; meter: Meter; baseURL?: string }) => LLM;
}

/**
 * A slice of a hosted run ends at whichever comes first. An alarm handler gets 15 minutes of wall
 * time (the model's response time counts) and 30 s of CPU by default; the relay reloads the vault
 * for every unit, so on a large vault CPU runs out first. CPU per unit isn't measured yet (it can't
 * be in Node tests): the unit count is provisional until the smoke test measures it under wrangler.
 * Workers Free also allows only 50 external subrequests per invocation, about one unit.
 */
export const SLICE_MS = 5 * 60_000;
export const SLICE_UNITS = 3;
/** The next slice, soon after this one: a fresh invocation, with fresh limits. */
const NEXT_SLICE_MS = 1000;
/** After an unexpected failure, the next try. The relay expires a hosted run left for 6 hours. */
const RETRY_SLICE_MS = 60_000;
/** An agent's run is open: try the night again in a while. */
export const BUSY_RETRY_MS = 30 * 60_000;
const KEEP_CHECKINS = 20;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS hosted_ledger (run TEXT PRIMARY KEY, micros INTEGER NOT NULL DEFAULT 0, unit_micros INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS hosted_too_large (episode TEXT PRIMARY KEY, cap_micros INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS hosted_schedule (id INTEGER PRIMARY KEY CHECK (id = 1), hour_utc INTEGER)",
  "CREATE TABLE IF NOT EXISTS standby_checkins (seq INTEGER PRIMARY KEY AUTOINCREMENT, curator TEXT NOT NULL, at TEXT NOT NULL, decision TEXT NOT NULL)",
];

/** Why hosted curation can't run now; nothing when it can. */
export type Unhealthy = "unavailable" | "off" | "unscheduled" | "no_account" | "no_key" | "paused" | "budget";

interface Health {
  schedule?: { hourUtc: number };
  accountId?: number;
  settings?: LlmSettings;
  /** Why it can't run; undefined when it can. */
  why?: Unhealthy;
}

/** What starting a hosted run came to: its id, or why not, as a code. */
export type StartResult = { run: string } | { code: string; message: string };

const WHY: Record<Unhealthy, string> = {
  unavailable: "this Hippocampus doesn't offer it",
  off: "the operator has switched it off",
  unscheduled: "it isn't on for this vault",
  no_account: "the vault's account wasn't found",
  no_key: "no model key is saved",
  paused: "it is paused",
  // A refused reservation is the next call's worst case not fitting, so a little may be left unspent.
  budget: "the monthly budget is spent, or what's left can't cover another memory",
};

const PAUSE_WORDS: Record<string, string> = { auth: "the model key was refused", credit: "the model provider's credit ran out" };

const hour = (h: number) => `${String(h).padStart(2, "0")}:00 UTC`;

export interface HostedCuratorOptions {
  sql: SqlStorageLike;
  vaultId: string;
  clock: () => Date;
  relay: SleepRelay;
  runs: RunStore;
  alarms: AlarmBook;
  /** A fresh vault at head, and its failures: for what waits. Throws while the vault needs an upgrade. */
  open(): Promise<{ vault: Vault; failures: Failures }>;
  /** Episode files waiting in the inbox, counted from a path listing (no reads). */
  inboxCount(): Promise<number>;
  log?: (line: string) => void;
  deps?: HostedCuratorDeps;
}

export class HostedCurator {
  private readonly sql: SqlStorageLike;

  constructor(private readonly o: HostedCuratorOptions) {
    this.sql = o.sql;
    for (const s of SCHEMA) this.sql.exec(s).toArray();
  }

  private rows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as T[];
  }

  private now(): Date {
    return this.o.clock();
  }

  // ── The run's ledger (what it spent, against its own cap) ─────────────────────

  ledger(run: string): RunLedger & { resetUnit(): void } {
    this.rows("INSERT INTO hosted_ledger (run) VALUES (?) ON CONFLICT (run) DO NOTHING", run);
    return {
      get: () => {
        const [r] = this.rows<{ micros: number; unit_micros: number; calls: number }>("SELECT micros, unit_micros, calls FROM hosted_ledger WHERE run = ?", run);
        return { micros: r?.micros ?? 0, unitMicros: r?.unit_micros ?? 0, calls: r?.calls ?? 0 };
      },
      add: (micros) => void this.rows("UPDATE hosted_ledger SET micros = micros + ?, unit_micros = unit_micros + ?, calls = calls + 1 WHERE run = ?", micros, micros, run),
      resetUnit: () => void this.rows("UPDATE hosted_ledger SET unit_micros = 0 WHERE run = ?", run),
    };
  }

  /** For the relay, when a hosted run closes. */
  readonly spent = async (run: string): Promise<RunCost | undefined> => {
    const [r] = this.rows<{ micros: number; calls: number }>("SELECT micros, calls FROM hosted_ledger WHERE run = ?", run);
    return r ? { micros: r.micros, calls: r.calls } : undefined;
  };

  // ── State ───────────────────────────────────────────────────────────────────

  /** The vault's nightly hour as last read from the registry. */
  cachedHour(): number | undefined {
    const [r] = this.rows<{ hour_utc: number | null }>("SELECT hour_utc FROM hosted_schedule WHERE id = 1");
    return r?.hour_utc ?? undefined;
  }

  private cacheHour(h: number | undefined): void {
    this.rows("INSERT INTO hosted_schedule (id, hour_utc) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET hour_utc = excluded.hour_utc", h ?? null);
  }

  /** Whether hosted curation can run for this vault now, read from the registry. Refreshes the cached hour. */
  async health(at = this.now()): Promise<Health> {
    const d = this.o.deps;
    if (!d) return { why: "unavailable" };
    const schedule = await d.access.schedule(this.o.vaultId);
    this.cacheHour(schedule?.hourUtc);
    const base = schedule ? { schedule } : {};
    if (d.off) return { ...base, why: "off" };
    const accountId = await d.accountOf(this.o.vaultId);
    if (accountId === undefined) return { ...base, why: "no_account" };
    const settings = await d.access.settings(accountId);
    if (!settings) return { ...base, accountId, why: "no_key" };
    const known = { ...base, accountId, settings };
    if (settings.paused) return { ...known, why: settings.paused.startsWith("budget:") ? "budget" : "paused" };
    if ((await monthSpend(d.db, accountId, at)) >= settings.monthCapMicros) return { ...known, why: "budget" };
    return schedule ? known : { ...known, why: "unscheduled" };
  }

  private async lastHosted(): Promise<RunSummary | undefined> {
    return (await this.o.runs.history()).find((h) => h.curator === HOSTED_CURATOR);
  }

  private nextRunIso(): string | undefined {
    const at = this.o.alarms.get("night");
    return at === undefined ? undefined : new Date(at).toISOString();
  }

  // ── The standby gate ─────────────────────────────────────────────────────────

  /**
   * An agent curator's run is needed unless hosted curation is on and healthy for this vault; then only
   * when a memory has waited too long. Each check-in on a vault with hosted curation is recorded.
   */
  readonly gate: SleepGate = async ({ now, vault, failures, curator }) => {
    let h: Health | undefined;
    try {
      h = await this.health(now);
    } catch {
      // The registry can't be read: the agent runs, as it would without hosted curation.
      return { needed: true };
    }
    if (!h.schedule) return { needed: true };
    const last = await this.lastHosted();
    const next = this.nextRunIso();
    const verdict: GateVerdict = standbyVerdict(
      { healthy: !h.why, ...(last ? { lastRun: last.ended } : {}), ...(next ? { nextRun: next } : {}) },
      waitingWork(vault, failures),
      now,
    );
    this.rows("INSERT INTO standby_checkins (curator, at, decision) VALUES (?, ?, ?)", curator, now.toISOString(), verdict.needed ? "needed" : verdict.reason);
    this.rows("DELETE FROM standby_checkins WHERE seq NOT IN (SELECT seq FROM standby_checkins ORDER BY seq DESC LIMIT ?)", KEEP_CHECKINS);
    return verdict;
  };

  lastCheckin(): HostedVaultCurator["standby"] {
    const [r] = this.rows<{ curator: string; at: string; decision: "needed" | "hosted" | "idle" }>("SELECT curator, at, decision FROM standby_checkins ORDER BY seq DESC LIMIT 1");
    return r ? { curator: r.curator, at: r.at, decision: r.decision } : undefined;
  }

  // ── Status, for the dashboard and every agent's onboard ──────────────────────

  async status(): Promise<HostedVaultCurator> {
    const h = this.o.deps ? await this.o.deps.access.schedule(this.o.vaultId) : undefined;
    this.cacheHour(h?.hourUtc);
    const last = await this.lastHosted();
    const standby = this.lastCheckin();
    const open = await this.o.runs.get();
    const next = h ? this.nextRunIso() : undefined;
    return {
      enabled: !!h,
      ...(h ? { hourUtc: h.hourUtc } : {}),
      ...(next ? { nextRun: next } : {}),
      ...(open?.hosted ? { running: true } : {}),
      ...(last
        ? {
            lastRun: {
              id: last.id,
              ended: last.ended,
              outcome: last.outcome,
              ...(last.stop ? { stop: last.stop } : {}),
              consolidated: last.consolidated,
              ...(last.cost ? { costUsd: last.cost.micros / 1e6 } : {}),
            },
          }
        : {}),
      ...(standby ? { standby } : {}),
    };
  }

  /** One plain line about who curates, for every connection's `onboard`. No model calls, no memory content. */
  async curationState(): Promise<string | undefined> {
    // Known to be off (the owner's last change, or the last read, said so): no registry reads on every onboard.
    const [cached] = this.rows<{ hour_utc: number | null }>("SELECT hour_utc FROM hosted_schedule WHERE id = 1");
    const h: Health = cached && cached.hour_utc === null ? {} : await this.health();
    const history = await this.o.runs.history();
    const date = (iso: string) => iso.slice(0, 10);
    if (h.schedule) {
      const last = history.find((r) => r.curator === HOSTED_CURATOR);
      const lastRun = last ? ` (last run ${date(last.ended)})` : "";
      if (!h.why) return `Nightly curation: Hippocampus runs it at ${hour(h.schedule.hourUtc)}${lastRun}.`;
      const why = h.why === "paused" ? (PAUSE_WORDS[h.settings?.paused ?? ""] ?? WHY.paused) : WHY[h.why];
      const standby = this.lastCheckin();
      const who = standby ? `the standby curator ${standby.curator} will run` : "a standby curator will run if one is set up";
      return `Nightly curation: Hippocampus runs it at ${hour(h.schedule.hourUtc)}${lastRun}, but it is paused: ${why}; ${who}.`;
    }
    const agent = history.find((r) => r.curator !== HOSTED_CURATOR);
    if (agent) return `Nightly curation: the curator ${agent.curator} runs it (last run ${date(agent.ended)}).`;
    const waiting = await this.o.inboxCount().catch(() => undefined);
    if (waiting === undefined) return "No curator yet.";
    return `No curator yet: ${waiting} ${waiting === 1 ? "memory" : "memories"} waiting.`;
  }

  // ── The schedule and the alarm ───────────────────────────────────────────────

  /** The owner set (or, with null, cleared) the vault's hour in the registry: cache it and re-arm. */
  async setSchedule(hourUtc: number | null): Promise<HostedVaultCurator> {
    this.cacheHour(hourUtc ?? undefined);
    await this.o.alarms.set("night", hourUtc === null ? undefined : nextNight(hourUtc, this.now()));
    return this.status();
  }

  /** The Cron's backstop: the night (and an open hosted run's next slice) on the books, and an alarm for them. */
  async ensureAlarm(): Promise<boolean> {
    const schedule = this.o.deps ? await this.o.deps.access.schedule(this.o.vaultId) : undefined;
    this.cacheHour(schedule?.hourUtc);
    if (!schedule) this.o.alarms.put("night", undefined);
    else if (this.o.alarms.get("night") === undefined) this.o.alarms.put("night", nextNight(schedule.hourUtc, this.now()));
    if ((await this.o.runs.get())?.hosted && this.o.alarms.get("slice") === undefined) this.o.alarms.put("slice", this.now().getTime());
    return this.o.alarms.ensure();
  }

  /** The alarm went off: a due night starts a run, and an open hosted run gets its next slice. */
  async tick(due: ReadonlySet<string>): Promise<void> {
    if (due.has("night")) await this.night();
    if ((await this.o.runs.get())?.hosted) await this.slice();
  }

  private async night(): Promise<void> {
    const now = this.now();
    const schedule = this.o.deps ? await this.o.deps.access.schedule(this.o.vaultId) : undefined;
    this.cacheHour(schedule?.hourUtc);
    if (!schedule) return;
    // Tomorrow's night is on the books whatever happens tonight.
    this.o.alarms.put("night", nextNight(schedule.hourUtc, now));
    const started = await this.start({});
    if ("code" in started && started.code === "BUSY") this.o.alarms.put("night", now.getTime() + BUSY_RETRY_MS);
  }

  // ── Runs ─────────────────────────────────────────────────────────────────────

  /** Starts a hosted run when there's work and the account can pay for it. `manual` is the owner's Run now. */
  async start(o: { manual?: boolean }): Promise<StartResult> {
    const begun = Date.now();
    const out = await this.tryStart(o);
    const code = "code" in out ? out.code : undefined;
    await this.logged({ route: o.manual ? "curator/hosted run-now" : "curator/hosted night", status: code ? (code === "BUSY" ? 409 : 200) : 201, ...(code ? { code } : {}), ms: Date.now() - begun });
    return out;
  }

  private async tryStart(o: { manual?: boolean }): Promise<StartResult> {
    const now = this.now();
    const h = await this.health(now);
    const why = o.manual && h.why === "unscheduled" ? undefined : h.why;
    if (why) return { code: why.toUpperCase(), message: `Hosted curation can't run: ${why === "paused" ? (PAUSE_WORDS[h.settings?.paused ?? ""] ?? WHY.paused) : WHY[why]}.` };
    const d = this.o.deps!;
    const { settings, accountId } = h as Required<Pick<Health, "settings" | "accountId">>;
    if (STEPS.some((s) => !priceOf(settings.provider, settings.steps[s]))) return { code: "UNPRICED", message: "A chosen model has no price, so it can't be metered: pick the models again." };
    if (!(await d.access.keyFor(accountId).catch(() => undefined))) return { code: "NO_KEY", message: "The saved model key can't be read: save it again." };
    let vault: Vault, failures: Failures;
    try {
      ({ vault, failures } = await this.o.open());
    } catch (err) {
      return err instanceof HttpError ? { code: err.code, message: err.message } : { code: "VAULT", message: "The vault couldn't be read." };
    }
    const exclude = this.tooLarge(settings.runCapMicros);
    const episodes = vault.episodes.filter((e) => !exclude.includes(e.id) && (o.manual || (failures[e.id]?.attempts ?? 0) < SET_ASIDE_AFTER)).length;
    if (!episodes && !waitingWork(vault, failures).rulings) return { code: "IDLE", message: "Nothing is waiting in the inbox." };
    try {
      const step = await this.o.relay.start({ curator: HOSTED_CURATOR, model: mixLabel(settings.provider, settings.steps), hosted: true, exclude, ...(o.manual ? { includeSetAside: true } : {}) });
      if (!("run" in step)) return { code: "NOT_NEEDED", message: "No run was needed." };
      this.ledger(step.run);
      await this.o.alarms.set("slice", now.getTime());
      return { run: step.run };
    } catch (err) {
      if (err instanceof RunBusyError)
        return { code: "BUSY", message: o.manual ? "An agent's sleep run is open: try again when it finishes." : "Another curator's run is open; Hippocampus tries again later." };
      if (err instanceof HttpError) return { code: err.code, message: err.message };
      if (err instanceof VaultError) return { code: "INVALID", message: "The run couldn't start." };
      throw err;
    }
  }

  /** Episodes passed over as too large for the run cap they met. A higher cap lets them back in. */
  private tooLarge(runCapMicros: number): string[] {
    this.rows("DELETE FROM hosted_too_large WHERE cap_micros < ?", runCapMicros);
    return this.rows<{ episode: string }>("SELECT episode FROM hosted_too_large ORDER BY episode").map((r) => r.episode);
  }

  /** Drives the open hosted run for one slice, then books the next, or settles what the run's end means for the account. */
  private async slice(): Promise<void> {
    const state = await this.o.runs.get();
    if (!state?.hosted) return;
    const begun = Date.now();
    const d = this.o.deps;
    const end = async (code: string) => {
      this.o.alarms.put("slice", undefined);
      await this.o.relay.abort(state.id).catch(() => undefined);
      this.rows("DELETE FROM hosted_ledger WHERE run = ?", state.id);
      await this.logged({ route: "curator/hosted", status: 409, code, ms: Date.now() - begun });
    };
    // Switched off, or no longer available: the run closes as aborted, what it committed stays.
    if (!d || d.off) return end(d ? "OFF" : "UNAVAILABLE");
    const accountId = await d.accountOf(this.o.vaultId);
    const settings = accountId === undefined ? undefined : await d.access.settings(accountId);
    const key = accountId === undefined ? undefined : await d.access.keyFor(accountId).catch(() => undefined);
    if (accountId === undefined || !settings || !key) return end("NO_KEY");
    const ledger = this.ledger(state.id);
    const before = ledger.get().micros;
    // The account meter refuses the month's cap by answering nothing, and the run's cap by throwing:
    // only the month's pauses the account.
    let monthRefused = false;
    const account = new AccountMeter(d.db, { accountId, monthCapMicros: settings.monthCapMicros, runCapMicros: settings.runCapMicros, run: ledger, now: this.o.clock });
    const meter: Meter = {
      reserve: async (micros) => {
        const r = await account.reserve(micros);
        if (!r) monthRefused = true;
        return r;
      },
      settle: (r, actual) => account.settle(r, actual),
    };
    let answerer: LLM;
    try {
      answerer = (d.answerer ?? hostedLLM)({ provider: settings.provider, key, mix: settings.steps, meter, ...(d.urls?.[settings.provider] ? { baseURL: d.urls[settings.provider] } : {}) });
    } catch {
      return end("UNPRICED");
    }
    let result;
    try {
      result = await this.o.relay.autopilot({
        runId: state.id,
        answerer,
        until: new Date(this.now().getTime() + SLICE_MS),
        units: SLICE_UNITS,
        onUnit: () => ledger.resetUnit(),
      });
    } catch {
      // A git host hiccup, say: the run stays open and is tried again; past 6 hours it expires.
      this.o.alarms.put("slice", this.now().getTime() + RETRY_SLICE_MS);
      await this.logged({ route: "curator/hosted", status: 500, code: "INTERNAL", ms: Date.now() - begun, micros: ledger.get().micros - before });
      return;
    }
    const micros = ledger.get().micros - before;
    if (result.state === "paused") {
      this.o.alarms.put("slice", this.now().getTime() + NEXT_SLICE_MS);
      await this.logged({ route: "curator/hosted", status: 202, ms: Date.now() - begun, micros });
      return;
    }
    this.o.alarms.put("slice", undefined);
    const summary = (await this.o.runs.history()).find((h) => h.id === state.id);
    for (const id of summary?.tooLarge ?? [])
      this.rows("INSERT INTO hosted_too_large (episode, cap_micros) VALUES (?, ?) ON CONFLICT (episode) DO UPDATE SET cap_micros = excluded.cap_micros", id, settings.runCapMicros);
    if (result.stop === "auth" || result.stop === "credit") await d.access.pause(accountId, result.stop);
    else if (result.stop === "budget" && monthRefused) await d.access.pause(accountId, "budget");
    this.rows("DELETE FROM hosted_ledger WHERE run = ?", state.id);
    await this.logged({ route: "curator/hosted", status: 200, ...(result.stop ? { code: result.stop.toUpperCase() } : {}), ms: Date.now() - begun, micros });
  }

  private async logged(e: { route: string; status: number; code?: string; ms: number; micros?: number }): Promise<void> {
    await logEvent({ ...e, vault: this.o.vaultId }, this.o.log).catch(() => undefined);
  }
}
