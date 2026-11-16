import { useEffect, useMemo, useRef, useState } from "react";
import { CURATION_PLACES } from "@hippocampus/dashboard/connect";
import { postJson } from "../../lib/api.ts";
import { invalidate, useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { plural, relTime } from "../../lib/format.ts";
import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import { switchVault } from "../../lib/vault.ts";
import type { AccountApp, HostedAgentClaim, HostedInitResult, HostedKeyInfo, HostedRepoView, HostedReposResponse, HostedStatus, SessionInfo } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { RelTime, SkeletonPanel } from "../../ui/Parts.tsx";
import { AddAgent } from "./AddAgent.tsx";
import { ChipsInput, Effects, ErrorCallout, Facts, Field, PresetPicker, refreshSetup, StateBadge, ToneTag, useAction, useHash, useScrollToHash } from "./common.tsx";
import { CurationSetup } from "./Connections.tsx";
import {
  connectionRows,
  draftProblems,
  draftReady,
  forNewVault,
  hostedConnected,
  hostedDefaultStep,
  hostedIndex,
  hostedLock,
  hostedNeighbors,
  hostedProvider,
  hostedRepos,
  hostedStepDef,
  hostedStepState,
  identityFileName,
  initRequest,
  keyGoesAlong,
  newDraft,
  pickedAdoptable,
  preselectRepo,
  repoVerdict,
  resolveSetupHash,
  STEP_ITEM,
  statusKey,
  visibleSteps,
  type CampaignDraft,
  type HostedContext,
  type HostedProvider,
  type HostedStepId,
} from "./hosted.ts";
import { domainProblem } from "./model.ts";
import { KeyFile, makeAgeKey } from "./SecretsPanel.tsx";
import { StepRailView } from "./StepRail.tsx";

/** What every hosted step body gets. */
interface HostedStepProps {
  session: SessionInfo;
  status: HostedStatus;
  ctx: HostedContext;
  /** The picked repo already holds a vault (`pickedAdoptable`): it's reconnected as it is, with nothing to fill in. */
  adopting: boolean;
  draft: CampaignDraft;
  setDraft: (fn: (d: CampaignDraft) => CampaignDraft) => void;
  picked?: number;
  setPicked: (id: number) => void;
  /** The host the vault will live on, and the person's choice of it. */
  host: HostedProvider;
  setProvider: (p: HostedProvider) => void;
  identity?: string;
  setIdentity: (id: string | undefined) => void;
  clearDraft: () => void;
  /** Whether the picker's checked repo list is still loading (it says which repos hold a vault). */
  checking: boolean;
  /** Curation by Hippocampus itself, with the person's own model key, once it exists: shown first in the curation step. */
  hostedCuration?: React.ReactNode;
}

const BODIES: Record<HostedStepId, (p: HostedStepProps) => React.ReactNode> = {
  access: AccessStep,
  repo: RepoStep,
  vault: VaultStep,
  agent: AgentStep,
  curate: CurateStep,
};

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The draft (vault settings, the picked repo and host, the key's *public* half) survives a reload or
 * GitHub's install and GitLab's consent round trips in sessionStorage. The private key is never stored anywhere.
 */
function useDraft(login: string) {
  const key = `hippo:hosted-draft:${login}`;
  const [state, setState] = useState<{ draft: CampaignDraft; picked?: number; provider?: HostedProvider }>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as { draft: CampaignDraft; picked?: number; provider?: HostedProvider } | null;
      if (saved?.draft) return { draft: { ...newDraft(localTimeZone(), login), ...saved.draft }, picked: saved.picked, provider: saved.provider };
    } catch {
      // Storage off or unreadable: start fresh.
    }
    return { draft: newDraft(localTimeZone(), login) };
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(state));
    } catch {
      // The draft lasts for this page only.
    }
  }, [key, state]);
  return {
    draft: state.draft,
    picked: state.picked,
    provider: state.provider,
    setProvider: (provider: HostedProvider) => setState((s) => ({ ...s, provider, picked: s.provider === provider ? s.picked : undefined })),
    setDraft: (fn: (d: CampaignDraft) => CampaignDraft) => setState((s) => ({ ...s, draft: fn(s.draft) })),
    setPicked: (picked: number) => setState((s) => ({ ...s, picked })),
    clear: () => {
      try {
        sessionStorage.removeItem(key);
      } catch {
        // Nothing stored.
      }
      setState({ draft: newDraft(localTimeZone(), login) });
    },
  };
}

/** GitLab's checked project list: no installation, just the projects. */
type GitLabReposResponse = { gitlab: { login: string }; repos: HostedRepoView[] };

/**
 * Hosted Session Zero in five steps: access (only while waitlisted), the repository, the vault (a name),
 * the first agent, and curation. Finishing lands on Home.
 */
