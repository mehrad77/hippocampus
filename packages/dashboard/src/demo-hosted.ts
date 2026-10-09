import { HttpError, errorResponse, json, readJson, securityHeaders } from "./http.ts";
import type { HostedConnectedApp, HostedCuratorActionsResult, HostedInitResult, HostedKeyInfo, HostedMintedKey, HostedRepo, HostedSessionInfo, HostedSetupStatus, HostedVault, SetupItem, Snippet } from "./setup.ts";
import { capabilities, type CuratorStatus, type DashboardSource, type SessionInfo } from "./source.ts";

// The hosted app for `astro dev` (HIPPO_DEMO_HOSTED=1): an in-memory stand-in for the Worker's
// sign-in, onboarding, admin, account and curator routes, so every onboarding step can be walked
// and screenshotted without GitHub. Once the pretend vault is set up, the demo campaign answers
// everything else. All names are fictional (seeds/example-relocation).
//
//   signed out → waitlisted → (asks; approved a few seconds later) → installed → vault ready → keys
//
// `GET <base>/api/__demo/stage?to=<stage>` jumps straight to a stage: signed-out, waitlisted,
// requested, approved, installed, ready.

export type HostedDemoStage = "signed-out" | "waitlisted" | "requested" | "approved" | "installed" | "ready";

export interface HostedDemoOptions {
  /** Where the dashboard lives, e.g. `/dashboard`. */
  base: string;
  /** The demo campaign, served once the pretend vault is ready. */
  source: DashboardSource;
  /** How long a waitlist request waits before the demo approves it (ms). */
  approveAfter?: number;
  /** How long `init` pretends to take (ms). */
  initDelay?: number;
  now?: () => Date;
}

type DemoRepo = HostedRepo & { adoptable?: boolean };
type AccountStatus = "waitlisted" | "approved" | "denied" | "deleted";
interface DemoAccount {
  id: number;
  login: string;
  status: AccountStatus;
  note?: string;
  created: string;
  updated: string;
  admin: boolean;
}

const LOGIN = "player";
const USER_ID = 1001;
const STAGES: HostedDemoStage[] = ["signed-out", "waitlisted", "requested", "approved", "installed", "ready"];

const REPOS: DemoRepo[] = [
  { id: 501, fullName: `${LOGIN}/vault`, private: true, empty: true },
  { id: 502, fullName: `${LOGIN}/lisbon-arc`, private: true, empty: false, adoptable: true },
  { id: 503, fullName: `${LOGIN}/dotfiles`, private: true, empty: false, adoptable: false },
  { id: 504, fullName: `${LOGIN}/harbor-notes`, private: false },
];

