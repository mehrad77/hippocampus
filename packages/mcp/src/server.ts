import { HippoService, VaultError } from "@hippocampus/core";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
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
}

/** `read`: every read tool and resource. `remember`: write episodes. `quest`: update quests. */
export const SCOPES = ["read", "remember", "quest"] as const;
export type Scope = (typeof SCOPES)[number];

const INSTRUCTIONS = `Hippocampus is the party's shared, curated memory (an Obsidian vault run like a TTRPG campaign wiki).
Call \`onboard\` at the start of a session. Use \`recall\`, \`get\`, and \`ask_canon\` before acting on facts. Use \`remember\` for anything worth keeping. You never edit canon directly: episodes are consolidated nightly, and conflicts go to the human.
Fact status: canon = trust it, rumor = verify first, disputed = do not act without checking.`;

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

export function createHippoServer({ service, agent, scopes, version = "0.1.0", jsonSchemaValidator }: HippoServerOptions): McpServer {
  const server = new McpServer({ name: "hippocampus", version }, { instructions: INSTRUCTIONS, jsonSchemaValidator });
  // Out-of-scope tools are removed outright, so clients never see them.
  const scoped = (scope: Scope, registered: { remove(): void }) => {
    if (scopes && !scopes.includes(scope)) registered.remove();
  };
  const agentArg = {
    agent: z
      .string()
      .optional()
      .describe(agent ? `Ignored: this connection is bound to "${agent}"` : "Your agent id (party/<id>.md), e.g. residency-agent. Required."),
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
        description: "Your briefing: who you are in the party, your lane and authority, your quests, and the vault's conventions. Call at session start.",
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
          text: z.string().min(1).describe("The memory, in plain language, self-contained"),
          kind: z.enum(["observation", "fact", "decision", "task", "beat", "question"]).optional(),
          about: z.array(z.string()).optional().describe('Hints: entity names or [[links]], e.g. ["[[residence-permit]]", "Agência de Migração"]'),
          confidence: z.number().min(0).max(1).optional(),
          secret: z.boolean().optional().describe("true if it contains ID/passport/bank numbers or credentials"),
          at: z.string().optional().describe("When it happened (ISO 8601); defaults to now"),
        },
      },
      (args) =>
        guard(async () => {
          const { text: body, kind, about, confidence, secret, at } = args;
          const r = await service.remember(who(args), { text: body, kind, about, confidence, secret, at });
          return yaml({ stored: r, note: "Queued for consolidation. It shows up under `pending` in recall until then." });
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
          types: z.array(z.string()).optional().describe("Filter entity types, e.g. [quest, faction]"),
          limit: z.number().int().min(1).max(20).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      (args) => guard(async () => yaml(await service.recall(args.query, { types: args.types, limit: args.limit }))),
    ),
  );

  scoped(
    "read",
    server.registerTool(
      "get",
      {
        title: "Get entity",
        description: "Full note for one entity: all facts with status and provenance, relations, quest objectives/clocks, open disputes, human notes.",
        inputSchema: { entity: z.string().describe("Slug, [[link]], title, or alias") },
        annotations: { readOnlyHint: true },
      },
      (args) => guard(async () => yaml(await service.get(args.entity))),
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
      (args) => guard(async () => yaml(await service.askCanon(args.question))),
    ),
  );

  scoped(
    "read",
    server.registerTool(
      "briefing",
      {
        title: "Briefing",
        description: '"Previously on…": the chronicle since a date, recently updated entities, upcoming deadlines and clocks, and open disputes.',
        inputSchema: {
          since: z.string().optional().describe("ISO date; default 7 days ago"),
          horizon_days: z.number().int().min(1).max(365).optional().describe("How far ahead to look for deadlines (default 30)"),
        },
        annotations: { readOnlyHint: true },
      },
      (args) => guard(async () => yaml(await service.briefing({ since: args.since, horizonDays: args.horizon_days }))),
    ),
  );

  scoped(
    "quest",
    server.registerTool(
      "update_quest",
      {
        title: "Update quest",
        description: "Record quest progress directly: status, completed or new objectives, a progress clock, deadline, or owner.",
        inputSchema: {
          ...agentArg,
          quest: z.string(),
          status: z.enum(["active", "blocked", "done", "failed", "dormant"]).optional(),
          complete: z.array(z.string()).optional().describe("Objectives now done (fuzzy-matched)"),
          add: z.array(z.string()).optional().describe("New objectives"),
          clock: z
            .object({
              name: z.string(),
              segments: z.number().int().min(2).max(12).optional(),
              tick: z.number().int().optional().describe("Segments to fill (+) or clear (−)"),
              filled: z.number().int().min(0).optional(),
              deadline: z.string().optional(),
            })
            .optional(),
          deadline: z.string().optional(),
          owner: z.string().optional(),
        },
      },
      (args) =>
        guard(async () => {
          const { quest, status, complete, add, clock, deadline, owner } = args;
          return yaml(await service.updateQuest(who(args), quest, { status, complete, add, clock, deadline, owner }));
        }),
    ),
  );

  scoped(
    "read",
    server.registerResource(
      "handbook",
      "hippo://handbook",
      { title: "Player's Handbook", description: "Vault conventions, party, active quests", mimeType: "text/markdown" },
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
        contents: [{ uri: uri.href, mimeType: "application/yaml", text: stringify(await service.get(String(slug))) }],
      }),
    ),
  );

  return server;
}
