import { HippoService, VaultError, VaultVersionError } from "@hippocampus/core";
import { RunBusyError, SLEEP_PROCEDURE, type SleepRelay } from "@hippocampus/curator/relay";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { stringify } from "yaml";
import { z } from "zod";

export interface HippoServerOptions {
  service: HippoService;
  /** Fixed agent identity for this connection. If absent, tools that write require an `agent` argument. */
  agent?: string;
  /** What this connection may do. Absent means everything (local use). */
  scopes?: readonly Scope[];
  version?: string;
  /** JSON Schema validator for the SDK; Workers need one that doesn't compile code at runtime. */
  jsonSchemaValidator?: jsonSchemaValidator;
  /** Lets the agent run sleep itself (the `curate` scope). A factory is called per tool call. */
  relay?: SleepRelay | (() => SleepRelay);
  /** The one vault this connection serves, named in the instructions so the agent never mixes vaults up. */
  vault?: { id: string; name: string };
}

// Also defined in apps/worker/src/hosted/registry.ts (KIND_SCOPES) and apps/worker/src/oauth.ts (SCOPE_LABELS).
/**
 * `read`: every read tool and resource. `remember`: write episodes. `goal`: update goals.
 * `curate`: run sleep, which shows the agent every episode in full, secret values included.
 */
export const SCOPES = ["read", "remember", "goal", "curate"] as const;
/** The old name of the `goal` scope. Keys and grants made before goals carry it; new ones carry both. */
export const LEGACY_GOAL_SCOPE = "quest";
/** A scope after `normalizeScopes`. */
export type CurrentScope = (typeof SCOPES)[number];
/** A scope as granted. */
export type Scope = CurrentScope | typeof LEGACY_GOAL_SCOPE;

export const isScope = (s: unknown): s is Scope => s === LEGACY_GOAL_SCOPE || (SCOPES as readonly unknown[]).includes(s);

/** Granted scopes under their current names (`quest` → `goal`), once each, in `SCOPES` order. */
export function normalizeScopes(scopes: readonly Scope[]): CurrentScope[] {
  const have = new Set(scopes.map((s) => (s === LEGACY_GOAL_SCOPE ? "goal" : s)));
  return SCOPES.filter((s) => have.has(s));
}

const INSTRUCTIONS = `Hippocampus is shared, curated memory for the person's AI agents: an Obsidian vault of notes about the people, places, goals and things in their life.
Call \`onboard\` at the start of a session. Use \`recall\`, \`get\`, and \`ask_canon\` before acting on facts, and \`briefing\` with \`about\` before talking to someone. Use \`remember\` for anything worth keeping. You never edit notes directly: memories are consolidated nightly, and conflicts go to the human.
Fact status: canon = trust it, rumor = verify first, disputed = do not act without checking. A "◐ confidential" value is hidden from you: don't guess it.`;

/** One connection, one vault: said up front, since a person can connect several vaults to the same app. */
export const vaultInstructions = (vault: { id: string; name: string }) =>
  `\nThis connection serves one vault, "${vault.name.replace(/["\n]/g, " ")}" (${vault.id}). Everything you remember goes there and only there; another vault has its own connection.`;

const CURATE_INSTRUCTIONS = `
You may also run the nightly consolidation yourself: the \`sleep\` prompt explains how, starting with \`sleep_start\`.`;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const yaml = (value: unknown): ToolResult => ({ content: [{ type: "text", text: stringify(value, { lineWidth: 0 }) }] });
const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof VaultError || err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

/** What `hippo://dashboard/whoami` returns: this connection's identity and the vault it serves. */
export interface DashboardWhoami {
  /** `null` when the connection isn't bound to an agent. */
  agent: string | null;
  /** Current names, plus `quest` next to `goal` for dashboards that predate goals. */
  scopes: Scope[];
  /** The vault's name. */
  name: string;
  /** @deprecated Same as `name`. */
  campaign: string;
  /** The primary human's id. */
  human: string;
  /** Without GitHub logins: an agent's connection has no business knowing the human's accounts. */
  humans: { id: string; domains: string[] }[];
}

