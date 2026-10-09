import { useEffect, useMemo, useRef, useState } from "react";
import { postJson } from "../../lib/api.ts";
import { invalidate, useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { plural } from "../../lib/format.ts";
import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import type { HostedInitResult, HostedMintedKey, HostedRepoView, HostedStatus, SessionInfo } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { SkeletonPanel } from "../../ui/Parts.tsx";
import { Personalization } from "../../ui/Personalization.tsx";
import { ChipsInput, CopyLine, Effects, ErrorCallout, Facts, Field, refreshSetup, Snippets, StateBadge, ToneTag, useAction, useHash, useScrollToHash } from "./common.tsx";
import { CuratorRecipes, mintedReveal } from "./HostedKeys.tsx";
import {
  agentPluginSnippets,
  draftProblems,
  draftReady,
  hasKey,
  HOSTED_STEPS,
  hostedDefaultStep,
  hostedIndex,
  hostedLock,
  hostedNeighbors,
  hostedStepDef,
  hostedStepState,
  identityFileName,
  identityFileText,
  initRequest,
  newDraft,
  parseHostedStep,
  repoVerdict,
  STEP_ITEM,
  type CampaignDraft,
  type HostedContext,
  type HostedStepId,
} from "./hosted.ts";
import { domainProblem, truncateKey } from "./model.ts";
import { StepRailView } from "./StepRail.tsx";
import { SecretReveal } from "./SecretReveal.tsx";

/** What every hosted step body gets. */
interface HostedStepProps {
  session: SessionInfo;
  status: HostedStatus;
  ctx: HostedContext;
  draft: CampaignDraft;
  setDraft: (fn: (d: CampaignDraft) => CampaignDraft) => void;
  picked?: number;
  setPicked: (id: number) => void;
  identity?: string;
  setIdentity: (id: string | undefined) => void;
  clearDraft: () => void;
}

const BODIES: Record<HostedStepId, (p: HostedStepProps) => React.ReactNode> = {
  access: AccessStep,
  create: CreateStep,
  install: InstallStep,
  repo: RepoStep,
  campaign: CampaignStep,
  init: InitStep,
  agents: AgentsStep,
  curator: CuratorStep,
  done: DoneStep,
};

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The draft (campaign settings, the picked repo, the key's *public* half) survives a reload or
 * GitHub's install round trip in sessionStorage. The private key is never stored anywhere.
 */
function useDraft(login: string) {
  const key = `hippo:hosted-draft:${login}`;
  const [state, setState] = useState<{ draft: CampaignDraft; picked?: number }>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as { draft: CampaignDraft; picked?: number } | null;
      if (saved?.draft) return { draft: { ...newDraft(localTimeZone()), ...saved.draft }, picked: saved.picked };
    } catch {
      // Storage off or unreadable: start fresh.
    }
    return { draft: newDraft(localTimeZone()) };
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
    setDraft: (fn: (d: CampaignDraft) => CampaignDraft) => setState((s) => ({ ...s, draft: fn(s.draft) })),
    setPicked: (picked: number) => setState((s) => ({ ...s, picked })),
    clear: () => {
      try {
        sessionStorage.removeItem(key);
      } catch {
        // Nothing stored.
      }
      setState({ draft: newDraft(localTimeZone()) });
    },
  };
}

