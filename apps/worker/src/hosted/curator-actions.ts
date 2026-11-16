import { StoreConflictError } from "@hippocampus/core";
import { ACTIONS_SECRETS, HttpError, type HostedActionsRun, type HostedActionsSecret, type HostedCuratorActionsResult, type HostedCuratorActionsState } from "@hippocampus/dashboard";
import { GitHubStore } from "@hippocampus/store-github";
import { VAULT_PERMISSIONS, bootstrapCommit, explain } from "./bootstrap.ts";
import { GitHubAppError, type GitHubApp, type Permissions } from "./github-app.ts";
import type { VaultRecord } from "./registry.ts";
import { sealForGitHub } from "./sealed-box.ts";
import { SLEEP_WORKFLOW, SLEEP_WORKFLOW_PATH, bakedMcpUrl, bakedModel, sleepWorkflow } from "./sleep-workflow.ts";

// The vault's nightly sleep on GitHub Actions, for people without an agent of their own to run it:
// a workflow in their vault repo that has Claude curate through the vault's MCP server. It never
// checks the repo out, and its GitHub token can't read it: Claude sees only what the curator key shows.
// The workflow carries the vault's address and model itself; the app sets its secrets, and
// dispatches and lists its runs, each with a token narrowed to the permissions that call needs.
// (No repository variables: an installation token can't be narrowed to the Variables permission.)

export { SLEEP_WORKFLOW, SLEEP_WORKFLOW_PATH, sleepWorkflow };

const READ_ONLY: Permissions = { metadata: "read", contents: "read" };
export const ACTIONS_READ: Permissions = { metadata: "read", secrets: "read", actions: "read" };
export const ACTIONS_WRITE_SECRETS: Permissions = { metadata: "read", secrets: "write" };
export const ACTIONS_DISPATCH: Permissions = { metadata: "read", actions: "write" };
/** A model the workflow runs when nothing says otherwise. */
export const DEFAULT_ACTIONS_MODEL = "sonnet";

/** The `app` tag on curator keys the app mints for Actions: replacing the secret revokes the key it held. */
export const ACTIONS_CURATOR_APP = "github-actions";
const WORKFLOW_FILE = SLEEP_WORKFLOW_PATH.split("/").pop()!;

function store(app: GitHubApp, vault: VaultRecord, permissions: Permissions): GitHubStore {
  const token = app.tokenSource(vault.installationId, { repositoryIds: [vault.repoId], permissions });
  return new GitHubStore({ repo: vault.fullName, branch: vault.branch, token, fetch: app.fetch, apiUrl: app.apiUrl });
}

/** Whether the vault repo has the workflow. */
export async function curatorActionsEnabled(app: GitHubApp, vault: VaultRecord): Promise<boolean> {
  return (await workflowFile(app, vault)) !== undefined;
}

const workflowFile = (app: GitHubApp, vault: VaultRecord) => store(app, vault, READ_ONLY).read(SLEEP_WORKFLOW_PATH);

/** The workflow this vault should have: its address, and the model asked for, else the one it has, else the default. */
const wanted = (current: string | undefined, mcpUrl: string, model?: string) => sleepWorkflow({ mcpUrl, model: model ?? (current && bakedModel(current)) ?? DEFAULT_ACTIONS_MODEL });

/**
 * Add, bring up to date (a newer text, another model, the vault's address) or remove the workflow:
 * one commit, only when the file would change. Writing a workflow needs the app's Workflows permission.
 */
export async function setCuratorActions(app: GitHubApp, vault: VaultRecord, enable: boolean, o: { mcpUrl: string; model?: string }): Promise<HostedCuratorActionsResult & { model?: string }> {
  const s = store(app, vault, VAULT_PERMISSIONS);
  let model: string | undefined;
  try {
    const current = await s.read(SLEEP_WORKFLOW_PATH);
    if (enable) {
      const text = wanted(current, o.mcpUrl, o.model);
      model = bakedModel(text);
      if (current !== text)
        await s.apply(
          [{ path: SLEEP_WORKFLOW_PATH, content: text }],
          bootstrapCommit(current === undefined ? "chore: run sleep nightly on GitHub Actions" : "chore: update the nightly sleep workflow"),
        );
    }
    if (!enable && current !== undefined) await s.apply([{ path: SLEEP_WORKFLOW_PATH, remove: true }], bootstrapCommit("chore: stop running sleep on GitHub Actions"));
  } catch (err) {
    if (err instanceof StoreConflictError) throw new HttpError(409, "The workflow changed on GitHub just now; try again.", "CONFLICT");
    throw explain(err, vault.fullName);
  }
  return { enabled: enable, path: SLEEP_WORKFLOW_PATH, ...(model ? { model } : {}) };
}

/** The workflow's model and address as written in it, and whether it's the text this vault should have. */
function workflowFacts(text: string, mcpUrl: string): NonNullable<HostedCuratorActionsState["workflow"]> & { outdated: boolean } {
  const model = bakedModel(text);
  const address = bakedMcpUrl(text);
  return { ...(model ? { model } : {}), ...(address ? { mcpUrl: address } : {}), outdated: text !== wanted(text, mcpUrl) };
}