export function HostedOnboarding({ session, status: initial, footer, adding, hostedCuration }: { session: SessionInfo; status: HostedStatus; footer?: React.ReactNode; adding?: boolean; hostedCuration?: React.ReactNode }) {
  const { t, v } = useTerms();
  const hash = useHash();
  const login = initial.account.login;
  const { draft, setDraft, picked, setPicked, provider, setProvider, clear } = useDraft(login);
  const [identity, setIdentity] = useState<string>();
  // Waiting on someone else (an admin, a bootstrap): look again every few seconds.
  const waiting = (initial.account.status === "waitlisted" && initial.account.requested) || initial.vault?.status === "bootstrapping";
  const live = useResource<HostedStatus>(statusKey(!!adding), { poll: waiting ? 15_000 : undefined });
  const fresh = live.data?.kind === "hosted" ? live.data : initial;
  // Adding a vault starts from nothing, whatever vault this tab shows.
  const status = adding ? forNewVault(fresh) : fresh;
  const ready = status.vault?.status === "ready";
  const apps = useResource<{ apps: AccountApp[] }>(ready ? "/account/apps" : null);
  const plain: HostedContext = { status, picked, draftReady: draftReady(draft), provider, apps: apps.data?.apps };
  const host = hostedProvider(plain);
  // The status lists repos unchecked. The picker's request also says which are empty or already hold a vault (an
  // existing vault is reconnected with nothing to fill in). GitHub's only for the installation the status names (a
  // reinstall makes a new one); GitLab's for the connected account.
  const github = useResource<HostedReposResponse>(host === "github" && status.installation ? "/setup/repos" : null);
  const gitlab = useResource<GitLabReposResponse>(host === "gitlab" && status.gitlab?.connected && !ready ? "/setup/repos?provider=gitlab" : null);
  let ctx = plain;
  if (host === "github" && github.data && status.installation && github.data.installation.id === status.installation.id) ctx = { ...plain, status: { ...status, installation: { ...status.installation, repos: github.data.repos } } };
  if (host === "gitlab" && gitlab.data && status.gitlab) ctx = { ...plain, status: { ...status, gitlab: { ...status.gitlab, repos: gitlab.data.repos } } };
  const checking = host === "github" ? !!status.installation && !github.data && !github.error : !!status.gitlab?.connected && !gitlab.data && !gitlab.error;
  const adopting = pickedAdoptable(ctx);
  const steps = visibleSteps(ctx);

  // The only repo that can become the vault (or the person's own disconnected one) is picked for them.
  const suggested = checking ? undefined : preselectRepo(ctx);
  useEffect(() => {
    if (picked === undefined && suggested !== undefined && !ready) setPicked(suggested);
  }, [suggested, picked, ready]);

  const target = resolveSetupHash(hash, { ready, adding });
  const parsed = target && "step" in target ? target.step : undefined;
  const lastStep = useRef<HostedStepId | undefined>(undefined);
  if (parsed) lastStep.current = parsed;
  const wanted = parsed ?? lastStep.current ?? hostedDefaultStep(ctx);
  // Access is only a step while it's shown.
  const current = steps.some((s) => s.id === wanted) ? wanted : hostedDefaultStep(ctx);
  const step = hostedStepDef(current, host);
  const lock = hostedLock(current, ctx);
  const state = hostedStepState(current, ctx);
  const itemId = STEP_ITEM[current];
  const item = itemId ? status.items.find((i) => i.id === itemId) : undefined;
  const { prev, next } = hostedNeighbors(current, steps);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useScrollToHash(hash, !!parsed);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const h = headingRef.current;
    if (!h) return;
    h.focus({ preventScroll: true });
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    h.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
  }, [current]);

  const Body = BODIES[current];
  const props: HostedStepProps = { session, status, ctx, adopting, draft, setDraft, picked, setPicked, host, setProvider, identity, setIdentity, clearDraft: clear, checking, hostedCuration };
  const noun = host === "gitlab" ? "GitLab project" : "GitHub repository";
  // The account, invites and look-and-feel aren't steps: they open below when asked for (the user menu's Account, #personalization).
  const below = target && "anchor" in target ? target.anchor : undefined;

  return (
    <div className="stack sz">
      <header className="page-head">
        <div>
          <div className="page-head__kicker">
            {t("sessionZero")}
            {session.campaign && !adding ? ` · ${session.campaign}` : ""}
          </div>
          <h1>{adding ? v("Add a vault", "Open another campaign") : ready ? v("Finish setting up", "Finish setting the table") : v("Get started", "Set the table")}</h1>
          <p className="page-head__lede">
            {v(
              `Your memory lives in a private ${noun} that you own. ${steps.length} steps connect it here, then your first agent. Nothing happens until you press a button, and every button says what it will do.`,
              `The campaign lives in a private ${noun} that you own. ${steps.length} steps open it here, then seat your first agent. Nothing happens until you press a button, and every button says what it will do.`,
            )}
          </p>
        </div>
        <span className="chip sz-where" title={`Signed in with GitHub as @${login}`}>
          <Icon name="github" size={14} /> @{login}
        </span>
      </header>

      <div className="sz-layout">
        <StepRailView steps={steps} current={current} stateOf={(id) => hostedStepState(id as HostedStepId, ctx)} />
        <section className="panel sz-step" aria-labelledby="sz-step-title">
          <header className="sz-step__head">
            <div className="sz-step__kicker">
              <Icon name={step.icon} size={16} /> Step {hostedIndex(current, steps) + 1} of {steps.length}
            </div>
            <div className="sz-step__titlerow">
              <h2 id="sz-step-title" ref={headingRef} tabIndex={-1}>
                {v(...step.title)}
              </h2>
              <StateBadge state={state} />
            </div>
            <p className="sz-step__lede">{adopting && current === "vault" && !ready ? "This repo already holds a vault. Reconnecting it adds only the rule files it's missing; your notes and settings stay as they are." : v(...step.lede)}</p>
            {item && !lock && state !== "done" && item.state !== "done" && item.detail && !(adopting && !status.vault) && (
              <p className="sz-step__status small">
                <span className="muted">Right now:</span> {item.detail}
              </p>
            )}
          </header>

          <div className="sz-step__body">
            {lock ? (
              <div className="sz-locked">
                <Icon name="lock" size={36} />
                <p>
                  <strong>Not yet.</strong> {v(...lock)}
                </p>
                <a className="btn btn--primary" href={`#${hostedDefaultStep(ctx)}`}>
                  <Icon name="chevron" /> To the step that needs you
                </a>
              </div>
            ) : (
              <Body {...props} />
            )}
          </div>

          <footer className="sz-step__nav">
            {prev ? (
              <a className="btn btn--ghost" href={`#${prev.id}`}>
                <Icon name="back" /> <span className="sz-step__navword">Back:</span> {v(...prev.title)}
              </a>
            ) : (
              <span />
            )}
            {next && (
              <a className="btn" href={`#${next.id}`}>
                <span className="sz-step__navword">Next: </span>
                {v(...next.title)} <Icon name="chevron" />
              </a>
            )}
          </footer>
        </section>
      </div>
      {below ? (
        footer
      ) : (
        <p className="small muted sz-center">
          <a href="#account">Your account and signing out</a> · <a href="#personalization">Personalization</a>
        </p>
      )}
    </div>
  );
}

