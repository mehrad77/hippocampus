import { HttpError } from "./http.ts";
import type { AgentConnect, Job, LlmSetupRequest, LocalSetupStatus, ScheduleStatus, SetupItem, SetupPort, VaultSetupRequest } from "./setup.ts";

/**
 * Session Zero for the demo: the real wizard against pretend state. Nothing touches the disk;
 * choices are remembered in memory so the walkthrough feels real (and the UI can be built against it).
 */
export function demoSetup(opts: { agents: { id: string; title: string; lastSeen?: string }[]; unknownAgents?: string[] }): SetupPort {
  const state = {
    vault: { kind: "dir" as const, dir: "~/vaults/lisbon-arc", version: "current" as const, isDefault: true },
    identity: true,
    llm: { provider: "lmstudio", model: "qwen/qwen3.5-9b", baseURL: "http://127.0.0.1:1234/v1" as string | undefined, apiKey: "unset" as "set" | "unset" },
    schedule: { installed: false, hour: 3, minute: 30 },
    workerUrl: undefined as string | undefined,
    jobs: new Map<string, Job>(),
    party: [...opts.agents],
  };

  const schedule = (): ScheduleStatus => ({
    platform: "demo",
    supported: true,
    label: "com.hippocampus.sleep.lisbon-arc",
    installed: state.schedule.installed,
    loaded: state.schedule.installed,
    hour: state.schedule.hour,
    minute: state.schedule.minute,
    nextRun: state.schedule.installed ? nextRun(state.schedule.hour, state.schedule.minute) : undefined,
    cron: `${state.schedule.minute} ${state.schedule.hour} * * * npx -y @mehrad77/hippocampus --vault ~/vaults/lisbon-arc sleep`,
  });

  const agents = (): AgentConnect[] =>
    state.party.map((a) => ({
      agent: a.id,
      title: a.title,
      lastSeen: a.lastSeen,
      snippets: [
        { label: "Claude Code", lang: "bash", code: `claude mcp add hippocampus -- npx -y @mehrad77/hippocampus -v ~/vaults/lisbon-arc serve --agent ${a.id}` },
        {
          label: "Claude Desktop (claude_desktop_config.json)",
          lang: "json",
          code: JSON.stringify({ mcpServers: { hippocampus: { command: "npx", args: ["-y", "@mehrad77/hippocampus", "-v", "~/vaults/lisbon-arc", "serve", "--agent", a.id] } } }, null, 2),
        },
        { label: "Any MCP client over HTTP", lang: "text", code: `hippo -v ~/vaults/lisbon-arc serve --http 8765\n→ http://127.0.0.1:8765/mcp?agent=${a.id}` },
      ],
    }));

  const items = (): SetupItem[] => [
    { id: "vault", title: "Vault", state: "done", detail: `Demo vault at ${state.vault.dir}`, how: "performed" },
    { id: "party", title: "Party", state: (opts.unknownAgents ?? []).length ? "warn" : "done", detail: `${state.party.length} agents${(opts.unknownAgents ?? []).length ? `; unknown: ${opts.unknownAgents!.join(", ")}` : ""}`, how: "performed" },
    { id: "secrets", title: "Secrets key", state: state.identity ? "done" : "todo", detail: state.identity ? "age identity on this machine matches the vault" : "No key yet", how: "performed" },
    { id: "llm", title: "Curator model", state: "done", detail: `${state.llm.provider} · ${state.llm.model}`, how: "performed" },
    { id: "git", title: "Private GitHub repo", state: "warn", detail: "Demo: no remote configured", how: "guided" },
    { id: "agents", title: "Connect agents", state: "done", detail: "Snippets ready for every party member", how: "guided" },
    { id: "schedule", title: "Nightly sleep", state: state.schedule.installed ? "done" : "todo", detail: state.schedule.installed ? `Every night at ${pad(state.schedule.hour)}:${pad(state.schedule.minute)}` : "Not scheduled", how: "performed" },
    { id: "remote", title: "Remote (Worker)", state: state.workerUrl ? "done" : "optional", detail: state.workerUrl ?? "Optional: reach your memory from anywhere", how: "guided" },
  ];

  return {
    kind: "local",
    async status(): Promise<LocalSetupStatus> {
      return {
        kind: "local",
        items: items(),
        vault: state.vault,
        defaults: { dir: "~/vaults/my-campaign", timezone: "Europe/Lisbon", seeds: ["example-relocation"], domains: ["residency", "housing", "university", "career", "finance", "health", "story"] },
        secrets: { identityFile: "~/.config/hippocampus/age-identity.txt", identity: state.identity, recipient: state.identity ? "age1demo…" : undefined, matches: state.identity },
        llm: { ...state.llm, overriddenBy: [] },
        git: { repo: true, branch: "main", ghAvailable: false, dirty: 0 },
        schedule: schedule(),
        remote: { workerUrl: state.workerUrl },
        agents: agents(),
        unknownAgents: opts.unknownAgents ?? [],
        envFile: "~/.config/hippocampus/env",
      };
    },
    async handle(method, path, body) {
      const b = (body ?? {}) as Record<string, unknown>;
      if (method === "POST" && path === "vault") {
        const req = b as unknown as VaultSetupRequest;
        if (req.action === "create" || req.action === "open") state.vault = { ...state.vault, dir: req.dir };
        return { ok: true, demo: true };
      }
      if (method === "POST" && path === "secrets") {
        state.identity = true;
        return { recipient: "age1demo…", identityFile: "~/.config/hippocampus/age-identity.txt" };
      }
      if (path === "llm" && method === "GET") return { ...state.llm, overriddenBy: [] };
      if (path === "llm" && method === "POST") {
        const req = b as unknown as LlmSetupRequest;
        state.llm = { provider: req.provider, model: req.model, baseURL: req.baseURL, apiKey: req.apiKey === null ? "unset" : req.apiKey ? "set" : state.llm.apiKey };
        return { ...state.llm, overriddenBy: [] };
      }
      if (path === "llm/models") return { servers: [{ name: "LM Studio", url: "http://127.0.0.1:1234/v1", models: ["qwen/qwen3.5-9b", "google/gemma-4-26b-a4b-qat"] }] };
      if (path === "llm/test") return { ok: true, model: state.llm.model, ms: 840 };
      if (path === "git" && method === "GET") return { repo: true, branch: "main", ghAvailable: false, dirty: 0 };
      if (path === "git/visibility") return { visibility: "unknown" };
      if (path === "schedule" && method === "GET") return schedule();
      if (path === "schedule" && method === "POST") {
        if (b.remove) state.schedule.installed = false;
        else state.schedule = { installed: true, hour: Number(b.hour ?? 3), minute: Number(b.minute ?? 30) };
        return schedule();
      }
      if (path === "jobs" && method === "POST") {
        const id = `job-${state.jobs.size + 1}`;
        const job: Job = {
          id,
          kind: b.kind === "reindex" ? "reindex" : "sleep-dry-run",
          state: "done",
          started: new Date().toISOString(),
          log: ["⚖ no pending rulings", "… ep-demo (residency-agent): Agency confirmed the appointment by email", "  ✓ touched migration-agency, residence-permit", "dry run: nothing written"],
          summary: "Dry run: 1 episode would be consolidated, nothing written.",
        };
        state.jobs.set(id, job);
        return { id };
      }
      if (path.startsWith("jobs/") && method === "GET") {
        const job = state.jobs.get(path.slice(5));
        if (!job) throw new HttpError(404, "No such job", "NOT_FOUND");
        return job;
      }
      if (path === "remote/check") return { mcp: true, oauth: true, dashboard: true };
      if (path === "remote" && method === "POST") {
        state.workerUrl = typeof b.workerUrl === "string" ? b.workerUrl : undefined;
        return { ok: true };
      }
      throw new HttpError(404, `No such setup route: ${method} ${path}`, "NOT_FOUND");
    },
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

function nextRun(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