/** Why a token is refused: the owner hasn't approved new permissions (`owner`), or the App doesn't ask for them yet (`operator`). */
export type PermissionGap = { repo: string; settingsUrl: string; who: "owner" | "operator"; missing: string[] };

/** What a call needs and isn't granted: the owner approves it on GitHub at `settingsUrl`, or the operator adds it to the App. */
export const needsPermission = (gap: PermissionGap) =>
  new HttpError(
    403,
    gap.who === "operator"
      ? `This Hippocampus's GitHub App can't manage Actions secrets and runs yet: its operator has to add those permissions.`
      : `Hippocampus needs permission to manage Actions secrets and runs on ${gap.repo}. Approve it on GitHub.`,
    "NEEDS_PERMISSION",
    gap,
  );

const allows = (granted: string | undefined, wanted: string) => granted === "write" || granted === wanted;

/**
 * The repo's Actions API through one narrowed token. Minting the token is what fails when the
 * installation lacks a permission (GitHub answers 422), so `ready()` mints it before anything else.
 */
export class ActionsApi {
  private readonly token: (opts?: { refresh?: boolean }) => Promise<string>;

  constructor(
    private readonly app: GitHubApp,
    private readonly vault: VaultRecord,
    private readonly permissions: Permissions,
    private readonly settingsUrl: string,
  ) {
    this.token = app.tokenSource(vault.installationId, { repositoryIds: [vault.repoId], permissions });
  }

  async ready(): Promise<void> {
    try {
      await this.token();
    } catch (err) {
      if (err instanceof GitHubAppError && err.status === 422) throw await this.whyRefused(err);
      throw explain(err, this.vault.fullName);
    }
  }

  /**
   * GitHub's 422 says only that it won't grant the token. What the installation and the App have
   * says whose move it is; when both have everything asked, it's something else, said as itself.
   */
  private async whyRefused(err: GitHubAppError): Promise<HttpError> {
    const granted = await this.app.grantedPermissions(this.vault.installationId).catch(() => undefined);
    // An organization's installation lives under /organizations/<org>/settings/…, a person's under /settings/….
    const settingsUrl =
      granted?.account?.type === "Organization" ? this.settingsUrl.replace("/settings/installations/", `/organizations/${encodeURIComponent(granted.account.login)}/settings/installations/`) : this.settingsUrl;
    const gap = (who: PermissionGap["who"], missing: string[]) => needsPermission({ repo: this.vault.fullName, settingsUrl, who, missing });
    // Couldn't ask: a missing approval is by far the likeliest reason.
    if (!granted) return gap("owner", []);
    const lacking = (have: Record<string, string>) => Object.entries(this.permissions).filter(([k, v]) => !allows(have[k], v)).map(([k]) => k);
    const appLacks = lacking(granted.app);
    if (appLacks.length) return gap("operator", appLacks);
    const installationLacks = lacking(granted.installation);
    if (installationLacks.length) return gap("owner", installationLacks);
    return new HttpError(502, `GitHub wouldn't make a token for ${this.vault.fullName}'s Actions settings, though the app has the permissions: ${err.message}`, "TOKEN_REFUSED");
  }

  private refused(): HttpError {
    return needsPermission({ repo: this.vault.fullName, settingsUrl: this.settingsUrl, who: "owner", missing: [] });
  }