// ── 1. Access ──────────────────────────────────────────────────────────────

function AccessStep({ status }: HostedStepProps) {
  const { v } = useTerms();
  const a = status.account;
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const action = useAction();

  if (a.status === "approved")
    return (
      <div className="callout callout--ok" role="status">
        <Icon name="check" />
        <div>
          <strong>You're in.</strong> @{a.login} is approved. Next, the repository your memory will live in.
        </div>
      </div>
    );
  if (a.status === "denied")
    return (
      <div className="callout callout--danger" role="alert">
        <Icon name="warn" />
        <div>
          <strong>Access wasn't granted for @{a.login}.</strong> If you think that's a mistake, ask the person who runs this Hippocampus.
        </div>
      </div>
    );

  const send = async () => {
    const res = await action.run(() => postJson<{ ok: boolean }>("/setup/access", { note: note.trim() }));
    if (!res) return;
    toast(a.requested ? "Note updated." : "Request sent.", "ok");
    setEditing(false);
    await refreshSetup();
  };

  if (a.requested && !editing)
    return (
      <div className="stack">
        <div className="callout callout--ok" role="status">
          <Icon name="hourglass" />
          <div className="stack sz-tight">
            <strong>{v("You're on the list.", "Your name is on the list.")}</strong>
            <span>An admin of this Hippocampus approves accounts by hand, so it can take a while.</span>
          </div>
        </div>
        <h3 className="sz-subhead">What happens next</h3>
        <ol className="sz-howto">
          <li>An admin looks at your request (your GitHub login and your note, nothing else).</li>
          <li>Once you're approved, this page unlocks the next steps by itself. Keep it open, or come back later and sign in with GitHub again.</li>
          <li>Until then nothing else happens: no repository is touched and nothing is installed.</li>
        </ol>
        <div className="row">
          <button type="button" className="btn btn--sm" onClick={() => setEditing(true)}>
            <Icon name="quill" size={16} /> Change your note
          </button>
        </div>
      </div>
    );

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <p>
        You're signed in as <strong>@{a.login}</strong>. Ask for access, and add a note if the admin might not know who you are.
      </p>
      <Field label="Note for the admin (optional)" hint={`Up to 500 characters. ${note.length ? `${note.length}/500` : ""}`}>
        {(f) => <textarea id={f.id} className="textarea" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby={f.describedBy} placeholder="Hi, it's me from the Lisbon move." />}
      </Field>
      <Effects
        items={[
          ["contacts", "this Hippocampus's admins, with your GitHub login and this note."],
          ["never", "touches your GitHub repositories."],
        ]}
      />
      {action.error !== undefined && <ErrorCallout error={action.error} />}
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={action.busy}>
          <Icon name="sparkle" /> {action.busy ? "Sending…" : a.requested ? "Update the note" : "Request access"}
        </button>
        {editing && (
          <button type="button" className="btn btn--ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// ── 2. Repository: create, install (or connect GitLab), pick ──────────────

/** GitHub or GitLab, when the instance offers both. */
function HostChoice({ status, host, setProvider }: Pick<HostedStepProps, "status" | "host" | "setProvider">) {
  if (!status.providers?.includes("gitlab")) return null;
  const locked = !!status.vault;
  return (
    <div className="field">
      <span className="label">Where will the vault live?</span>
      <div className="segmented" role="radiogroup" aria-label="Where the vault lives">
        {(["github", "gitlab"] as const).map((p) => (
          <label key={p} data-checked={host === p ? "" : undefined}>
            <input type="radio" name="hz-host" checked={host === p} disabled={locked} onChange={() => setProvider(p)} />
            <Icon name={p === "github" ? "github" : "link"} size={16} /> {p === "github" ? "GitHub" : "GitLab"}
          </label>
        ))}
      </div>
      <span className="hint">{locked ? "Your vault is already set up there." : "Either way it's a private repository that you own, and Hippocampus only reads and writes that one."}</span>
    </div>
  );
}

/** One part of the repository step, numbered, with whether it's done. */
function Task({ n, title, done, children }: { n: number; title: React.ReactNode; done: boolean; children: React.ReactNode }) {
  return (
    <section className="hz-task" data-done={done ? "" : undefined}>
      <h3 className="hz-task__head">
        <span className="hz-task__num" aria-hidden>
          {done ? <Icon name="check" size={14} /> : n}
        </span>
        <span>{title}</span>
        {done && <ToneTag tone="done" word="Done" compact />}
      </h3>
      <div className="hz-task__body stack sz-tight">{children}</div>
    </section>
  );
}

function RepoStep(p: HostedStepProps) {
  const { status, ctx, host } = p;
  const gitlab = host === "gitlab";
  const vault = status.vault;
  if (vault?.status === "ready")
    return (
      <div className="callout callout--ok" role="status">
        <Icon name="check" />
        <div>
          Your vault is <a href={href.repo(vault)}>{vault.fullName}</a>.
        </div>
      </div>
    );
  const connected = hostedConnected(ctx);
  return (
    <div className="stack">
      <HostChoice status={status} host={host} setProvider={p.setProvider} />
      {vault?.status === "disconnected" && (
        <div className="callout callout--danger" role="alert">
          <Icon name="warn" />
          <div className="stack sz-tight">
            <strong>Your vault {vault.fullName} is disconnected.</strong>
            <span>{status.items.find((i) => i.id === "vault")?.detail ?? (gitlab ? "Connect GitLab again, then pick it to reconnect it." : "Install the app on it again, then pick it to reconnect it.")}</span>
          </div>
        </div>
      )}
      <Task n={1} title={gitlab ? "Create a private project" : "Create a private repo"} done={connected || !!vault}>
        <p className="small">
          {gitlab ? "Empty, private, in your personal namespace. Public and internal projects are refused." : "Empty, private, on your personal account. Public repositories are refused."} Already have one, or an existing vault? Skip to the next part.
        </p>
        <div className="row">
          <a className="btn btn--sm" href={gitlab ? status.gitlab?.newRepoUrl : status.newRepoUrl} target="_blank" rel="noopener noreferrer">
            <Icon name={gitlab ? "link" : "github"} size={16} /> {gitlab ? "Create a private project on GitLab" : "Create a private repo on GitHub"} <Icon name="external" size={14} />
          </a>
        </div>
      </Task>
      <Task n={2} title={gitlab ? "Connect GitLab" : "Install the app on it"} done={connected && !(gitlab ? status.gitlab?.error : status.installation?.error)}>
        {gitlab ? <ConnectGitLab {...p} /> : <InstallGitHub {...p} />}
      </Task>
      <Task n={3} title={gitlab ? "Pick the project" : "Pick the repo"} done={!!p.picked && hostedRepos(ctx).some((r) => r.id === p.picked)}>
        {connected ? <RepoPicker {...p} /> : <p className="small muted">The {gitlab ? "projects" : "repos"} show here once {gitlab ? "GitLab is connected" : "the app is installed"}.</p>}
      </Task>
      <Effects
        items={[
          ["shows", gitlab ? "GitLab's new-project form. You create the project yourself; this page can't." : "GitHub's new-repository form. You create the repository yourself; this page can't."],
          ["contacts", gitlab ? "GitLab. Hippocampus signs in as you and keeps the connection sealed on its server." : "GitHub. The app asks to read and write the files (including workflow files) of the repositories you select."],
          ["never", gitlab ? "needs a password, or uses the connection for anything but the project you pick." : "sees repositories you don't select. Removing the app on GitHub disconnects the vault at once."],
        ]}
      />
    </div>
  );
}

function ConnectGitLab({ status }: HostedStepProps) {
  const gl = status.gitlab;
  return (
    <>
      {gl?.connected && !gl.error ? (
        <p className="small">
          Connected as <strong>@{gl.login}</strong>: {plural(gl.repos?.length ?? 0, "project")} could become your vault.
        </p>
      ) : (
        <p className="small">
          GitLab asks whether Hippocampus may use your account. It calls the permission <strong>api</strong>, its smallest one that can write files. Then it sends you back here. Revoke it any time under GitLab → Preferences → Applications.
        </p>
      )}
      {gl?.error && (
        <div className="callout callout--warn" role="alert">
          <Icon name="warn" />
          <div>
            <strong>{gl.connected ? "Connected, but your projects couldn't be listed." : "GitLab needs to be connected again."}</strong> {gl.error}
          </div>
        </div>
      )}
      <div className="row">
        <a className={`btn ${gl?.connected && !gl.error ? "btn--sm" : "btn--primary"}`} href={gl?.connectUrl ?? "/dashboard/setup/gitlab/connect"}>
          <Icon name="link" /> {gl?.connected || gl?.login ? "Connect GitLab again" : "Connect GitLab"}
        </a>
      </div>
    </>
  );
}

function InstallGitHub({ status }: HostedStepProps) {
  const inst = status.installation;
  return (
    <>
      {inst && !inst.error ? (
        <p className="small">The app can see {plural(inst.repos.length, "repository", "repositories")}.</p>
      ) : (
        <p className="small">
          On GitHub, install it on your personal account (@{status.account.login}). Under <em>Repository access</em>, choose <strong>Only select repositories</strong> and pick just that repo. GitHub sends you back here.
        </p>
      )}
      {inst?.error && (
        <div className="callout callout--warn" role="alert">
          <Icon name="warn" />
          <div>
            <strong>Installed, but its repositories couldn't be listed.</strong> {inst.error}
          </div>
        </div>
      )}
      <div className="row">
        <a className={`btn ${inst && !inst.error ? "btn--sm" : "btn--primary"}`} href={status.installUrl}>
          <Icon name="github" /> {inst || status.vault ? "Install it again, or change its repos" : "Install the app on GitHub"}
        </a>
      </div>
    </>
  );
}

function RepoPicker({ status, ctx, adopting, host, picked, setPicked, checking }: HostedStepProps) {
  const gitlab = host === "gitlab";
  if (checking) return <SkeletonPanel lines={3} />;
  const list = hostedRepos(ctx);
  const noun = gitlab ? "project" : "repository";
  return (
    <>
      {list.length === 0 ? (
        <div className="callout callout--warn">
          <Icon name="warn" />
          <div>
            {gitlab ? (
              <>
                <strong>No project is fit to become a vault.</strong> It has to be in your personal namespace, and you need Developer access or better.
              </>
            ) : (
              <>
                <strong>The app can't see any repositories.</strong> Add your vault repo to the installation on GitHub, then come back.
              </>
            )}
          </div>
        </div>
      ) : (
        <fieldset className="sz-fieldset">
          <legend className="sr-only">Which {noun} becomes your vault?</legend>
          <div className="hz-repos">
            {list.map((r) => {
              const verdict = repoVerdict(r, host);
              return (
                <label key={r.id} className="hz-repo" data-disabled={verdict.usable ? undefined : ""} data-checked={picked === r.id ? "" : undefined}>
                  <input type="radio" name="hz-repo" value={r.id} checked={picked === r.id} disabled={!verdict.usable} onChange={() => setPicked(r.id)} />
                  <span className="hz-repo__text">
                    <span className="hz-repo__name mono sz-break">{r.fullName}</span>
                    <span className="small muted">
                      {verdict.detail}
                      {r.pushedAt ? ` Pushed ${relTime(r.pushedAt)}.` : ""}
                    </span>
                  </span>
                  <ToneTag tone={verdict.tone} word={verdict.tag} title={verdict.detail} compact />
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      <p className="small muted">
        {gitlab ? (
          <>
            Missing one? Create it on GitLab, then <a href="">reload this list</a>. Projects in groups aren't offered.
          </>
        ) : (
          <>
            Missing one? <a href={status.installUrl}>Add it to the app's installation on GitHub</a>.
          </>
        )}
      </p>
      {picked !== undefined && list.some((r) => r.id === picked) && (
        <div className="row">
          <a className="btn btn--primary" href="#vault">
            {adopting ? "Reconnect this vault" : "Continue"} <Icon name="chevron" />
          </a>
        </div>
      )}
    </>
  );
}

// ── 3. Your vault: a name, then one commit ─────────────────────────────────

function VaultStep({ status, ctx, adopting, host, draft, setDraft, picked, identity, setIdentity, clearDraft }: HostedStepProps) {
  const { v } = useTerms();
  const action = useAction();
  const [tried, setTried] = useState(false);
  const zones = useMemo(() => (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []), []);
  const vault = status.vault;
  const repo: HostedRepoView | undefined = hostedRepos(ctx).find((r) => r.id === picked);
  if (vault?.status === "ready")
    return (
      <div className="callout callout--ok" role="status">
        <Icon name="check" />
        <div>
          <strong>Your vault is ready:</strong> <a href={href.repo(vault)}>{vault.fullName}</a>. Its settings are in <code>_hippo/config.yaml</code> there. <a href="#agent">Add your first agent →</a>
        </div>
      </div>
    );
  if (vault?.status === "bootstrapping")
    return (
      <div className="callout" role="status">
        <Icon name="hourglass" className="sz-spin" />
        <div>
          <strong>Setting up {vault.fullName}…</strong> This page checks again by itself.
        </div>
      </div>
    );

  const problems = draftProblems(draft);
  const show = (p: string | undefined) => (tried ? p : undefined);
  const set = <K extends keyof CampaignDraft>(k: K, value: CampaignDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const where = host === "gitlab" ? "GitLab" : "GitHub";

  const go = async () => {
    if (picked === undefined) return;
    const res = await action.run(() => postJson<HostedInitResult>("/setup/init", initRequest(draft, picked, { adopt: adopting, provider: host })));
    if (!res) return;
    if (res.recipientKept) toast("This vault already had its own secrets key, so the one you just made was not used. Keep using the key file that goes with the vault's.", "info");
    toast(res.mode === "adopted" ? (repo?.reconnect ? `Reconnected ${res.vault.fullName}.` : `Adopted ${res.vault.fullName}: your existing vault is connected.`) : v(`${res.vault.fullName} is your vault now.`, `${res.vault.fullName} holds the campaign now.`), "ok");
    setIdentity(undefined);
    clearDraft();
    // The session turns into a vault session; its new scope drops what was cached for the setup-only one.
    await invalidate((k) => k === "/session" || k.startsWith("/setup/status") || k === "/vaults");
    // This tab shows the new vault from now on (with `?add`, that's a page load out of the add flow).
    switchVault(res.vault.id, href.page("setup", "#agent"));
  };

  const disconnected = vault?.status === "disconnected" && (
    <div className="callout callout--warn" role="alert">
      <Icon name="warn" />
      <div>
        <strong>{vault.fullName} isn't connected.</strong> {status.items.find((i) => i.id === "vault")?.detail ?? "Try again."}
      </div>
    </div>
  );

  if (adopting && repo)
    return (
      <div className="stack">
        {disconnected}
        <Facts
          rows={[
            [host === "gitlab" ? "Project" : "Repository", <span className="mono sz-break">{repo.fullName}</span>],
            ["Settings", <span className="muted">kept as they are, from <code>_hippo/config.yaml</code></span>],
          ]}
        />
        <Effects
          items={[
            ["writes", <>one commit into <code>{repo.fullName}</code>, only if rule files for agents are missing. Your notes and settings are not touched.</>],
            ["contacts", host === "gitlab" ? "GitLab, through your GitLab connection." : "GitHub, through the app installed on that repository."],
          ]}
        />
        {action.error !== undefined && <ErrorCallout error={action.error} />}
        <div className="row">
          <button type="button" className="btn btn--primary" onClick={() => void go()} disabled={action.busy}>
            <Icon name={action.busy ? "hourglass" : "sparkle"} className={action.busy ? "sz-spin" : undefined} /> {action.busy ? "Reconnecting…" : `Reconnect ${repo.fullName}`}
          </button>
          <a className="btn btn--ghost btn--sm" href="#repo">
            Pick another {host === "gitlab" ? "project" : "repo"}
          </a>
        </div>
      </div>
    );

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (draftReady(draft)) void go();
      }}
    >
      {disconnected}
      <Field label={v("Name", "Campaign name")} hint="What this memory is about, e.g. “Lisbon Arc”." problem={show(problems.campaign)}>
        {(f) => <input id={f.id} className="input" value={draft.campaign} onChange={(e) => set("campaign", e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder="Lisbon Arc" maxLength={120} autoFocus />}
      </Field>
      <p className="small muted">
        You are <span className="mono">{draft.human || "?"}</span> in it, in {draft.timezone}, with the template's domains ({draft.domains.join(", ") || "none"}).
      </p>
      <details className="sz-details" open={tried && !!(problems.human || problems.timezone)}>
        <summary>More options: your id, time zone, domains, presets and the example</summary>
        <div className="sz-form">
          <Field label="Your id" hint={v("How notes and agents refer to you. Your edits outrank every agent's.", "How notes and agents refer to you. Your word outranks every agent's.")} problem={show(problems.human)}>
            {(f) => <input id={f.id} className="input mono" value={draft.human} onChange={(e) => set("human", e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} autoComplete="off" spellCheck={false} />}
          </Field>
          <Field label="Time zone" hint={v("Dates and the nightly update follow it.", "Dates and the nightly sleep follow it.")} problem={show(problems.timezone)}>
            {(f) => (
              <>
                <input id={f.id} className="input" value={draft.timezone} onChange={(e) => set("timezone", e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} list="hz-zones" autoComplete="off" spellCheck={false} />
                <datalist id="hz-zones">
                  {zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <div className="field">
            <span className="label">Start from</span>
            <label className="check">
              <input type="checkbox" checked={draft.seed} onChange={(e) => set("seed", e.target.checked)} />
              {v("Add the fictional example", "Add the example campaign")}
            </label>
            <span className="hint">{draft.seed ? v("A made-up move to Lisbon, with a residency agent, a home finder and others, to look around in.", "A made-up move to Lisbon, with a residency agent, a home finder and friends, to look around in.") : "An empty vault: just the template."}</span>
          </div>
          <ChipsInput label={v("Domains (areas of responsibility)", "Domains (your lanes)")} values={draft.domains} onChange={(d) => set("domains", d)} validate={domainProblem} placeholder="add a domain…" />
          <p className="hint sz-wide sz-flush">
            {v("Domains are the areas an agent can be the authority on, like housing or career. You choose who's responsible for what when you approve each agent.", "Domains are the lanes an agent can hold authority over, like housing or career. You choose who holds which when you seat each agent.")}
          </p>
          <PresetPicker presets={status.presets} value={draft.presets} onChange={(p) => set("presets", p)} />
        </div>
      </details>

      <SecretsKey draft={draft} set={set} identity={identity} setIdentity={setIdentity} />

      <Effects
        items={[
          [
            "writes",
            <>
              one commit into <code>{repo?.fullName ?? "the repo"}</code>: the vault template (folders for notes, <code>_hippo/config.yaml</code> with your choices, Obsidian templates, rules for agents and a validation workflow){draft.seed ? ", plus the example notes" : ""}
              {draft.presets.length ? `, plus the ${draft.presets.join(", ")} ${draft.presets.length === 1 ? "preset" : "presets"}` : ""}
              {keyGoesAlong(draft) ? ", and your secrets key's public half" : ", with no secrets key for now"}.
            </>,
          ],
          ["contacts", host === "gitlab" ? "GitLab, through your GitLab connection." : "GitHub, through the app installed on that repository."],
          ["never", "touches your other repositories, or sees the private secrets key."],
        ]}
      />
      {tried && !draftReady(draft) && (
        <p className="sz-problem" role="alert">
          {problems.campaign ?? "A few things need a look under More options."}
        </p>
      )}
      {action.error !== undefined && <ErrorCallout error={action.error} />}
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={action.busy || !repo}>
          <Icon name={action.busy ? "hourglass" : "sparkle"} className={action.busy ? "sz-spin" : undefined} /> {action.busy ? `Setting up… one commit to ${where}` : repo ? `Create the vault in ${repo.fullName} (one commit)` : "Create the vault"}
        </button>
        {!repo && <a href="#repo">Pick a {host === "gitlab" ? "project" : "repo"} first</a>}
      </div>
    </form>
  );
}

/**
 * The secrets key, made in this browser with age (X25519), preselected and never in the way: it goes into the vault
 * only once the person ticks that they saved its file. Only the public half (`age1…`) goes to the server.
 */
function SecretsKey({ draft, set, identity, setIdentity }: { draft: CampaignDraft; set: <K extends keyof CampaignDraft>(k: K, value: CampaignDraft[K]) => void; identity?: string; setIdentity: (id: string | undefined) => void }) {
  const { v } = useTerms();
  const [error, setError] = useState<unknown>();
  const making = useRef(false);
  const make = async () => {
    if (making.current) return;
    making.current = true;
    setError(undefined);
    try {
      const key = await makeAgeKey();
      setIdentity(key.identity);
      set("recipient", key.recipient);
      set("saved", false);
    } catch (err) {
      setError(err);
    } finally {
      making.current = false;
    }
  };
  // Preselected: the key is made as soon as it's chosen, so the file is one click away.
  useEffect(() => {
    if (draft.secrets === "create" && !draft.recipient) void make();
  }, [draft.secrets, draft.recipient]);

  return (
    <section className="hz-key" aria-labelledby="hz-key-title">
      <h3 className="sz-subhead" id="hz-key-title">
        <Icon name="key" size={18} /> Secrets key
      </h3>
      <p className="small">
        {v(
          "Passport numbers, account ids and passwords are encrypted before they're written into your vault. The key is made here and never leaves this browser: only its public half goes to your vault.",
          "Passport numbers, account ids and passwords are sealed before they're written into the vault. The key is forged here and never leaves this browser: only its public half goes to the vault.",
        )}
      </p>
      <div className="segmented" role="radiogroup" aria-label="Secrets key">
        <label data-checked={draft.secrets === "create" ? "" : undefined}>
          <input type="radio" name="hz-secrets" checked={draft.secrets === "create"} onChange={() => set("secrets", "create")} />
          <Icon name="key" size={16} /> {v("Make a key (recommended)", "Forge a key (recommended)")}
        </label>
        <label data-checked={draft.secrets === "skip" ? "" : undefined}>
          <input type="radio" name="hz-secrets" checked={draft.secrets === "skip"} onChange={() => set("secrets", "skip")} />
          Not now
        </label>
      </div>
      {draft.secrets === "skip" ? (
        <p className="hint">Fine for now. Agents' secret facts are held back until you add one under Setup → Secrets key.</p>
      ) : draft.recipient ? (
        <>
          <KeyFile recipient={draft.recipient} identity={identity} file={identityFileName(draft.campaign)} saved={draft.saved} setSaved={(saved) => set("saved", saved)} />
          {!draft.saved && <p className="hint">Not ticked, the vault starts without a key; you can add one later under Setup → Secrets key.</p>}
          <div className="row">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setIdentity(undefined);
                set("recipient", undefined);
                set("saved", false);
              }}
            >
              {v("Make a different key", "Forge a different key")}
            </button>
          </div>
        </>
      ) : (
        <p className="hint">{v("Making a key…", "Forging a key…")}</p>
      )}
      {error !== undefined && <ErrorCallout error={error} />}
      <details className="sz-more small">
        <summary>How to read secrets later</summary>
        <p>
          Save the file as <code>~/.config/hippocampus/age-identity.txt</code> (or set <code>HIPPO_AGE_IDENTITY_FILE</code> to where it is), then in a clone of your vault run <code>npx @mehrad77/hippocampus secrets show passport</code>. Without the file, nobody can read those secrets, not even you. The curator encrypts with the public half; only the file can decrypt.
        </p>
      </details>
    </section>
  );
}

// ── 4. Add your first agent ────────────────────────────────────────────────

function AgentStep({ status }: HostedStepProps) {
  const { t, v } = useTerms();
  return (
    <div className="stack">
      <AddAgent status={status} />
      <details className="sz-more small">
        <summary>What happens next</summary>
        <ol className="sz-howto">
          <li>
            The agent names itself, calls <code>onboard</code>, then <code>introduce</code>: it says who it is and what it handles.
          </li>
          <li>
            {v("It shows up on the ", "It takes a seat on the ")}
            <a href={href.page("party")}>{t("party")}</a> page at once. There you choose what it's responsible for.
          </li>
          <li>{v("Until you do, what it saves counts as unverified.", "Until you give it authority, what it remembers counts as rumor.")}</li>
        </ol>
      </details>
    </div>
  );
}

// ── 5. Curation ────────────────────────────────────────────────────────────

function CurateStep({ status, hostedCuration }: HostedStepProps) {
  const { t, v } = useTerms();
  const [choice, setChoice] = useState<"hosted" | "agent" | "advanced">(hostedCuration ? "hosted" : "agent");
  const options = [...(hostedCuration ? [["hosted", CURATION_PLACES[0].title] as const] : []), ["agent", "One of my agents"] as const, ["advanced", "Advanced: cron or Actions"] as const];
  return (
    <div className="stack">
      <p className="small">
        {v(
          <>Agents' notes land in the {t("satchel").toLowerCase()} first. The curator settles each fact by the rules (your word first, then the responsible agent, then agreement, then the newest), updates records, goals and the timeline, and empties the inbox. It sees secret memories.</>,
          <>The party's notes land in the satchel first. The curator settles each fact by precedence (your word, then lane authority, then corroboration, then recency), updates the codex, the quests and the chronicle, and empties the satchel. It sees secrets.</>,
        )}
      </p>
      <div className="segmented" role="radiogroup" aria-label="Who curates">
        {options.map(([id, word]) => (
          <label key={id} data-checked={choice === id ? "" : undefined}>
            <input type="radio" name="hz-curate" checked={choice === id} onChange={() => setChoice(id)} />
            {word}
          </label>
        ))}
      </div>
      {choice === "hosted" && hostedCuration}
      {choice === "agent" && (
        <div className="stack sz-tight">
          <p className="small">
            The setup prompt from the last step already asks your agent who curates: if nobody does, it sets up a curator of its own (a second connection that only curates, and a nightly task). You approve that connection like the first. In Claude Code, <code>/hippocampus:sleep-setup</code> does the same.
          </p>
          <CuratorCheckIns status={status} />
        </div>
      )}
      {choice === "advanced" && <CurationSetup status={status} bare />}
      <div className="row">
        <a className="btn btn--primary" href={href.page("tavern", "#all-set")}>
          <Icon name="check" /> {v("Finish: go to Home", "Finish: to the Tavern")}
        </a>
        <span className="small muted">You can change curation any time under Setup → Nightly curation.</span>
      </div>
    </div>
  );
}

/** The vault's curators: their connections and when each last called in. */
function CuratorCheckIns({ status }: { status: HostedStatus }) {
  const keys = useResource<{ keys: HostedKeyInfo[]; agents?: HostedAgentClaim[] }>("/setup/keys", { poll: 10_000 });
  const apps = useResource<{ apps: AccountApp[] }>("/account/apps");
  const curators = keys.data ? connectionRows(keys.data.keys, apps.data?.apps ?? [], status.vault?.id, keys.data.agents).filter((r) => "curator" in r.actsAs) : [];
  // A curator the setup prompt just connected marks the step done.
  const count = useRef<number>(undefined);
  useEffect(() => {
    if (!keys.data) return;
    if (count.current !== undefined && curators.length > count.current) void refreshSetup();
    count.current = curators.length;
  }, [curators.length, !!keys.data]);
  if (!keys.data) return null;
  if (!curators.length)
    return (
      <div className="row" role="status" aria-live="polite">
        <ToneTag tone="wait" word="No curator yet" title="Nothing curates this vault yet" />
        <span className="small muted">Waiting for your agent to set one up.</span>
      </div>
    );
  return (
    <ul className="hz-invites" role="status" aria-live="polite">
      {curators.map((c) => (
        <li key={c.id}>
          <ToneTag tone={c.lastUsed || c.source === "app" ? "done" : "wait"} word={c.lastUsed || c.source === "app" ? "Curator" : "Not called in"} compact />
          <strong>{c.name}</strong>
          <span className="small muted">{c.lastUsed ? <>checked in <RelTime at={c.lastUsed} /></> : c.source === "app" ? "a sign-in app that may curate" : "not called in yet"}</span>
        </li>
      ))}
    </ul>
  );
}
