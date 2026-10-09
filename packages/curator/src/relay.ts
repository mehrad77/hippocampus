import {
  ACTOR_TRAILER,
  AGENT_ID,
  AuditError,
  MODEL_TRAILER,
  StoreConflictError,
  VaultError,
  auditChanges,
  hash,
  miniSearcher,
  ulid,
  withTrailers,
  type SearcherFactory,
  type Vault,
  type VaultStore,
} from "@hippocampus/core";
import { z } from "zod";
import type { LLM } from "./llm.ts";
import { CURATOR_AUTHOR, beginRun, consolidate, describeEpisode, finishRun, loadHouseRules, pickBatch, summarize, summaryTargets, type EpisodeOutcome, type SleepReport } from "./sleep.ts";

// Sleep driven by an outside agent, one tool call at a time. The server keeps no model of its own: each
// curator LLM call becomes a question the agent answers, and every call replays the current unit (the
// rulings, one episode, or the finish) from a fresh vault with the answers recorded so far, until it
// commits. A replay is free while the questions stay the same; when the vault moved underneath, the
// question's hash changes and only what changed is asked again.

/** How the curating agent answers questions. Shared by the MCP `sleep` prompt and the plugin skill. */
export const SLEEP_PROCEDURE = `You are the curator of a Hippocampus vault tonight: you turn the inbox's episodes into canon by answering the server's questions. The server does the bookkeeping; you make the judgment calls.

How to answer:
1. Each question has \`system\` (your instructions for this step), \`prompt\` (the input) and \`schema\` (a JSON Schema). Follow \`system\`, read \`prompt\`, and answer with one JSON value that matches \`schema\`. No prose, no code fences.
2. Answer every question in the response, then call \`sleep_answer\` once with all of them: \`{ run, answers: [{ question_id, value }] }\`.
3. Repeat until the state is "done". Answers under \`rejected\` were not accepted: fix them and send them again. A question can come back when the vault changed meanwhile; answer it again.
4. Use only what each question gives you. Never invent names, dates, numbers or facts, and never carry a value from one question into another.
5. If an episode is unclear, or isn't yours to decide, call \`sleep_skip\` with a short reason (never a secret value). It stays in the inbox for the human.

Questions can contain secret values (ID numbers, credentials). Use them only to answer that question, and never repeat them anywhere else.`;

/** One curator step for the agent: follow `system`, read `prompt`, answer with JSON matching `schema`. */
export interface Question {
  /** `${unit}#${index}:${hash}`. The hash covers everything the agent sees, so a changed question gets a new id. */
  id: string;
  unit: string;
  index: number;
  name: string;
  system: string;
  prompt: string;
  schema: object;
}

/** Thrown by the relay's LLM for a question without a usable answer. Nothing between it and the relay may catch it. */
export class NeedsAnswer extends Error {
  constructor(readonly question: Question) {
    super(`waiting for an answer to ${question.id}`);
  }
}

/** A live run is in progress: there's one curator at a time. */
export class RunBusyError extends VaultError {
  constructor(readonly status: RunStatus) {
    const run = status.run!;
    super(`sleep run ${run.id} by ${run.curator} is in progress until ${run.leaseUntil}`);
  }
}

export interface RecordedAnswer {
  index: number;
  hash: string;
  value: unknown;
}

/** A secret consolidated earlier in the run, as a seeded fingerprint: the value itself never outlives its unit. */
export interface SecretMark {
  length: number;
  hash: string;
}

export interface Rejection {
  questionId: string;
  issues: string;
}

export interface Progress {
  /** Episodes behind us. */
  done: number;
  total: number;
  unit: string;
}

export interface RelayReport extends SleepReport {
  curator: string;
  /** Episodes the curator skipped; they stay in the inbox. */
  skipped: { id: string; reason: string }[];
  /** Subjects of the commits this run made. */
  commits: string[];
}

export type RelayStep =
  | { run: string; state: "ask"; progress: Progress; questions: Question[]; rejected?: Rejection[]; procedure?: string }
  | { run: string; state: "done"; report: RelayReport };