/** A handler for the hosted routes; undefined means "not mine" (the regular demo API answers). */
export function hostedDemo(opts: HostedDemoOptions): (request: Request) => Promise<Response | undefined> {
  const { base, source } = opts;
  const api = `${base}/api`;
  const now = opts.now ?? (() => new Date());
  const ago = (ms: number) => new Date(now().getTime() - ms).toISOString();
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const origin = (request: Request) => new URL(request.url).origin;

  const fresh = () => ({
    signedIn: false,
    status: "waitlisted" as AccountStatus,
    note: undefined as string | undefined,
    admin: false,
    installation: undefined as { id: number } | undefined,
    vault: undefined as HostedVault | undefined,
    keys: [] as HostedKeyInfo[],
    curatorActions: false,
    apps: [] as HostedConnectedApp[],
    run: undefined as CuratorStatus["run"],
    history: [] as CuratorStatus["history"],
    others: [
      { id: 2001, login: "harbor-student", status: "waitlisted", note: "Starting at Harbor University in the spring; my agents keep losing track of deadlines.", created: ago(2 * DAY), updated: ago(2 * DAY), admin: false },
      { id: 2002, login: "lisbon-newcomer", status: "waitlisted", created: ago(5 * HOUR), updated: ago(5 * HOUR), admin: false },
      { id: 2003, login: "player-two", status: "approved", note: "Same move, different family.", created: ago(20 * DAY), updated: ago(19 * DAY), admin: false },
      { id: 2004, login: "campus-visitor", status: "denied", note: "Just looking around.", created: ago(12 * DAY), updated: ago(11 * DAY), admin: false },
    ] as DemoAccount[],
  });
  let state = fresh();
  let approval: ReturnType<typeof setTimeout> | undefined;

  const approve = () => {
    state.status = "approved";
    // The demo makes you its admin too, so the admin page has someone to show it to.
    state.admin = true;
  };

  const ready = () => state.vault?.status === "ready";

  /** Curator runs for a vault that has been around a while: two finished, one that ran out of time, one going now. */
  const seedCurator = () => {
    state.history = [
      { id: "run-3", curator: "archivist", model: "claude-sonnet-4-5", started: ago(DAY + 6 * 60_000), ended: ago(DAY), outcome: "done", consolidated: 9, failed: 0, skipped: 1, summaries: 4, remaining: 0, commits: 3 },
      { id: "run-2", curator: "archivist", model: "claude-sonnet-4-5", started: ago(2 * DAY + 5 * 60_000), ended: ago(2 * DAY), outcome: "done", consolidated: 6, failed: 1, skipped: 0, summaries: 3, remaining: 0, commits: 2 },
      { id: "run-1", curator: "game-master", model: "qwen3.5-9b", started: ago(3 * DAY + 20 * 60_000), ended: ago(3 * DAY), outcome: "expired", consolidated: 2, failed: 0, skipped: 0, summaries: 0, remaining: 5, commits: 1 },
    ];
    state.run = { id: "run-4", curator: "archivist", model: "claude-sonnet-4-5", started: ago(3 * 60_000), leaseUntil: new Date(now().getTime() + 2 * 60_000).toISOString(), live: true, progress: { done: 3, total: 8, unit: "episode" } };
    state.apps = [{ id: "grant-1", client: "Claude", scopes: ["read", "remember"], agent: "home-finder", created: ago(DAY / 2) }];
  };

  const toStage = (stage: HostedDemoStage) => {
    clearTimeout(approval);
    state = fresh();
    const at = STAGES.indexOf(stage);
    if (at >= 1) state.signedIn = true;
    if (at >= 2) state.note = "Moving to Lisbon; I'd like my agents to share one memory.";
    if (at >= 3) approve();
    if (at >= 4) state.installation = { id: 9001 };
    if (at >= 5) {
      state.installation = undefined;
      state.vault = { id: "vault-demo", fullName: `${LOGIN}/vault`, branch: "main", status: "ready" };
      seedCurator();
    }
  };

  const me = (): DemoAccount => ({ id: USER_ID, login: LOGIN, status: state.status, note: state.note, created: ago(DAY), updated: ago(HOUR), admin: state.admin });

  function items(s: HostedSetupStatus): SetupItem[] {
    const a = s.account;
    const out: SetupItem[] = [
      a.status === "approved"
        ? { id: "access", title: "Access", state: "done", detail: `@${a.login} is approved`, how: "performed" }
        : { id: "access", title: "Access", state: a.requested ? "warn" : "todo", detail: a.requested ? "Requested; waiting for an admin to approve it" : "Ask for access", how: "performed" },
    ];
    if (a.status !== "approved") return out;
    const v = s.vault;
    out.push(
      v?.status === "ready" || s.installation
        ? { id: "install", title: "Install the GitHub App", state: "done", detail: v ? `Installed on ${v.fullName}` : "Installed; pick the repo next", how: "guided" }
        : { id: "install", title: "Install the GitHub App", state: "todo", detail: "Create an empty private repo, then install the app on it (only that repo)", how: "guided" },
    );
    out.push(v ? { id: "vault", title: "Vault", state: "done", detail: `${v.fullName}@${v.branch}`, how: "performed" } : { id: "vault", title: "Vault", state: "todo", detail: s.installation ? "Pick the repo and name the campaign" : "Install the app first", how: "performed" });
    if (v) {
      const n = s.keys?.length ?? 0;
      out.push({ id: "keys", title: "Agent keys", state: n ? "done" : "todo", detail: n ? `${n} ${n === 1 ? "key" : "keys"} issued` : "Mint a key for your agents (or connect Claude.ai or ChatGPT with the connector URL)", how: "performed" });
    }
    return out;
  }

  function status(request: Request): HostedSetupStatus {
    const publicUrl = origin(request);
    const s: HostedSetupStatus = {
      kind: "hosted",
      account: { login: LOGIN, status: state.status === "approved" ? "approved" : state.status === "denied" ? "denied" : "waitlisted", requested: state.note !== undefined, admin: state.admin },
      installUrl: `${api}/__demo/install`,
      newRepoUrl: `${api}/__demo/new-repo`,
      ...(state.installation && state.status === "approved" ? { installation: { id: state.installation.id, repos: REPOS.map(({ id, fullName, private: p }) => ({ id, fullName, private: p })) } } : {}),
      ...(state.vault ? { vault: state.vault, keys: state.keys, curatorActions: state.curatorActions } : {}),
      publicUrl,
      mcpUrl: `${publicUrl}/mcp`,
      items: [],
    };
    s.items = items(s);
    return s;
  }

  async function session(): Promise<SessionInfo | HostedSessionInfo> {
    const account = { status: state.status === "approved" ? ("approved" as const) : ("waitlisted" as const), admin: state.admin };
    if (!ready()) return { mode: "setup", user: { login: LOGIN }, account, capabilities: { ...capabilities(undefined, "hosted"), setup: "hosted" } };
    const info = await source.info();
    const v = state.vault!;
    return { ...info, mode: "worker", vault: { kind: "github", repo: v.fullName, branch: v.branch }, user: { login: LOGIN }, account, capabilities: { ...capabilities(source, "hosted"), curator: true } };
  }

  async function mint(request: Request, body: unknown): Promise<HostedMintedKey> {
    if (!ready()) throw new HttpError(409, "Your vault isn't ready, so it can't take new keys.", "NOT_READY");
    const b = (body ?? {}) as { kind?: unknown; label?: unknown; agent?: unknown; scopes?: unknown };
    const kind = b.kind;
    if (kind !== "agent" && kind !== "curator" && kind !== "bound") throw new HttpError(400, "kind: expected one of agent, curator, bound", "INVALID");
    const label = typeof b.label === "string" ? b.label.trim().slice(0, 80) : "";
    let agent: string | undefined;
    let scopes = kind === "curator" ? ["read", "curate"] : ["read", "remember", "quest"];
    if (kind === "bound") {
      agent = typeof b.agent === "string" ? b.agent.trim().toLowerCase() : "";
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(agent)) throw new HttpError(400, "agent: use lowercase letters, digits and dashes, like home-finder", "INVALID");
      const asked = Array.isArray(b.scopes) ? (b.scopes as unknown[]).map(String) : scopes;
      if (!asked.includes("read")) throw new HttpError(400, "scopes: every key needs read", "INVALID");
      scopes = scopes.filter((s) => asked.includes(s));
    }
    const token = `hippo_demo_${hex(16)}`;
    const key: HostedKeyInfo = { id: hex(32), kind, ...(agent ? { agent } : {}), scopes, label: label || (kind === "curator" ? "Curator" : kind === "bound" ? agent! : "Any agent"), created: now().toISOString() };
    state.keys.push(key);
    return { ...key, token, snippets: keySnippets(origin(request), token, kind) };
  }

  async function setupRoute(request: Request, method: string, sub: string, body: unknown): Promise<unknown> {
    if ((sub === "" || sub === "status") && method === "GET") return status(request);
    if (sub === "access" && method === "POST") {
      const note = (body as { note?: unknown } | undefined)?.note ?? "";
      if (typeof note !== "string" || note.length > 500) throw new HttpError(400, "note: up to 500 characters of text", "INVALID");
      if (state.status === "approved") throw new HttpError(409, "Your account is already approved.", "ALREADY_APPROVED");
      state.note = note.trim();
      clearTimeout(approval);
      approval = setTimeout(approve, opts.approveAfter ?? 6000);
      return { ok: true };
    }
    if (state.status !== "approved") throw new HttpError(403, "Your account is waiting for an admin's approval.", "NOT_APPROVED");
    if (sub === "repos" && method === "GET") {
      if (!state.installation) throw new HttpError(409, "Install the GitHub App on your vault repo first.", "NO_INSTALLATION");
      return { installation: state.installation, repos: REPOS };
    }
    if (sub === "init" && method === "POST") {
      if (ready()) throw new HttpError(409, `You already have a vault: ${state.vault!.fullName}.`, "HAS_VAULT");
      if (!state.installation) throw new HttpError(409, "Install the GitHub App on your vault repo first.", "NO_INSTALLATION");
      const b = (body ?? {}) as { repoId?: unknown; campaign?: unknown };
      const repo = REPOS.find((r) => r.id === b.repoId);
      if (!repo) throw new HttpError(404, "That repo isn't one the app was installed on. Add it to the installation on GitHub, or pick another.", "NOT_FOUND");
      if (typeof b.campaign !== "string" || !b.campaign.trim()) throw new HttpError(400, "campaign: a name, up to 120 characters", "INVALID");
      if (!repo.private) throw new HttpError(400, `${repo.fullName} is public: anyone could read this memory. Make it private on GitHub (Settings → Danger Zone → Change visibility), then try again.`, "PUBLIC_REPO");
      if (repo.empty === false && !repo.adoptable) throw new HttpError(409, `${repo.fullName} already has files; pick an empty repo (or one with only a README, LICENSE or .gitignore).`, "NOT_EMPTY");
      await new Promise((r) => setTimeout(r, opts.initDelay ?? 1200));
      state.installation = undefined;
      state.vault = { id: "vault-demo", fullName: repo.fullName, branch: "main", status: "ready" };
      seedCurator();
      const result: HostedInitResult = { vault: state.vault, mode: repo.adoptable ? "adopted" : "initialized" };
      return result;
    }
    if (sub === "keys" && method === "GET") return { keys: state.keys };
    if (sub === "keys" && method === "POST") return mint(request, body);
    if (sub === "keys/revoke" && method === "POST") {
      const id = (body as { id?: unknown } | undefined)?.id;
      state.keys = state.keys.filter((k) => k.id !== id);
      return { ok: true };
    }
    if (sub === "curator-actions" && method === "POST") {
      if (!ready()) throw new HttpError(409, "No vault yet: set one up first.", "NO_VAULT");
      state.curatorActions = !!(body as { enable?: unknown } | undefined)?.enable;
      const result: HostedCuratorActionsResult = { enabled: state.curatorActions, path: ".github/workflows/sleep.yml" };
      return result;
    }
    throw new HttpError(404, `No such setup route: ${method} ${sub}`, "NOT_FOUND");
  }

  function adminRoute(method: string, sub: string, body: unknown, url: URL): unknown {
    if (!state.admin) throw new HttpError(403, "Only admins can do that.", "ADMIN");
    const everyone = (): DemoAccount[] => [...(state.note !== undefined || state.status === "approved" ? [me()] : []), ...state.others];
    if (sub === "accounts" && method === "GET") {
      const want = url.searchParams.get("status");
      return { accounts: everyone().filter((a) => (want ? a.status === want : a.status !== "deleted")) };
    }
    const decision = /^accounts\/(approve|deny)$/.exec(sub)?.[1];
    if (decision && method === "POST") {
      const id = (body as { id?: unknown } | undefined)?.id;
      if (id === USER_ID) throw new HttpError(400, "Admins can't be denied; remove them from HIPPO_ADMINS first.", "INVALID");
      const a = state.others.find((x) => x.id === id);
      if (!a) throw new HttpError(404, "No such account", "NOT_FOUND");
      a.status = decision === "approve" ? "approved" : "denied";
      a.updated = now().toISOString();
      return { account: a };
    }
    if (sub === "vaults" && method === "GET") {
      const vaults = [
        ...(state.vault ? [{ id: state.vault.id, fullName: state.vault.fullName, status: state.vault.status, login: LOGIN, created: ago(HOUR) }] : []),
        { id: "vault-2003", fullName: "player-two/harbor-notes", status: "ready", login: "player-two", created: ago(19 * DAY) },
        { id: "vault-2005", fullName: "campus-visitor/vault", status: "disconnected", reason: "uninstalled", login: "campus-visitor", created: ago(11 * DAY) },
      ];
      return { vaults };
    }
    throw new HttpError(404, `No such admin route: ${method} ${sub}`, "NOT_FOUND");
  }

  function accountRoute(method: string, sub: string, body: unknown): unknown {
    if (sub === "" && method === "GET") return { id: USER_ID, login: LOGIN, status: state.status, admin: state.admin, ...(state.vault ? { vault: { id: state.vault.id, fullName: state.vault.fullName, status: state.vault.status } } : {}) };
    if (sub === "delete" && method === "POST") {
      const typed = (body as { confirm?: unknown } | undefined)?.confirm;
      if (typeof typed !== "string" || typed.trim().replace(/^@/, "").toLowerCase() !== LOGIN) throw new HttpError(400, `To delete your account, type your GitHub login (${LOGIN}) as confirm.`, "CONFIRM");
      toStage("signed-out");
      return { ok: true };
    }
    if (sub === "apps" && method === "GET") return { apps: state.apps };
    if (sub === "apps/revoke" && method === "POST") {
      const id = (body as { id?: unknown } | undefined)?.id;
      state.apps = state.apps.filter((a) => a.id !== id);
      return { ok: true };
    }
    throw new HttpError(404, `No such account route: ${method} ${sub}`, "NOT_FOUND");
  }

  function curatorStatus(): CuratorStatus {
    return { ...(state.run ? { run: state.run } : {}), history: state.history };
  }

  async function demoRoute(sub: string, url: URL): Promise<Response> {
    if (sub === "stage") {
      const to = url.searchParams.get("to") as HostedDemoStage;
      if (!STAGES.includes(to)) throw new HttpError(400, `to: one of ${STAGES.join(", ")}`, "INVALID");
      toStage(to);
      return redirect(to === "signed-out" ? `${base}/welcome/` : `${base}/setup/`);
    }
    if (sub === "install") {
      if (!state.signedIn) return redirect(`${base}/auth/login?return=${encodeURIComponent(`${base}/setup/#repo`)}`);
      if (state.status === "approved") state.installation = { id: 9001 };
      return redirect(`${base}/setup/#repo`);
    }
    if (sub === "new-repo")
      return page(
        "Create a repository (demo)",
        `<p>In the real app this is GitHub's new-repository form, filled in: named <code>vault</code>, private.</p><p>The demo pretends you made it. Close this tab and go on with <strong>Install the app</strong>.</p><p><a href="${base}/setup/#install">Back to setup</a></p>`,
      );
    throw new HttpError(404, "No such demo route", "NOT_FOUND");
  }

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if ((path === `${base}/` || path === base) && method === "GET") return state.signedIn ? undefined : redirect(`${base}/welcome/`);
      if (path === `${base}/auth/login`) {
        if (method !== "GET") throw new HttpError(405, "Method not allowed", "METHOD");
        state.signedIn = true;
        const back = url.searchParams.get("return") ?? `${base}/setup/`;
        return redirect(back.startsWith(`${base}/`) && !back.startsWith("//") ? back : `${base}/setup/`);
      }
      if (path === `${base}/auth/logout`) {
        if (method !== "POST") throw new HttpError(405, "Method not allowed", "METHOD");
        state.signedIn = false;
        return new Response(null, { status: 204, headers: securityHeaders() });
      }
      if (!path.startsWith(`${api}/`)) return undefined;
      const rest = path.slice(api.length + 1).replace(/\/+$/, "");
      if (rest.startsWith("__demo/")) return await demoRoute(rest.slice("__demo/".length), url);
      if (!state.signedIn) throw new HttpError(401, "Sign in with GitHub to continue.", "SIGN_IN", { login: `${base}/auth/login` });
      const [section = ""] = rest.split("/");
      const sub = rest.slice(section.length).replace(/^\//, "");
      if (rest === "session") return json(200, await session());
      if (method !== "GET" && method !== "POST") throw new HttpError(405, "Method not allowed", "METHOD");
      const body = method === "POST" ? await readJson(request) : undefined;
      if (section === "setup") return json(200, await setupRoute(request, method, sub, body));
      if (section === "admin") return json(200, adminRoute(method, sub, body, url));
      if (section === "account") return json(200, accountRoute(method, sub, body));
      if (!ready()) throw new HttpError(409, "No vault yet: finish setting one up first.", "NO_VAULT");
      if (rest === "curator" && method === "GET") return json(200, curatorStatus());
      if (rest === "actions/curator" && method === "POST") {
        const run = (body as { abort?: unknown } | undefined)?.abort;
        if (!state.run || state.run.id !== run) throw new HttpError(409, "That run isn't open anymore.", "NO_RUN");
        const r = state.run;
        state.history.unshift({ id: r.id, curator: r.curator, model: r.model, started: r.started, ended: now().toISOString(), outcome: "aborted", consolidated: r.progress.done, failed: 0, skipped: 0, summaries: 0, remaining: r.progress.total - r.progress.done, commits: 1 });
        state.run = undefined;
        return json(200, curatorStatus());
      }
      return undefined;
    } catch (err) {
      return errorResponse(err);
    }
  };
}

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...securityHeaders() } });
}

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...securityHeaders(), "content-security-policy": "default-src 'none'; frame-ancestors 'none'" } });
}