/** Vault errors become InvalidParams with a stable `data.code`, so the dashboard can answer 400 or 409 like it does locally. */
async function readOrThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VaultVersionError) throw new McpError(ErrorCode.InvalidParams, err.message, { code: "VERSION" });
    if (err instanceof VaultError) throw new McpError(ErrorCode.InvalidParams, err.message, { code: "VAULT" });
    throw err;
  }
}

/** Template variables arrive still percent-encoded. */
function param(v: string | string[] | undefined, form = false): string {
  const raw = Array.isArray(v) ? v.join(",") : (v ?? "");
  try {
    return decodeURIComponent(form ? raw.replace(/\+/g, " ") : raw);
  } catch {
    throw new VaultError(`badly encoded URI parameter "${raw}"`);
  }
}

/** The server's version, as it introduces itself (and as its server card says). */
export const SERVER_VERSION = "0.1.0";

export function createHippoServer({ service, agent, scopes, version = SERVER_VERSION, jsonSchemaValidator, relay, vault }: HippoServerOptions): McpServer {
  const granted = scopes ? normalizeScopes(scopes) : undefined;
  const curates = !!relay && (!granted || granted.includes("curate"));
  const instructions = (curates ? INSTRUCTIONS + CURATE_INSTRUCTIONS : INSTRUCTIONS) + (vault ? vaultInstructions(vault) : "");
  const server = new McpServer({ name: "hippocampus", version }, { instructions, jsonSchemaValidator });
  // Out-of-scope tools are removed outright, so clients never see them.
  const scoped = (scope: CurrentScope, registered: { remove(): void }) => {
    if (granted && !granted.includes(scope)) registered.remove();
  };
  // Confidential values are shown only to a bound caller (and only where it has authority); an
  // `agent` argument is a claim anyone can make, so it never unmasks anything.
  const caller = agent?.toLowerCase();
  const agentArg = {
    agent: z
      .string()
      .optional()
      .describe(agent ? `Ignored: this connection is bound to "${agent}"` : "Your agent id, e.g. residency-agent. Required."),
  };
  const who = (args: { agent?: string }) => {
    const id = agent ?? args.agent;
    if (!id) throw new VaultError("agent is required");
    return id.toLowerCase();
  };

  scoped(
    "read",
    server.registerTool(
      "onboard",
      {
        title: "Onboard",
        description: "Your briefing: who you are among the agents, your lane and authority, your goals, and the vault's conventions. Call at session start.",
        inputSchema: { ...agentArg },
        annotations: { readOnlyHint: true },
      },
      (args) => guard(async () => text(await service.onboard(who(args)))),
    ),
  );

  scoped(
    "remember",
    server.registerTool(
      "remember",
      {
        title: "Remember",
        description:
          "Submit one memory (episode) to the inbox. Hippocampus consolidates it into canon later, so this returns immediately. One concrete memory per call. Include exact values: ISO dates, amounts with currency, and IDs.",
        inputSchema: {
          ...agentArg,
          text: z.string().optional().describe("The memory, in plain language, self-contained. Required unless the kind makes it optional or forbids it"),
          kind: z
            .string()
            .max(60)
            .optional()
            .describe("One of this vault's kinds (the Handbook lists them), e.g. observation (default), fact, decision, task, question, interaction. An unknown kind is filed as an observation"),
          data: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]))
            .optional()
            .describe('Typed fields the kind declares, e.g. { "with": "[[migration-agency]]", "channel": "call" }'),
          confidential: z.boolean().optional().describe("true to keep it out of search, prompts and the chronicle"),
          scope: z.string().max(100).optional().describe("Context it holds in, e.g. lang:pt or org:harbor-university"),
          about: z.array(z.string().max(200)).max(20).optional().describe('Hints: entity names or [[links]], e.g. ["[[residence-permit]]", "Agência de Migração"]'),
          confidence: z.number().min(0).max(1).optional(),
          secret: z.boolean().optional().describe("true if it contains ID/passport/bank numbers or credentials"),
          at: z.string().max(40).optional().describe("When it happened (ISO 8601); defaults to now"),
        },
      },
      (args) =>
        guard(async () => {
          const { text: body, kind, about, confidence, secret, at, data, confidential, scope } = args;
          const r = await service.remember(who(args), { text: body, kind, about, confidence, secret, at, data, confidential, scope });
          return yaml({ stored: r, note: "Queued for consolidation. It shows up under `pending` in recall until then." });
        }),
    ),
  );

  scoped(
    "remember",
    server.registerTool(
      "introduce",
      {
        title: "Introduce yourself",
        description: `Ask to join the vault's agents, when \`onboard\` says you're unknown. The human approves you and decides your authority; until then your memories count as rumors. Calling it again replaces your earlier introduction.`,
        inputSchema: {
          ...agentArg,
          title: z.string().min(1).max(120).describe('Your display name, e.g. "Job Scout"'),
          lane: z.string().max(500).optional().describe("What you handle, in one sentence"),
          host: z.string().max(120).optional().describe("Where you run, e.g. Claude Desktop"),
          model: z.string().max(120).optional().describe("The model you run on"),
          about: z.string().max(2000).optional().describe("What you do for the human, in a few lines"),
        },
      },
      (args) =>
        guard(async () => {
          const { title, lane, host, model, about } = args;
          const r = await service.introduce(who(args), { title, lane, host, model, about });
          return text(r.status === "member" ? `You're ${r.message}. Nothing to do.` : `Introduced as ${r.agent}: ${r.message}`);
        }),
    ),
  );

  scoped(
    "read",
    server.registerTool(
      "recall",
      {
        title: "Recall",
        description: "Search memory. Returns matching entities (summary + key facts with status), related entities via the graph, and matching not-yet-consolidated episodes.",
        inputSchema: {
          query: z.string().min(1),
          types: z.array(z.string()).optional().describe("Filter entity types, e.g. [goal, character]"),
          limit: z.number().int().min(1).max(20).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      (args) => guard(async () => yaml(await service.recall(args.query, { types: args.types, limit: args.limit, caller }))),
    ),
  );

  scoped(
    "read",
    server.registerTool(
      "get",
      {
        title: "Get entity",
        description:
          "Full note for one entity: facts with status, provenance, scope and validity; relations; goal state, progress and objectives; guidelines (own and inherited); contact stats and cadence; decisions and open questions; open disputes; human notes.",
        inputSchema: { entity: z.string().describe("Slug, [[link]], title, or alias") },
        annotations: { readOnlyHint: true },
      },
      (args) => guard(async () => yaml(await service.get(args.entity, { caller }))),
    ),
  );

  scoped(
    "read",
    server.registerTool(
      "neighbors",
      {
        title: "Neighbors",
        description: "Walk the relation graph around an entity.",
        inputSchema: {
          entity: z.string(),
          rel: z.string().optional().describe("Only this relation type"),
          depth: z.number().int().min(1).max(3).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      (args) => guard(async () => yaml(await service.neighbors(args.entity, { rel: args.rel, depth: args.depth }))),
    ),
  );

  scoped(
    "read",
    server.registerTool(
      "ask_canon",
      {
        title: "Ask canon",
        description: "Get the canonical answer to a factual question (dates, emails, IDs, addresses, amounts). Returns the best-matching facts with status and source, plus any open dispute. Use this when numbers or IDs disagree.",
        inputSchema: { question: z.string().min(1) },
        annotations: { readOnlyHint: true },
      },
      (args) => guard(async () => yaml(await service.askCanon(args.question, { caller }))),
    ),
  );

  scoped(
    "read",
    server.registerTool(
      "briefing",
      {
        title: "Briefing",
        description:
          "What happened and what's next: the chronicle since a date, recently updated entities, upcoming due dates and anniversaries, overdue contacts, and open disputes. With `about`, a brief on one person or thing instead: canon facts, guidelines, recent interactions, open goals with them, open proposals, and contact stats.",
        inputSchema: {
          since: z.string().optional().describe("ISO date; default 7 days ago"),
          horizon_days: z.number().int().min(1).max(365).optional().describe("How far ahead to look for due dates (default 30)"),
          about: z.string().optional().describe("Slug, [[link]], title, or alias: brief on this one instead, e.g. before contacting them"),
        },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        guard(async () =>
          yaml(args.about ? await service.personBrief(args.about, { caller }) : await service.briefing({ since: args.since, horizonDays: args.horizon_days })),
        ),
    ),
  );

  // One checklist line: long enough for a step, short enough that it can't carry a document.
  const objective = z.string().max(300);
  const progressArg = z
    .object({
      done: z.number().int().min(0).optional(),
      total: z.number().int().min(1).optional().describe("Steps that make it done"),
      tick: z.number().int().optional().describe("Steps to add (+) or take back (−)"),
    })
    .optional();
  scoped(
    "goal",
    server.registerTool(
      "update_goal",
      {
        title: "Update goal",
        description:
          "Record goal progress directly: status, completed, reopened or new objectives, progress steps, due date, owner, counterparty, or how it repeats. A repeating goal marked done comes back with its next due date.",
        inputSchema: {
          ...agentArg,
          goal: z.string().describe("Slug, [[link]], title, or alias"),
          status: z.string().max(40).optional().describe("active, blocked, done, failed, dormant, or a word of the goal type's own statuses"),
          complete: z.array(objective).max(50).optional().describe("Objectives now done (fuzzy-matched)"),
          reopen: z.array(objective).max(50).optional().describe("Objectives to mark not done again (fuzzy-matched)"),
          add: z.array(objective).max(50).optional().describe("New objectives"),
          progress: progressArg,
          due: z.string().max(40).nullable().optional().describe("ISO date (YYYY-MM-DD); null clears it"),
          owner: z.string().max(200).optional().describe("The agent or person who drives it"),
          counterparty: z.string().max(200).optional().describe("Who it's with or for, e.g. [[landlord]]"),
          repeat: z
            .object({
              every: z.string().max(40).optional().describe("Interval: 1w, 2w, 1m, 1y"),
              after_last: z.string().max(200).optional().describe("Count from the last episode of this kind with the counterparty, e.g. interaction"),
            })
            .nullable()
            .optional()
            .describe("How it comes back once done; null stops it repeating"),
        },
      },
      (args) =>
        guard(async () => {
          const { goal, status, complete, reopen, add, progress, due, owner, counterparty, repeat } = args;
          return yaml(await service.updateGoal(who(args), goal, { status, complete, reopen, add, progress, due, owner, counterparty, repeat }));
        }),
    ),
  );

  scoped(
    "goal",
    server.registerTool(
      "update_quest",
      {
        title: "Update quest (old name of update_goal)",
        description: "The old name of update_goal, kept for agents set up before goals: a clock becomes the goal's progress, a deadline its due date. Prefer update_goal.",
        inputSchema: {
          ...agentArg,
          quest: z.string(),
          status: z.enum(["active", "blocked", "done", "failed", "dormant"]).optional(),
          complete: z.array(objective).max(50).optional().describe("Objectives now done (fuzzy-matched)"),
          reopen: z.array(objective).max(50).optional().describe("Objectives to mark not done again (fuzzy-matched)"),
          add: z.array(objective).max(50).optional().describe("New objectives"),
          clock: z
            .object({
              name: z.string().max(120),
              segments: z.number().int().min(2).max(12).optional(),
              tick: z.number().int().optional().describe("Segments to fill (+) or clear (−)"),
              filled: z.number().int().min(0).optional(),
              deadline: z.string().max(40).optional(),
            })
            .optional(),
          deadline: z.string().max(40).optional(),
          owner: z.string().max(200).optional(),
        },
      },
      (args) =>
        guard(async () => {
          const { quest, status, complete, reopen, add, clock, deadline, owner } = args;
          return yaml(await service.updateQuest(who(args), quest, { status, complete, reopen, add, clock, deadline, owner }));
        }),
    ),
  );

  // How the SDK resolves a read (shared/uriTemplate.js): an exact URI first, then templates in
  // registration order, first whole-URI match wins. `{slug}` matches `[^/,]+`, so never a `/`;
  // `{?q,limit}` needs every listed param, in order. Matches come back percent-encoded: see `param`.
  scoped(
    "read",
    server.registerResource(
      "handbook",
      "hippo://handbook",
      { title: "Handbook", description: "Vault conventions, types and kinds, agents, active goals", mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await service.handbook() }] }),
    ),
  );

  scoped(
    "read",
    server.registerResource(
      "entity",
      new ResourceTemplate("hippo://entity/{slug}", { list: undefined }),
      { title: "Entity", description: "One entity note as structured data", mimeType: "application/yaml" },
      async (uri, { slug }) => ({
        contents: [{ uri: uri.href, mimeType: "application/yaml", text: stringify(await service.get(String(slug), { caller })) }],
      }),
    ),
  );

  // The dashboard's read models, for `hippo dashboard --mcp`. Without a list callback they stay out of
  // `resources/list`, so agent hosts don't show them. Templates match in insertion order: `{view}` goes last.
  const dashboard = (name: string, template: string, description: string, read: (vars: Variables) => Promise<unknown>) =>
    scoped(
      "read",
      server.registerResource(name, new ResourceTemplate(template, { list: undefined }), { title: `Dashboard: ${name}`, description, mimeType: "application/json" }, async (uri, vars) => ({
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await readOrThrow(() => read(vars))) }],
      })),
    );
  // `limit` changes which hits count as `related`, so it can't be applied client-side; RFC 6570 `{?q,limit}` needs both.
  dashboard("dashboard-search-limit", "hippo://dashboard/search{?q,limit}", "Search results, at most `limit` (1–20) entities", ({ q, limit }) => {
    const n = Number(param(limit));
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new VaultError("limit must be a whole number from 1 to 20");
    return service.search(param(q, true), { limit: n });
  });
  dashboard("dashboard-search", "hippo://dashboard/search{?q}", "Search results as the dashboard shows them", ({ q }) => service.search(param(q, true)));
  dashboard("dashboard-entity", "hippo://dashboard/entity/{slug}", "One entity in full, secrets masked", ({ slug }) => service.entityDetail(param(slug)));
  dashboard("dashboard-chronicle", "hippo://dashboard/chronicle/{month}", "One month (YYYY-MM or latest) of the chronicle", ({ month }) => {
    const m = param(month);
    return service.chronicle(m === "latest" ? undefined : m);
  });
  dashboard("dashboard-view", "hippo://dashboard/{view}", "whoami, overview, catalog or graph", async ({ view }) => {
    switch (param(view)) {
      case "whoami": {
        const { config } = await service.vault();
        const current = granted ?? [...SCOPES];
        return {
          agent: caller ?? null,
          scopes: current.flatMap((s): Scope[] => (s === "goal" ? ["goal", LEGACY_GOAL_SCOPE] : [s])),
          name: config.name,
          campaign: config.name,
          human: config.human,
          humans: config.humans.map((h) => ({ id: h.id, domains: h.domains })),
        } satisfies DashboardWhoami;
      }
      case "overview":
        return service.overview();
      case "catalog":
        return service.catalog();
      case "graph":
        return service.graph();
    }
    throw new VaultError(`no dashboard view "${param(view)}"`);
  });

  if (relay) registerSleep(server, typeof relay === "function" ? relay : () => relay, agent, scoped);

  return server;
}