/** Hosted Session Zero: from the waitlist to a vault in the person's own private repo, then agents and a curator. */
export function HostedOnboarding({ session, status: initial, footer }: { session: SessionInfo; status: HostedStatus; footer?: React.ReactNode }) {
  const { t, v } = useTerms();
  const hash = useHash();
  const login = initial.account.login;
  const { draft, setDraft, picked, setPicked, clear } = useDraft(login);
  const [identity, setIdentity] = useState<string>();
  // Waiting on someone else (an admin, a bootstrap): look again every few seconds.
  const waiting = (initial.account.status === "waitlisted" && initial.account.requested) || initial.vault?.status === "bootstrapping";
  const live = useResource<HostedStatus>("/setup/status", { poll: waiting ? 15_000 : undefined });
  const status = live.data?.kind === "hosted" ? live.data : initial;
  const ctx: HostedContext = { status, picked, draftReady: draftReady(draft) };

  const parsed = parseHostedStep(hash);
  const lastStep = useRef<HostedStepId | undefined>(undefined);
  if (parsed) lastStep.current = parsed;
  const current = parsed ?? lastStep.current ?? hostedDefaultStep(ctx);
  const step = hostedStepDef(current);
  const lock = hostedLock(current, ctx);
  const state = hostedStepState(current, ctx);
  const itemId = STEP_ITEM[current];
  const item = itemId ? status.items.find((i) => i.id === itemId) : undefined;
  const { prev, next } = hostedNeighbors(current);
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
  const props: HostedStepProps = { session, status, ctx, draft, setDraft, picked, setPicked, identity, setIdentity, clearDraft: clear };
  const ready = status.vault?.status === "ready";

  return (
    <div className="stack sz">
      <header className="page-head">
        <div>
          <div className="page-head__kicker">
            {t("sessionZero")}
            {session.campaign ? ` · ${session.campaign}` : ""}
          </div>
          <h1>{ready ? v("Finish setting up", "Finish setting the table") : v("Get started", "Set the table")}</h1>
          <p className="page-head__lede">
            {v(
              "Your memory lives in a private GitHub repository that you own. A few steps connect it here, then your agents. Nothing happens until you press a button, and every button says what it will do.",
              "The campaign lives in a private GitHub repository that you own. A few steps open it here, then seat your party. Nothing happens until you press a button, and every button says what it will do.",
            )}
          </p>
        </div>
        <span className="chip sz-where" title={`Signed in with GitHub as @${login}`}>
          <Icon name="github" size={14} /> @{login}
        </span>
      </header>

      <div className="sz-layout">
        <StepRailView steps={HOSTED_STEPS} current={current} stateOf={(id) => hostedStepState(id as HostedStepId, ctx)} />
        <section className="panel sz-step" aria-labelledby="sz-step-title">
          <header className="sz-step__head">
            <div className="sz-step__kicker">
              <Icon name={step.icon} size={16} /> Step {hostedIndex(current) + 1} of {HOSTED_STEPS.length}
            </div>
            <div className="sz-step__titlerow">
              <h2 id="sz-step-title" ref={headingRef} tabIndex={-1}>
                {v(...step.title)}
              </h2>
              {state && <StateBadge state={state} />}
            </div>
            <p className="sz-step__lede">{v(...step.lede)}</p>
            {item && !lock && item.state !== "done" && item.detail && (
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
      {footer}
      <Personalization />
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
          <strong>You're in.</strong> @{a.login} is approved. Next, make the repository your memory will live in.
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

// ── 2. Create a repo ───────────────────────────────────────────────────────

function CreateStep({ status }: HostedStepProps) {
  const { v } = useTerms();
  const done = !!status.installation || !!status.vault;
  return (
    <div className="stack">
      <p>
        {v(
          "Your memory is a folder of Markdown notes in a GitHub repository that belongs to you. You can open it, clone it, back it up or delete it any time; Hippocampus only reads and writes it through its app.",
          "The campaign is a folder of Markdown notes in a GitHub repository that belongs to you. You can open it, clone it, back it up or delete it any time; Hippocampus only reads and writes it through its app.",
        )}
      </p>
      <ul className="sz-howto">
        <li>
          <strong>Private:</strong> only you (and the app) can see it. Public repositories are refused.
        </li>
        <li>
          <strong>Empty:</strong> no README, license or .gitignore needed; the app fills it with the vault template.
        </li>
        <li>
          <strong>On your personal account,</strong> not an organization.
        </li>
      </ul>
      <div className="row">
        <a className="btn btn--primary" href={status.newRepoUrl} target="_blank" rel="noopener noreferrer">
          <Icon name="github" /> Create a private repo on GitHub <Icon name="external" size={16} />
        </a>
        {done && <ToneTag tone="done" word="Done" title="The app is installed on a repo already" />}
      </div>
      <p className="hint">Opens GitHub in a new tab with the form filled in: named vault, private. Rename it if you like, then come back here.</p>
      <p className="small muted">Already have an empty private repo, or one with an existing Hippocampus vault? Skip ahead and install the app on it.</p>
      <Effects
        items={[
          ["shows", "GitHub's new-repository form. You create the repository yourself; this page can't."],
          ["never", "sees your other repositories."],
        ]}
      />
    </div>
  );
}

// ── 3. Install the app ─────────────────────────────────────────────────────

function InstallStep({ status }: HostedStepProps) {
  const v = status.vault;
  const inst = status.installation;
  const vaultItem = status.items.find((i) => i.id === "vault");
  return (
    <div className="stack">
      {v?.status === "disconnected" && !inst && (
        <div className="callout callout--danger" role="alert">
          <Icon name="warn" />
          <div className="stack sz-tight">
            <strong>Your vault {v.fullName} is disconnected.</strong>
            <span>{vaultItem?.detail ?? "Install the app on it again to reconnect."}</span>
          </div>
        </div>
      )}
      {inst && !inst.error && (
        <div className="callout callout--ok" role="status">
          <Icon name="check" />
          <div>
            <strong>Installed.</strong> The app can see {plural(inst.repos.length, "repository", "repositories")}. <a href="#repo">Pick the repo →</a>
          </div>
        </div>
      )}
      {inst?.error && (
        <div className="callout callout--warn" role="alert">
          <Icon name="warn" />
          <div>
            <strong>Installed, but its repositories couldn't be listed.</strong> {inst.error}
          </div>
        </div>
      )}
      <ol className="sz-howto">
        <li>On GitHub, install the app on your personal account (@{status.account.login}).</li>
        <li>
          Under <em>Repository access</em>, choose <strong>Only select repositories</strong> and pick the repo from the last step. Just that one.
        </li>
        <li>
          Press <strong>Install</strong>. GitHub sends you back here, to the next step.
        </li>
      </ol>
      <div className="row">
        <a className="btn btn--primary" href={status.installUrl}>
          <Icon name="github" /> {inst || v ? "Install it again, or change its repos" : "Install the app on GitHub"}
        </a>
      </div>
      <Effects
        items={[
          ["contacts", "GitHub. The app asks to read and write the files (including workflow files) of the repositories you select."],
          ["never", "sees repositories you don't select. Removing the app on GitHub (Settings → Applications) disconnects the vault at once."],
        ]}
      />
    </div>
  );
}

// ── 4. Pick the repo ───────────────────────────────────────────────────────

function RepoStep({ status, picked, setPicked }: HostedStepProps) {
  const repos = useResource<{ installation: { id: number }; repos: HostedRepoView[] }>(status.installation ? "/setup/repos" : null);
  if (status.vault?.status === "ready")
    return (
      <div className="callout callout--ok" role="status">
        <Icon name="check" />
        <div>
          Your vault is <a href={href.github(status.vault.fullName)}>{status.vault.fullName}</a>.
        </div>
      </div>
    );
  if (repos.error && !repos.data) return <ErrorCallout error={repos.error} onRetry={() => void repos.reload()} />;
  if (!repos.data) return <SkeletonPanel lines={4} />;
  const list = repos.data.repos;
  return (
    <div className="stack">
      {list.length === 0 ? (
        <div className="callout callout--warn">
          <Icon name="warn" />
          <div>
            <strong>The app can't see any repositories.</strong> Add your vault repo to the installation on GitHub, then come back.
          </div>
        </div>
      ) : (
        <fieldset className="sz-fieldset">
          <legend className="label">Which repository becomes your vault?</legend>
          <div className="hz-repos">
            {list.map((r) => {
              const verdict = repoVerdict(r);
              return (
                <label key={r.id} className="hz-repo" data-disabled={verdict.usable ? undefined : ""} data-checked={picked === r.id ? "" : undefined}>
                  <input type="radio" name="hz-repo" value={r.id} checked={picked === r.id} disabled={!verdict.usable} onChange={() => setPicked(r.id)} />
                  <span className="hz-repo__text">
                    <span className="hz-repo__name mono sz-break">{r.fullName}</span>
                    <span className="small muted">{verdict.detail}</span>
                  </span>
                  <ToneTag tone={verdict.tone} word={verdict.tag} title={verdict.detail} compact />
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      <p className="small muted">
        Missing one? <a href={status.installUrl}>Add it to the app's installation on GitHub</a>.
      </p>
      {picked !== undefined && list.some((r) => r.id === picked) && (
        <div className="row">
          <a className="btn btn--primary" href="#campaign">
            Continue <Icon name="chevron" />
          </a>
        </div>
      )}
    </div>
  );
}

// ── 5. Campaign and the secrets key ────────────────────────────────────────

function CampaignStep({ status, draft, setDraft, identity, setIdentity, session }: HostedStepProps) {
  const { v } = useTerms();
  const [tried, setTried] = useState(false);
  const zones = useMemo(() => (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []), []);
  if (status.vault?.status === "ready")
    return (
      <div className="callout callout--ok" role="status">
        <Icon name="check" />
        <div>
          {v("Set up", "Settled")}: {session.campaign ?? "your vault"} lives in <a href={href.github(status.vault.fullName)}>{status.vault.fullName}</a>. Its settings are in <code>_hippo/config.yaml</code> there; edit them in Obsidian or on GitHub.
        </div>
      </div>
    );
  const problems = draftProblems(draft);
  const show = (p: string | undefined) => (tried ? p : undefined);
  const set = <K extends keyof CampaignDraft>(k: K, value: CampaignDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (draftReady(draft)) location.hash = "init";
      }}
    >
      <div className="sz-form">
        <Field label={v("Name", "Campaign name")} hint="What this memory is about, e.g. “Lisbon Arc”." problem={show(problems.campaign)}>
          {(f) => <input id={f.id} className="input" value={draft.campaign} onChange={(e) => set("campaign", e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder="Lisbon Arc" maxLength={120} />}
        </Field>
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
          <span className="hint">
            {draft.seed
              ? v("A made-up move to Lisbon, with a residency agent, a home finder and others, to look around in. Delete its notes when you're ready.", "A made-up move to Lisbon, with a residency agent, a home finder and friends, to look around in. Retire its notes when you're ready.")
              : "An empty vault: just the template."}
          </span>
        </div>
        <ChipsInput label={v("Domains (areas of responsibility)", "Domains (your lanes)")} values={draft.domains} onChange={(d) => set("domains", d)} validate={domainProblem} placeholder="add a domain…" />
        <p className="hint sz-wide sz-flush">
          {v(
            "Domains are the areas an agent can be the authority on, like housing or career. You choose who's responsible for what when you approve each agent.",
            "Domains are the lanes an agent can hold authority over, like housing or career. You choose who holds which when you seat each agent.",
          )}
        </p>
      </div>

      <SecretsKey draft={draft} set={set} identity={identity} setIdentity={setIdentity} problem={show(problems.secrets)} />

      {tried && !draftReady(draft) && (
        <p className="sz-problem" role="alert">
          A few things need a look before the vault can be set up.
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn--primary">
          Continue <Icon name="chevron" />
        </button>
      </div>
    </form>
  );
}

/**
 * The secrets key, made in this browser with age (X25519). Only the public half (`age1…`) goes to
 * the server; the identity is offered as a download and kept in memory until the vault is set up.
 */
function SecretsKey({ draft, set, identity, setIdentity, problem }: { draft: CampaignDraft; set: <K extends keyof CampaignDraft>(k: K, value: CampaignDraft[K]) => void; identity?: string; setIdentity: (id: string | undefined) => void; problem?: string }) {
  const { v } = useTerms();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const file = identityFileName(draft.campaign);
  const url = useMemo(() => (identity ? URL.createObjectURL(new Blob([identityFileText(identity)], { type: "application/octet-stream" })) : undefined), [identity]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);

  const make = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const age = await import("age-encryption");
      const id = await age.generateX25519Identity();
      const recipient = await age.identityToRecipient(id);
      setIdentity(id);
      set("recipient", recipient);
      set("saved", false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="hz-key" aria-labelledby="hz-key-title">
      <h3 className="sz-subhead" id="hz-key-title">
        <Icon name="key" size={18} /> Secrets key <span className="muted">(optional, recommended)</span>
      </h3>
      <p className="small">
        {v(
          "Passport numbers, account ids and passwords are encrypted before they're written into your vault. The key is made here, in this browser, and never leaves it: only its public half goes to your vault. Reading a secret later takes the key file, on your own machine.",
          "Passport numbers, account ids and passwords are sealed before they're written into the vault. The key is forged here, in this browser, and never leaves it: only its public half goes to the vault. Reading a secret later takes the key file, on your own machine.",
        )}
      </p>
      <div className="segmented" role="radiogroup" aria-label="Secrets key">
        <label data-checked={draft.secrets === "create" ? "" : undefined}>
          <input type="radio" name="hz-secrets" checked={draft.secrets === "create"} onChange={() => set("secrets", "create")} />
          <Icon name="key" size={16} /> {v("Make a key", "Forge a key")}
        </label>
        <label data-checked={draft.secrets === "skip" ? "" : undefined}>
          <input type="radio" name="hz-secrets" checked={draft.secrets === "skip"} onChange={() => set("secrets", "skip")} />
          Not now
        </label>
      </div>

      {draft.secrets === "skip" ? (
        <p className="hint">
          Fine for now. Add one later from a clone of your vault with <code>hippo secrets keygen</code>.
        </p>
      ) : !draft.recipient ? (
        <div className="row">
          <button type="button" className="btn" onClick={() => void make()} disabled={busy}>
            <Icon name="key" /> {busy ? v("Making…", "Forging…") : v("Make a key in this browser", "Forge a key in this browser")}
          </button>
        </div>
      ) : (
        <div className="stack sz-tight">
          <Facts
            rows={[
              ["Public key", <span className="mono" title={draft.recipient}>{truncateKey(draft.recipient)}</span>],
              ["Key file", <span className="mono sz-break">{file}</span>],
            ]}
          />
          {url ? (
            <div className="row">
              <a className="btn btn--primary" href={url} download={file}>
                <Icon name="copy" /> Download the key file
              </a>
              <span className="hint">Keep it somewhere safe, like a password manager.</span>
            </div>
          ) : (
            <p className="small sz-warn-text">This page was reloaded, so the key file can't be downloaded again. If you saved it, you're set; if not, make a different key.</p>
          )}
          <label className="check">
            <input type="checkbox" checked={draft.saved} onChange={(e) => set("saved", e.target.checked)} />I saved the key file somewhere safe
          </label>
          <details className="sz-more small">
            <summary>How to read secrets later</summary>
            <p>
              Save the file as <code>~/.config/hippocampus/age-identity.txt</code> (or set <code>HIPPO_AGE_IDENTITY_FILE</code> to where it is), then in a clone of your vault run <code>npx @mehrad77/hippocampus secrets show passport</code>. Without the file, nobody can read those secrets, not even you.
            </p>
          </details>
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
        </div>
      )}
      {problem && (
        <p className="sz-problem" role="status">
          {problem}
        </p>
      )}
      {error !== undefined && <ErrorCallout error={error} />}
      <Effects
        title="What the key does"
        items={[
          ["shows", "a key file made here with age encryption, for you to download."],
          ["writes", "only its public half (age1…) into your vault's config, when you set the vault up."],
          ["never", "sends the private key anywhere. The curator encrypts with the public half; only the file can decrypt."],
        ]}
      />
    </section>
  );
}

// ── 6. Initialize ──────────────────────────────────────────────────────────

function InitStep({ status, draft, picked, setIdentity, clearDraft }: HostedStepProps) {
  const { v } = useTerms();
  const action = useAction();
  const vault = status.vault;
  const repo = status.installation?.repos.find((r) => r.id === picked);
  if (vault?.status === "ready")
    return (
      <div className="callout callout--ok" role="status">
        <Icon name="check" />
        <div>
          <strong>Your vault is ready:</strong> <a href={href.github(vault.fullName)}>{vault.fullName}</a>. <a href="#agents">Connect your agents →</a>
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

  const go = async () => {
    if (picked === undefined) return;
    const res = await action.run(() => postJson<HostedInitResult>("/setup/init", initRequest(draft, picked)));
    if (!res) return;
    toast(res.mode === "adopted" ? `Adopted ${res.vault.fullName}: your existing vault is connected.` : v(`${res.vault.fullName} is your vault now.`, `${res.vault.fullName} holds the campaign now.`), "ok");
    setIdentity(undefined);
    clearDraft();
    // The session turns into a vault session; its new scope drops what was cached for the setup-only one.
    await invalidate((k) => k === "/session" || k === "/setup/status");
    location.hash = "agents";
  };

  return (
    <div className="stack">
      {vault?.status === "disconnected" && (
        <div className="callout callout--warn" role="alert">
          <Icon name="warn" />
          <div>
            <strong>{vault.fullName} isn't connected.</strong> {status.items.find((i) => i.id === "vault")?.detail ?? "Try again."}
          </div>
        </div>
      )}
      <Facts
        rows={[
          ["Repository", repo ? <span className="mono sz-break">{repo.fullName}</span> : <a href="#repo">Pick one</a>],
          [v("Name", "Campaign"), draft.campaign.trim() || <a href="#campaign">Not set</a>],
          ["Your id", <span className="mono">{draft.human}</span>],
          ["Time zone", draft.timezone],
          ["Domains", draft.domains.length ? draft.domains.join(", ") : <span className="muted">none</span>],
          ["Start from", draft.seed ? v("The template and the fictional example", "The template and the example campaign") : "The empty template"],
          ["Secrets key", draft.secrets === "create" && draft.recipient ? <span className="mono">{truncateKey(draft.recipient)}</span> : <span className="muted">None for now</span>],
        ]}
      />
      <p className="small">
        <a href="#campaign">Change these</a> · <a href="#repo">Pick another repo</a>
      </p>
      <Effects
        items={[
          [
            "writes",
            <>
              one commit into <code>{repo?.fullName ?? "the repo"}</code>: the vault template (folders for notes, <code>_hippo/config.yaml</code> with your choices, Obsidian templates, rules for agents and a validation workflow){draft.seed ? ", plus the example notes" : ""}. An existing vault gets only the rule files it's missing.
            </>,
          ],
          ["contacts", "GitHub, through the app installed on that repository."],
          ["never", "touches your other repositories, or sees the private secrets key."],
        ]}
      />
      {action.error !== undefined && <ErrorCallout error={action.error} />}
      <div className="row">
        <button type="button" className="btn btn--primary" onClick={() => void go()} disabled={action.busy || !repo}>
          <Icon name={action.busy ? "hourglass" : "sparkle"} className={action.busy ? "sz-spin" : undefined} /> {action.busy ? "Setting up… one commit to GitHub" : v("Set up the vault", "Open the vault")}
        </button>
      </div>
    </div>
  );
}

// ── 7. Agents ──────────────────────────────────────────────────────────────

function AgentsStep({ status }: HostedStepProps) {
  const { t, v } = useTerms();
  const action = useAction();
  const [minted, setMinted] = useState<HostedMintedKey>();
  const agentKeys = (status.keys ?? []).filter((k) => k.kind === "agent" || k.kind === "bound").length;
  const mint = async () => {
    const res = await action.run(() => postJson<HostedMintedKey>("/setup/keys", { kind: "agent", label: "Agents" }));
    if (!res) return;
    setMinted(res);
    void refreshSetup();
  };
  return (
    <div className="stack">
      <div className="grid grid--2">
        <div className="sz-card">
          <div className="sz-card__head">
            <Icon name="key" />
            <strong>Agents with a key</strong>
          </div>
          <p className="small">Claude Code, Cursor, VS Code and any MCP client over HTTP. One agent key works for all of them: each agent names itself when it connects.</p>
          <div className="row">
            <button type="button" className="btn btn--primary" onClick={() => void mint()} disabled={action.busy}>
              <Icon name="key" /> {action.busy ? v("Creating…", "Minting…") : v("Create an agent key", "Mint an agent key")}
            </button>
          </div>
          {agentKeys > 0 && <p className="small muted">You have {plural(agentKeys, "agent key")}. Manage them in Setup & health.</p>}
          {action.error !== undefined && <ErrorCallout error={action.error} />}
        </div>
        <div className="sz-card">
          <div className="sz-card__head">
            <Icon name="cloud" />
            <strong>Claude.ai or ChatGPT</strong>
          </div>
          <p className="small">Add a custom connector with this URL. It signs in with GitHub (as you), so no key is needed.</p>
          <CopyLine value={status.mcpUrl} label="MCP URL" />
          <p className="small muted">Connected apps show up in Setup & health, where you can revoke them.</p>
        </div>
      </div>
      <h3 className="sz-subhead">What happens next</h3>
      <ol className="sz-howto">
        <li>
          An agent calls <code>onboard</code> when it connects, then <code>introduce</code>: it says who it is and what it handles.
        </li>
        <li>
          {v("Its request shows on the ", "Its knock shows on the ")}
          <a href={href.page("party")}>{t("party")}</a> page. You approve it there and choose the topics it's responsible for.
        </li>
        <li>{v("Until you approve it, what it saves counts as unverified.", "Until you seat it, what it remembers counts as rumor.")}</li>
      </ol>
      <SecretReveal reveal={minted && mintedReveal(minted, v, <Snippets snippets={agentPluginSnippets(status.mcpUrl)} />)} onClose={() => setMinted(undefined)} />
    </div>
  );
}

// ── 8. Curator ─────────────────────────────────────────────────────────────

function CuratorStep({ status }: HostedStepProps) {
  const { t, v } = useTerms();
  const action = useAction();
  const [minted, setMinted] = useState<HostedMintedKey>();
  const has = hasKey(status.keys, ["curator"]);
  const mint = async () => {
    const res = await action.run(() => postJson<HostedMintedKey>("/setup/keys", { kind: "curator", label: "Curator" }));
    if (!res) return;
    setMinted(res);
    void refreshSetup();
  };
  return (
    <div className="stack">
      <p>
        {v(
          <>
            Agents' notes land in the {t("satchel").toLowerCase()} first. Curation (the nightly update) reads them, settles each fact by the rules (your word first, then the responsible agent, then agreement, then the newest), updates records, goals and the timeline, and empties the inbox. Here, one of your own agents does it, through the vault's MCP tools, with a curator key.
          </>,
          <>
            The party's notes land in the satchel first. The sleep reads them, settles each fact by precedence (your word, then lane authority, then corroboration, then recency), updates the codex, the quests and the chronicle, and empties the satchel. Here, one of your own agents curates, through the vault's MCP tools, with a curator key.
          </>,
        )}
      </p>
      <div className="callout callout--warn" role="note">
        <Icon name="lock" />
        <div>
          <strong>The curator sees secret memories.</strong> While curating it reads every note in full, secret values included, before encrypting them with your public key. Give the curator key only to an agent (and an AI provider) you trust with them.
        </div>
      </div>
      <div className="row">
        <button type="button" className="btn btn--primary" onClick={() => void mint()} disabled={action.busy}>
          <Icon name="key" /> {action.busy ? v("Creating…", "Minting…") : has ? v("Create another curator key", "Mint another curator key") : v("Create a curator key", "Mint a curator key")}
        </button>
        {has && <ToneTag tone="done" word="You have one" title="A curator key exists" />}
      </div>
      {action.error !== undefined && <ErrorCallout error={action.error} />}
      <CuratorRecipes status={status} />
      <SecretReveal reveal={minted && mintedReveal(minted, v, <p className="small">Next: use it where the curator runs (below), then close this.</p>)} onClose={() => setMinted(undefined)} />
    </div>
  );
}

// ── 9. Done ────────────────────────────────────────────────────────────────

function DoneStep({ status }: HostedStepProps) {
  const { t, v } = useTerms();
  const open = HOSTED_STEPS.filter((s) => s.id !== "done" && s.id !== "create").filter((s) => {
    const st = hostedStepState(s.id, { status, draftReady: true });
    return st === "todo" || st === "warn" || st === "error";
  });
  return (
    <div className="stack sz-done">
      <div className="sz-done__seal" aria-hidden>
        <Icon name={v("check", "d20")} size={56} />
      </div>
      <p className="sz-done__lede">
        {v(
          "From here on, agents send notes about what they learn, your curator turns them into confirmed records, and this dashboard is where you read everything, decide disputes and track goals.",
          "From here on, the party files what it learns, your curator turns it into canon, and this dashboard is where you read the campaign, rule on disputes and steer quests.",
        )}
      </p>
      {open.length > 0 && (
        <div className="callout callout--warn">
          <Icon name="warn" />
          <div className="stack sz-tight">
            <strong>Still open, whenever you're ready:</strong>
            <ul className="sz-open">
              {open.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{v(...s.title)}</a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="sz-doors">
        <a className="sz-door" href={href.page("tavern")}>
          <Icon name="tavern" size={28} />
          <strong>{v(t("tavern"), "The Tavern")}</strong>
          <span className="small muted">What happened, what needs you</span>
        </a>
        <a className="sz-door" href={href.page("party")}>
          <Icon name="party" size={28} />
          <strong>{t("party")}</strong>
          <span className="small muted">{v("Approve agents as they arrive", "Seat the party as it arrives")}</span>
        </a>
        <a className="sz-door" href={href.page("setup")}>
          <Icon name="setup" size={28} />
          <strong>{t("setup")}</strong>
          <span className="small muted">Keys, apps, curator and your account</span>
        </a>
      </div>
    </div>
  );
}