  /** One call; `allow` lists statuses that aren't failures (a 404 on a delete, say). */
  private async call(method: string, path: string, body?: unknown, allow: number[] = []): Promise<Response> {
    const res = await this.app.fetch(`${this.app.apiUrl}/repos/${this.vault.fullName}/${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${await this.token()}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "hippocampus",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok || allow.includes(res.status)) return res;
    // A token that minted but still can't: the same fix as a refused token.
    if (res.status === 403) throw this.refused();
    // GitHub's own words, never a value of ours (those go sealed, and only in request bodies).
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {}
    throw new HttpError(502, `GitHub answered ${res.status} to ${method} ${path.replace(/\?.*$/, "")}: ${message.slice(0, 200)}`, "GITHUB");
  }

  /** Seal `value` with the repo's current public key and store it as secret `name`. */
  async putSecret(name: HostedActionsSecret, value: string, key?: { key_id: string; key: string }): Promise<void> {
    const k = key ?? (await this.publicKey());
    await this.call("PUT", `actions/secrets/${name}`, { encrypted_value: sealForGitHub(value, k.key), key_id: k.key_id });
  }

  async publicKey(): Promise<{ key_id: string; key: string }> {
    return (await (await this.call("GET", "actions/secrets/public-key")).json()) as { key_id: string; key: string };
  }

  /** Whether there was one to delete; gone already counts as deleted. */
  async deleteSecret(name: HostedActionsSecret): Promise<boolean> {
    return (await this.call("DELETE", `actions/secrets/${name}`, undefined, [404])).status !== 404;
  }

  /** Which of the workflow's secrets are set: names only, as GitHub lists them. */
  async secrets(): Promise<HostedActionsSecret[]> {
    const body = (await (await this.call("GET", "actions/secrets?per_page=100")).json()) as { secrets?: { name: string }[] };
    const names = new Set((body.secrets ?? []).map((s) => s.name));
    return ACTIONS_SECRETS.filter((n) => names.has(n));
  }

  /** The workflow's last five runs; none while GitHub doesn't know the workflow (it isn't on the branch). */
  async runs(): Promise<HostedActionsRun[]> {
    const res = await this.call("GET", `actions/workflows/${WORKFLOW_FILE}/runs?per_page=5`, undefined, [404]);
    if (res.status === 404) return [];
    const body = (await res.json()) as { workflow_runs?: { id: number; status: string; conclusion: string | null; created_at: string; html_url: string; event: string }[] };
    return (body.workflow_runs ?? []).slice(0, 5).map((r) => ({ id: r.id, status: r.status, conclusion: r.conclusion, created: r.created_at, url: r.html_url, event: r.event }));
  }

  /** Run the workflow now, on the vault's branch. */
  async dispatch(): Promise<void> {
    const res = await this.call("POST", `actions/workflows/${WORKFLOW_FILE}/dispatches`, { ref: this.vault.branch }, [404]);
    if (res.status === 404) throw new HttpError(409, "The workflow isn't in the repository: turn the Actions curator on first.", "NOT_ENABLED");
  }
}

/**
 * The card's checklist and runs. A GitHub error in one part leaves only that part out, and a missing
 * permission is a state of its own, never an error: setup must load whatever GitHub says.
 */
export async function curatorActionsState(app: GitHubApp, vault: VaultRecord, o: { mcpUrl: string; settingsUrl: string }): Promise<HostedCuratorActionsState> {
  const file = await workflowFile(app, vault).then(
    (f) => ({ known: true as const, f }),
    () => ({ known: false as const }),
  );
  const facts = file.known && file.f !== undefined ? workflowFacts(file.f, o.mcpUrl) : undefined;
  const base: HostedCuratorActionsState = {
    mcpUrl: o.mcpUrl,
    ...(file.known ? { enabled: file.f !== undefined } : {}),
    ...(facts ? { workflow: { ...(facts.model ? { model: facts.model } : {}), ...(facts.mcpUrl ? { mcpUrl: facts.mcpUrl } : {}) }, ...(facts.outdated ? { outdated: true } : {}) } : {}),
  };
  const api = new ActionsApi(app, vault, ACTIONS_READ, o.settingsUrl);
  const gapOf = (err: unknown) => (err instanceof HttpError && err.code === "NEEDS_PERMISSION" ? (err.extra as PermissionGap) : undefined);
  const withGap = (g: PermissionGap): HostedCuratorActionsState => ({ ...base, needsPermission: { repo: g.repo, settingsUrl: g.settingsUrl, who: g.who } });
  try {
    await api.ready();
  } catch (err) {
    const g = gapOf(err);
    return g ? withGap(g) : base;
  }
  const quiet = <T,>(p: Promise<T>) => p.catch((err: unknown) => gapOf(err) ?? undefined);
  const [secrets, runs] = await Promise.all([quiet(api.secrets()), quiet(api.runs())]);
  const gap = [secrets, runs].find((x): x is PermissionGap => !!x && typeof x === "object" && "settingsUrl" in x);
  if (gap) return withGap(gap);
  return {
    ...base,
    ...(secrets ? { secrets: secrets as HostedActionsSecret[] } : {}),
    ...(runs ? { runs: runs as HostedActionsRun[] } : {}),
  };
}

/** The most a credential may be: Claude's tokens and keys are around a hundred characters. */
const MAX_CREDENTIAL = 512;

/** A pasted credential, trimmed and shape-checked (never sent anywhere to be checked). */
export function credential(raw: unknown, field: "claudeToken" | "apiKey"): string {
  const what = field === "claudeToken" ? "your Claude subscription token" : "your Anthropic API key";
  if (typeof raw !== "string") throw new HttpError(400, `${field}: ${what}, as text`, "INVALID");
  const v = raw.trim();
  if (!v) throw new HttpError(400, `${field}: paste ${what}`, "INVALID");
  if (v.length > MAX_CREDENTIAL || /\s/.test(v)) throw new HttpError(400, `${field}: that doesn't look like ${what} (one line, no spaces, up to ${MAX_CREDENTIAL} characters)`, "INVALID");
  if (v.startsWith("hippo_")) throw new HttpError(400, `${field}: that's a Hippocampus key, not ${what}. Hippocampus makes the curator key for you.`, "INVALID");
  // The mix-up this card exists to prevent: each kind under the other's name.
  if (field === "apiKey" && v.startsWith("sk-ant-oat")) throw new HttpError(400, "apiKey: that's a Claude subscription token (from claude setup-token). Pick \"Claude subscription token\" instead.", "WRONG_KIND");
  if (field === "claudeToken" && v.startsWith("sk-ant-api")) throw new HttpError(400, "claudeToken: that's an Anthropic API key. Pick \"Anthropic API key\" instead.", "WRONG_KIND");
  return v;
}