/** The same connect snippets the Worker sends with a new key (apps/worker/src/hosted/onboarding.ts). */
function keySnippets(publicUrl: string, token: string, kind: HostedKeyInfo["kind"]): Snippet[] {
  const mcp = `${publicUrl}/mcp`;
  const auth = `Bearer ${token}`;
  const name = kind === "curator" ? "hippocampus-curator" : "hippocampus";
  const snippets: Snippet[] = [
    { label: "Claude Code", lang: "bash", code: `claude mcp add --transport http ${name} ${mcp} --header "Authorization: ${auth}"` },
    { label: "Any MCP client over HTTP (.mcp.json)", lang: "json", code: JSON.stringify({ mcpServers: { [name]: { type: "http", url: mcp, headers: { Authorization: auth } } } }, null, 2) },
    { label: "Cursor (~/.cursor/mcp.json)", lang: "json", code: JSON.stringify({ mcpServers: { [name]: { url: mcp, headers: { Authorization: auth } } } }, null, 2) },
    { label: "VS Code (.vscode/mcp.json)", lang: "json", code: JSON.stringify({ servers: { [name]: { type: "http", url: mcp, headers: { Authorization: auth } } } }, null, 2) },
  ];
  if (kind !== "curator") snippets.push({ label: "Claude.ai or ChatGPT (custom connector)", lang: "text", code: mcp, note: "Connectors sign in with GitHub instead of a key: add a custom connector with this URL." });
  return snippets;
}