/** The open run. Holds no plaintext: reports carry slugs and decisions, evidence is redacted. */
export interface RunState {
  id: string;
  curator: string;
  model: string;
  /** The run's clock: every unit loads the vault at this time, so a replay writes the same timestamps. */
  now: string;
  leaseUntil: string;
  /** Episode ids, pinned at start. */
  batch: string[];
  cursor: number;
  phase: "rulings" | "episodes" | "finish" | "done";
  report: SleepReport;
  /** Redacted text per touched slug, for the summaries at the finish. */
  evidence: Record<string, string[]>;
  commits: string[];
  skipped: { id: string; reason: string }[];
  /** Entities whose summary the curator skipped. */
  skippedSummaries: string[];
  /** The entity whose summary is being asked, so a skip during the finish knows what to drop. */
  asking?: string;
  marks: SecretMark[];
  seed: number;
}

/** A finished run, for status: ids, counts and times only. */
export interface RunSummary {
  id: string;
  curator: string;
  model: string;
  started: string;
  ended: string;
  outcome: "done" | "expired" | "aborted";
  consolidated: number;
  failed: number;
  skipped: number;
  summaries: number;
  remaining: number;
  commits: number;
}

export interface RunStatus {
  /** The open run, if any. `live` turns false when its lease passes; the next call finishes it without summaries. */
  run?: { id: string; curator: string; model: string; started: string; leaseUntil: string; live: boolean; progress: Progress };
  /** Newest first. */
  history: RunSummary[];
}

/** Where the relay keeps its one run. The Worker implements it over Durable Object storage. */
export interface RunStore {
  get(): Promise<RunState | undefined>;
  put(s: RunState): Promise<void>;
  clear(): Promise<void>;
  /** A unit's recorded answers, by index. */
  answers(unit: string): Promise<RecordedAnswer[]>;
  /** Records an answer, replacing one at the same index. */
  putAnswer(unit: string, a: RecordedAnswer): Promise<void>;
  /** Drops one unit's answers, or all of them. */
  clearAnswers(unit?: string): Promise<void>;
  history(): Promise<RunSummary[]>;
  pushHistory(s: RunSummary): Promise<void>;
}

export class MemoryRunStore implements RunStore {
  private state?: RunState;
  private readonly recorded = new Map<string, Map<number, RecordedAnswer>>();
  private readonly past: RunSummary[] = [];

  constructor(private readonly keep = 20) {}

  // Copies in and out, like a real store: a caller's later mutation must not leak into what's stored.
  async get(): Promise<RunState | undefined> {
    return this.state && structuredClone(this.state);
  }
  async put(s: RunState): Promise<void> {
    this.state = structuredClone(s);
  }
  async clear(): Promise<void> {
    this.state = undefined;
  }
  async answers(unit: string): Promise<RecordedAnswer[]> {
    return [...(this.recorded.get(unit)?.values() ?? [])].sort((a, b) => a.index - b.index).map((a) => structuredClone(a));
  }
  async putAnswer(unit: string, a: RecordedAnswer): Promise<void> {
    if (!this.recorded.has(unit)) this.recorded.set(unit, new Map());
    this.recorded.get(unit)!.set(a.index, structuredClone(a));
  }
  async clearAnswers(unit?: string): Promise<void> {
    if (unit === undefined) this.recorded.clear();
    else this.recorded.delete(unit);
  }
  async history(): Promise<RunSummary[]> {
    return structuredClone(this.past);
  }
  async pushHistory(s: RunSummary): Promise<void> {
    this.past.unshift(structuredClone(s));
    this.past.splice(this.keep);
  }
}

export interface SleepRelayDeps {
  /** A fresh vault at the store's head, loaded with `now` as its clock, and the store it came from. */
  open(now: Date): Promise<{ vault: Vault; store: VaultStore }>;
  runs: RunStore;
  /** Matches mentions to notes. Defaults to the in-memory index, never a persistent one: a replay must see the candidates its question was asked with. */
  searcher?: SearcherFactory;
  clock?: () => Date;
  /** How long a run stays live without a call (15 minutes). */
  leaseMs?: number;
  /** Questions per response, counting the current one (4). */
  lookahead?: number;
  /** Episodes per run when `start` gives no limit (10, or the vault's batch size if smaller). */
  batch?: number;
}

/** Replays after a conflicting commit before giving up. */
const MAX_REPLAYS = 3;