// Sleep run by the connected agent: the relay turns each curator step into a question for it, and
// replays the step with its answers. Results are compact JSON, since questions carry JSON Schemas.
function registerSleep(server: McpServer, relay: () => SleepRelay, agent: string | undefined, scoped: (scope: CurrentScope, registered: { remove(): void }) => void): void {
  const json = (value: unknown): ToolResult => text(JSON.stringify(value));
  // One run at a time: a second start gets the open run's status, so the agent can pick it up or wait.
  const run = (fn: () => Promise<unknown>) =>
    guard(async () => {
      try {
        return json(await fn());
      } catch (err) {
        if (!(err instanceof RunBusyError)) throw err;
        const hint = "Continue it with sleep_answer (an empty answers list shows its open questions), or stop it with sleep_abort.";
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message, hint, status: err.status }) }], isError: true };
      }
    });
  const runArg = { run: z.string().min(1).describe("The run id from sleep_start") };

  scoped(
    "curate",
    server.registerTool(
      "sleep_start",
      {
        title: "Start sleep",
        description:
          'Run tonight\'s sleep yourself: consolidate the inbox into canon by answering the curator\'s questions. Returns the procedure and the first questions; answer them with sleep_answer until the state is "done". One run at a time. Questions include each episode in full, secret values too: only use this if you are trusted with the vault\'s secrets.',
        inputSchema: {
          model: z.string().min(1).max(120).describe("The model answering the questions, recorded on every commit"),
          curator: z
            .string()
            .optional()
            .describe(agent ? `Ignored: this connection curates as "${agent}"` : 'Your agent id, recorded on every commit (default "curator-agent")'),
          limit: z.number().int().min(1).max(100).optional().describe("Most episodes this run (default 10)"),
        },
      },
      (args) => run(() => relay().start({ curator: agent ?? args.curator ?? "curator-agent", model: args.model, limit: args.limit })),
    ),
  );

  scoped(
    "curate",
    server.registerTool(
      "sleep_answer",
      {
        title: "Answer sleep questions",
        description:
          'Answer the open questions, all at once. Each value is JSON matching its question\'s `schema` (an object, or a JSON string). Returns the next questions, or state "done" with the report. Answers under `rejected` were not accepted: fix and resend them.',
        inputSchema: {
          ...runArg,
          answers: z
            .array(z.object({ question_id: z.string(), value: z.unknown().describe("JSON matching the question's schema") }))
            .describe("One per question. An empty list shows the open questions again."),
        },
      },
      (args) => run(() => relay().answer({ runId: args.run, answers: args.answers.map((a) => ({ questionId: a.question_id, value: a.value })) })),
    ),
  );

  scoped(
    "curate",
    server.registerTool(
      "sleep_skip",
      {
        title: "Skip in sleep",
        description: "Skip the episode being asked about (it stays in the inbox for the human), or during the finish the summary being asked. Returns the next questions.",
        inputSchema: { ...runArg, reason: z.string().min(1).max(300).describe("Why, in a few words. Never a secret value.") },
      },
      (args) => run(() => relay().skip({ runId: args.run, reason: args.reason })),
    ),
  );

  scoped(
    "curate",
    server.registerTool(
      "sleep_status",
      {
        title: "Sleep status",
        description: "The open sleep run, if any (who runs it, its progress and lease), and the last runs.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () => run(() => relay().status()),
    ),
  );

  scoped(
    "curate",
    server.registerTool(
      "sleep_abort",
      {
        title: "Abort sleep",
        description: "Stop the open run. What it already committed stays; the rest stays in the inbox.",
        inputSchema: { ...runArg },
        annotations: { destructiveHint: true },
      },
      (args) => run(() => relay().abort(args.run)),
    ),
  );

  scoped(
    "curate",
    server.registerPrompt("sleep", { title: "Run Hippocampus sleep", description: "Consolidate the inbox into canon yourself, one question at a time." }, () => ({
      messages: [{ role: "user", content: { type: "text", text: `${SLEEP_PROCEDURE}\n\nStart by calling sleep_start with your model name.` } }],
    })),
  );
}