const STALE = "not an open question: the vault may have changed since it was asked. Answer the questions in this response instead.";
const LEAKED = "contains a secret value from another episode of this run. Answer from this question's input only.";

interface Pass {
  /** Answers sent with this call, by question id. */
  submitted: Map<string, unknown>;
  used: Set<string>;
  rejected: Rejection[];
}

type LeakCheck = (q: Question, value: unknown) => boolean;

interface UnitResult {
  /** Commit subject; nothing is committed without one. */
  subject?: string;
  body?: string[];
  /** Folds what the unit learned into the run, once its commit landed. */
  settle(s: RunState): void;
}

/** Drives a sleep run from outside: `start`, then `answer` until done. One run at a time, calls serialized. */
export class SleepRelay {
  private readonly searcher: SearcherFactory;
  private readonly clock: () => Date;
  private readonly leaseMs: number;
  private readonly lookahead: number;
  private readonly batch: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: SleepRelayDeps) {
    this.searcher = d.searcher ?? miniSearcher;
    this.clock = d.clock ?? (() => new Date());
    this.leaseMs = d.leaseMs ?? 15 * 60_000;
    this.lookahead = Math.max(1, d.lookahead ?? 4);
    this.batch = d.batch ?? 10;
  }

  start(i: { curator: string; model: string; limit?: number }): Promise<RelayStep> {
    return this.exclusive(async () => {
      const now = this.clock();
      await this.settle(now);
      if (await this.d.runs.get()) throw new RunBusyError(await this.statusAt(now));
      const curator = i.curator.trim().toLowerCase();
      if (!AGENT_ID.test(curator)) throw new VaultError(`curator "${i.curator}" must be an agent id: lowercase letters, digits and dashes`);
      const model = i.model.replace(/\s+/g, " ").trim().slice(0, 120);
      if (!model) throw new VaultError("model is required: the name of the model answering the questions");
      const { vault } = await this.d.open(now);
      const batch = pickBatch(vault, i.limit ?? Math.min(this.batch, vault.config.curator.batch_size)).map((e) => e.id);
      const state: RunState = {
        id: `run-${ulid(now.getTime()).toLowerCase()}`,
        curator,
        model,
        now: now.toISOString(),
        leaseUntil: this.leaseFrom(now),
        batch,
        cursor: 0,
        phase: "rulings",
        report: { model, rulings: [], consolidated: [], failed: [], summaries: [], remaining: 0, changed: [], warnings: [] },
        evidence: {},
        commits: [],
        skipped: [],
        skippedSummaries: [],
        marks: [],
        seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
      };
      // Left over from a run that ended without closing; they must not answer this run's questions.
      await this.d.runs.clearAnswers();
      await this.d.runs.put(state);
      const step = await this.drive(state, pass([]));
      return step.state === "ask" ? { ...step, procedure: SLEEP_PROCEDURE } : step;
    });
  }

  /** Values may be JSON or a JSON string. An empty list just shows the open questions again. */
  answer(i: { runId: string; answers: { questionId: string; value: unknown }[] }): Promise<RelayStep> {
    return this.exclusive(async () => this.drive(await this.live(i.runId), pass(i.answers)));
  }

  /** Skips the current episode (it stays in the inbox), or during the finish the summary being asked. */
  skip(i: { runId: string; reason: string }): Promise<RelayStep> {
    return this.exclusive(async () => {
      const state = await this.live(i.runId);
      const reason = i.reason.replace(/\s+/g, " ").trim().slice(0, 300) || "no reason given";
      if (state.phase === "episodes") {
        const id = state.batch[state.cursor]!;
        await this.d.runs.clearAnswers(episodeUnit(id));
        state.skipped.push({ id, reason });
        this.advance(state);
      } else if (state.phase === "finish" && state.asking) {
        state.skippedSummaries.push(state.asking);
        state.report.warnings.push(`summary for ${state.asking} skipped: ${reason}`);
      } else {
        throw new VaultError("nothing to skip: no question is open");
      }
      await this.d.runs.put(state);
      return this.drive(state, pass([]));
    });
  }

  status(): Promise<RunStatus> {
    return this.exclusive(() => this.statusAt(this.clock()));
  }

  /** Stops the run where it is. Units already committed stay; the rest stays in the inbox. */
  abort(runId: string): Promise<RunStatus> {
    return this.exclusive(async () => {
      const state = await this.d.runs.get();
      if (!state || state.id !== runId) throw this.notOpen(runId, state);
      const { vault } = await this.d.open(new Date(state.now));
      state.report.remaining = vault.episodes.length;
      await this.close(state, "aborted");
      return this.statusAt(this.clock());
    });
  }

  /** Finishes a run whose lease has passed, without summaries: the review and handbook still get written. */
  expire(now: Date): Promise<void> {
    return this.exclusive(() => this.settle(now));
  }

  // ── Driving ─────────────────────────────────────────────────────────────────

  private async drive(state: RunState, p: Pass): Promise<RelayStep> {
    while (state.phase !== "done") {
      const asked = await this.runUnit(state, p);
      if (!asked) continue;
      await this.d.runs.put(state);
      const questions = [asked.question, ...(await this.ahead(state, p))];
      const unmatched = [...p.submitted.keys()].filter((id) => !p.used.has(id)).map((questionId) => ({ questionId, issues: STALE }));
      const rejected = [...p.rejected, ...unmatched];
      return { run: state.id, state: "ask", progress: progress(state), questions, ...(rejected.length ? { rejected } : {}) };
    }
    return this.close(state, "done");
  }

  /** Runs the current unit to its commit (and moves on), or to its first unanswered question. */
  private async runUnit(state: RunState, p: Pass, o: { summaries?: boolean } = {}): Promise<NeedsAnswer | undefined> {
    const unit = unitOf(state);
    for (let attempt = 0; ; attempt++) {
      state.asking = undefined;
      const { vault, store } = await this.d.open(new Date(state.now));
      const llm = new RelayLLM(state.model, unit, await this.d.runs.answers(unit), p, leakCheck(state), (a) => this.d.runs.putAnswer(unit, a));
      let result: UnitResult;
      try {
        result = await this.work(state, vault, store, llm, o.summaries ?? true);
      } catch (err) {
        if (!(err instanceof NeedsAnswer)) throw err;
        if (llm.drift !== undefined) await this.dropAnswers(unit, llm.drift);
        return err;
      }
      let changed: string[] = [];
      if (result.subject) {
        try {
          changed = await vault.flush({ message: this.message(state, result.subject, result.body), author: CURATOR_AUTHOR });
        } catch (err) {
          // Someone committed meanwhile: replay at the new head. Recorded answers still match unless their question changed.
          if (err instanceof StoreConflictError && attempt < MAX_REPLAYS) continue;
          throw err;
        }
        state.commits.push(result.subject);
      }
      result.settle(state);
      state.report.changed = [...new Set([...state.report.changed, ...changed])];
      // Claims answers can hold secret values: they don't outlive their unit.
      await this.d.runs.clearAnswers(unit);
      await this.d.runs.put(state);
      return undefined;
    }
  }

  private async work(state: RunState, vault: Vault, store: VaultStore, llm: RelayLLM, summaries: boolean): Promise<UnitResult> {
    const houseRules = await loadHouseRules(store);
    const audit = (forbidden: string[] = []) => auditChanges({ before: store, changes: vault.changes(), actor: { kind: "curator" }, forbidden });

    if (state.phase === "rulings") {
      const rulings = beginRun(vault);
      const violations = await audit();
      if (violations.length) throw new AuditError(violations);
      return {
        subject: rulings.length ? `chore(sleep): apply ${rulings.length} ruling${rulings.length === 1 ? "" : "s"}` : undefined,
        body: rulings.map((r) => `- ruling: ${r}`),
        settle: (s) => {
          s.report.rulings = rulings;
          this.advance(s);
        },
      };
    }

    if (state.phase === "episodes") {
      const id = state.batch[state.cursor]!;
      const ep = vault.episodes.find((e) => e.id === id);
      // Consolidated or removed since the run started: nothing left to do.
      if (!ep) return { settle: (s) => this.advance(s) };
      const failed = (err: unknown): UnitResult => ({
        settle: (s) => {
          s.report.failed.push({ id: ep.id, path: ep.path, error: err instanceof Error ? err.message : String(err) });
          this.advance(s);
        },
      });
      let outcome: EpisodeOutcome;
      try {
        outcome = await consolidate(vault, llm, ep, this.searcher, { houseRules });
      } catch (err) {
        if (err instanceof NeedsAnswer) throw err;
        return failed(err);
      }
      const { evidence, secrets, ...report } = outcome;
      const violations = await audit(secrets);
      if (violations.length) return failed(new AuditError(violations));
      return {
        subject: `chore(sleep): ${ep.id} (${ep.agent}) ${clip(describeEpisode(report), 100)}`,
        settle: (s) => {
          s.report.consolidated.push(report);
          for (const slug of report.touched) s.evidence[slug] = [...(s.evidence[slug] ?? []), evidence];
          s.marks.push(...marksOf(secrets, s.seed));
          this.advance(s);
        },
      };
    }

    const evidence = new Map(Object.entries(state.evidence));
    const targets = summaries ? summaryTargets(vault, evidence).filter((t) => !state.skippedSummaries.includes(t.entity.slug)) : [];
    const report: SleepReport = structuredClone(state.report);
    for (const { entity, texts } of targets) {
      try {
        await summarize(vault, llm, entity, texts, { houseRules });
        report.summaries.push(entity.slug);
      } catch (err) {
        if (err instanceof NeedsAnswer) {
          state.asking = entity.slug;
          throw err;
        }
        report.warnings.push(`summary for ${entity.slug} failed: ${(err as Error).message}`);
      }
    }
    if (!summaries) report.warnings.push("the run's lease passed: finished without summaries");
    finishRun(vault, report);
    const violations = await audit();
    if (violations.length) throw new AuditError(violations);
    return {
      subject: `chore(sleep): finish run ${state.id}`,
      settle: (s) => {
        s.report = { ...report, changed: s.report.changed };
        s.phase = "done";
      },
    };
  }

  /** The first question of the next episodes, asked against head, so the agent can answer them in one go. */
  private async ahead(state: RunState, p: Pass): Promise<Question[]> {
    const room = this.lookahead - 1;
    const next = state.phase === "episodes" ? state.batch.slice(state.cursor + 1) : [];
    if (room <= 0 || !next.length) return [];
    const { vault, store } = await this.d.open(new Date(state.now));
    const houseRules = await loadHouseRules(store);
    const leaks = leakCheck(state);
    const out: Question[] = [];
    for (const id of next) {
      const unit = episodeUnit(id);
      // Past the window, only to take in answers sent for it.
      const sent = [...p.submitted.keys()].some((k) => k.startsWith(`${unit}#`) && !p.used.has(k));
      if (out.length >= room && !sent) continue;
      const ep = vault.episodes.find((e) => e.id === id);
      if (!ep) continue;
      // consolidate asks its first question before it changes anything, so one vault serves every probe.
      const first = new FirstQuestion(state.model);
      await consolidate(vault, first, ep, this.searcher, { houseRules }).catch((err: unknown) => {
        if (err !== FIRST) throw err;
      });
      if (!first.req) continue;
      const { q, hash: h } = await question(unit, 0, first.req);
      const given = accept(q, first.req.schema, p, leaks);
      if (given) {
        await this.d.runs.putAnswer(unit, { index: 0, hash: h, value: given.value });
        continue;
      }
      const recorded = (await this.d.runs.answers(unit)).find((a) => a.index === 0);
      if (!p.used.has(q.id) && recorded?.hash === h) continue;
      if (out.length < room) out.push(q);
    }
    return out;
  }

  // ── Run bookkeeping ─────────────────────────────────────────────────────────

  private advance(s: RunState): void {
    if (s.phase === "rulings") s.phase = "episodes";
    else if (s.phase === "episodes") s.cursor++;
    if (s.phase === "episodes" && s.cursor >= s.batch.length) s.phase = "finish";
  }

  private async dropAnswers(unit: string, from: number): Promise<void> {
    const keep = (await this.d.runs.answers(unit)).filter((a) => a.index < from);
    await this.d.runs.clearAnswers(unit);
    for (const a of keep) await this.d.runs.putAnswer(unit, a);
  }

  /** The open run `runId`, its lease renewed. A lapsed run is finished first, and then isn't open. */
  private async live(runId: string): Promise<RunState> {
    const now = this.clock();
    await this.settle(now);
    const state = await this.d.runs.get();
    if (!state || state.id !== runId) throw this.notOpen(runId, state);
    state.leaseUntil = this.leaseFrom(now);
    await this.d.runs.put(state);
    return state;
  }

  private async settle(now: Date): Promise<void> {
    const state = await this.d.runs.get();
    if (!state || Date.parse(state.leaseUntil) > now.getTime()) return;
    // The episode in flight and the rest of the batch stay in the inbox.
    await this.d.runs.clearAnswers();
    state.phase = "finish";
    try {
      await this.runUnit(state, pass([]), { summaries: false });
    } catch (err) {
      // An expired run must not hold the slot forever, even if its review can't be written.
      state.report.warnings.push(`could not finish the run: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.close(state, "expired");
  }

  private async close(state: RunState, outcome: RunSummary["outcome"]): Promise<Extract<RelayStep, { state: "done" }>> {
    state.phase = "done";
    await this.d.runs.clearAnswers();
    await this.d.runs.clear();
    const r = state.report;
    await this.d.runs.pushHistory({
      id: state.id,
      curator: state.curator,
      model: state.model,
      started: state.now,
      ended: this.clock().toISOString(),
      outcome,
      consolidated: r.consolidated.length,
      failed: r.failed.length,
      skipped: state.skipped.length,
      summaries: r.summaries.length,
      remaining: r.remaining,
      commits: state.commits.length,
    });
    return { run: state.id, state: "done", report: { ...r, curator: state.curator, skipped: state.skipped, commits: state.commits } };
  }

  private async statusAt(now: Date): Promise<RunStatus> {
    const s = await this.d.runs.get();
    const history = await this.d.runs.history();
    if (!s) return { history };
    const run = { id: s.id, curator: s.curator, model: s.model, started: s.now, leaseUntil: s.leaseUntil, live: Date.parse(s.leaseUntil) > now.getTime(), progress: progress(s) };
    return { run, history };
  }

  private notOpen(runId: string, open: RunState | undefined): VaultError {
    return new VaultError(open ? `run "${runId}" isn't the open sleep run (${open.id} is)` : `no sleep run "${runId}" is open; start one`);
  }

  private message(state: RunState, subject: string, body: string[] = []): string {
    const text = [`${subject} [skip ci]`, ...(body.length ? ["", ...body] : [])].join("\n");
    return withTrailers(text, { [ACTOR_TRAILER]: "curator", "Hippo-Curator": state.curator, [MODEL_TRAILER]: state.model, "Hippo-Run": state.id });
  }

  private leaseFrom(now: Date): string {
    return new Date(now.getTime() + this.leaseMs).toISOString();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

/** The curator's LLM for one unit: answers from what the agent said, or asks. */
class RelayLLM implements LLM {
  private next = 0;
  /** Index of the first recorded answer whose question changed: it and every later one are stale. */
  drift?: number;

  constructor(
    readonly name: string,
    private readonly unit: string,
    private readonly recorded: RecordedAnswer[],
    private readonly pass: Pass,
    private readonly leaks: LeakCheck,
    private readonly record: (a: RecordedAnswer) => Promise<void>,
  ) {}

  async object<T>(req: { name: string; schema: z.ZodType<T>; system: string; prompt: string }): Promise<T> {
    const index = this.next++;
    const { q, hash: h } = await question(this.unit, index, req);
    const given = accept(q, req.schema, this.pass, this.leaks);
    if (given) {
      await this.record({ index, hash: h, value: given.value });
      return given.value;
    }
    // An answer rejected just now is asked again, whatever was recorded before.
    const old = this.pass.used.has(q.id) ? undefined : this.recorded.find((a) => a.index === index);
    if (old) {
      const parsed = old.hash === h ? req.schema.safeParse(old.value) : undefined;
      if (parsed?.success && !this.leaks(q, parsed.data)) return parsed.data;
      // A secret learned after this answer was given (say, a look-ahead answered early) shows up in it now.
      if (parsed?.success) this.pass.rejected.push({ questionId: q.id, issues: LEAKED });
      this.drift ??= index;
    }
    throw new NeedsAnswer(q);
  }
}

const FIRST = Symbol("first question");

/** Captures the first question of a unit and stops it there. */
class FirstQuestion implements LLM {
  req?: { name: string; schema: z.ZodType<unknown>; system: string; prompt: string };
  constructor(readonly name: string) {}
  async object<T>(req: { name: string; schema: z.ZodType<T>; system: string; prompt: string }): Promise<T> {
    this.req = req;
    throw FIRST;
  }
}

/** The answer sent for `q` with this call, if it validates. A bad one is listed as rejected and not kept. */
function accept<T>(q: Question, schema: z.ZodType<T>, p: Pass, leaks: LeakCheck): { value: T } | undefined {
  if (!p.submitted.has(q.id)) return undefined;
  p.used.add(q.id);
  const parsed = schema.safeParse(p.submitted.get(q.id));
  if (!parsed.success) {
    p.rejected.push({ questionId: q.id, issues: z.prettifyError(parsed.error) });
    return undefined;
  }
  if (leaks(q, parsed.data)) {
    p.rejected.push({ questionId: q.id, issues: LEAKED });
    return undefined;
  }
  return { value: parsed.data };
}

async function question(unit: string, index: number, req: { name: string; schema: z.ZodType<unknown>; system: string; prompt: string }): Promise<{ q: Question; hash: string }> {
  const schema = z.toJSONSchema(req.schema, { io: "input", unrepresentable: "any" });
  const h = await digest(JSON.stringify([req.name, req.system, req.prompt, schema]));
  return { q: { id: `${unit}#${index}:${h}`, unit, index, name: req.name, system: req.system, prompt: req.prompt, schema }, hash: h };
}

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes.subarray(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pass(answers: { questionId: string; value: unknown }[]): Pass {
  return { submitted: new Map(answers.map((a) => [a.questionId, parseValue(a.value)])), used: new Set(), rejected: [] };
}

/** Agents often send JSON as a string; a string that isn't JSON stays a string and fails the schema. */
function parseValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const episodeUnit = (id: string) => `ep:${id}`;

function unitOf(s: RunState): string {
  if (s.phase === "episodes") return episodeUnit(s.batch[s.cursor]!);
  return s.phase;
}

function progress(s: RunState): Progress {
  const done = s.phase === "rulings" ? 0 : s.phase === "episodes" ? s.cursor : s.batch.length;
  return { done, total: s.batch.length, unit: unitOf(s) };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ── Secrets across units ────────────────────────────────────────────────────
// Unlike a model behind an API, the agent keeps every question in its context, so it can carry one
// episode's secret into another episode's answer, or into a summary. The audit only knows the current
// unit's secrets; fingerprints of the earlier ones let the relay refuse such an answer without keeping
// the values. An answer may hold a run secret only when its own question does.

const WORD = /[\p{L}\p{N}]/u;

/** Fingerprints of `values`, skipping the ones too short to tell apart (as the audit does). */
export function marksOf(values: readonly string[], seed: number): SecretMark[] {
  return values.filter((v) => v.trim().length >= 3).map((v) => ({ length: v.length, hash: hash(v, seed) }));
}

/** Hashes of the marks `text` contains. Short values count only as whole tokens, like the audit's. */
export function marksIn(text: string, marks: readonly SecretMark[], seed: number): Set<string> {
  const found = new Set<string>();
  const byLength = new Map<number, Set<string>>();
  for (const m of marks) byLength.set(m.length, (byLength.get(m.length) ?? new Set()).add(m.hash));
  for (const [n, hashes] of byLength) {
    for (let i = 0; i + n <= text.length; i++) {
      if (n < 6 && (WORD.test(text[i - 1] ?? "") || WORD.test(text[i + n] ?? ""))) continue;
      const h = hash(text.slice(i, i + n), seed);
      if (hashes.has(h)) found.add(h);
    }
  }
  return found;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function leakCheck(s: Pick<RunState, "marks" | "seed">): LeakCheck {
  return (q, value) => {
    if (!s.marks.length) return false;
    const given = new Set(strings(value).flatMap((v) => [...marksIn(v, s.marks, s.seed)]));
    if (!given.size) return false;
    const asked = marksIn(`${q.system}\n${q.prompt}`, s.marks, s.seed);
    return [...given].some((h) => !asked.has(h));
  };
}
