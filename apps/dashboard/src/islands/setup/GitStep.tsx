import { useState } from "react";
import type { GitStatus } from "@hippocampus/dashboard";
import { postJson } from "../../lib/api.ts";
import { useResource } from "../../lib/cache.ts";
import { plural } from "../../lib/format.ts";
import { useTerms } from "../../lib/prefs.ts";
import { Icon } from "../../ui/Icon.tsx";
import { SkeletonPanel } from "../../ui/Parts.tsx";
import { Effects, ErrorCallout, Facts, Field, SnippetBlock, Snippets, useAction } from "./common.tsx";
import { publishSnippets, repoName, repoSlug, syncSnippets, type StepProps } from "./model.ts";

type Visibility = "public" | "private" | "unknown";

export function GitStep({ status }: StepProps) {
  const vault = status.vault;
  if (vault?.kind === "mcp")
    return (
      <div className="callout">
        <Icon name="link" />
        <div>This vault lives behind an MCP server, so its repository is that server's business. Check the repository's privacy wherever the server reads it from.</div>
      </div>
    );
  if (vault?.kind === "github")
    return (
      <div className="stack">
        <Effects
          items={[
            ["contacts", "GitHub, only when you check the repository's visibility."],
            ["never", "pushes, pulls or commits from this page."],
          ]}
        />
        <p>
          This vault is read and written straight through GitHub's API (<span className="mono">{vault.repo}</span>
          {vault.branch ? <> on <span className="mono">{vault.branch}</span></> : null}): every write is one commit, and there is no local clone to push.
        </p>
        <VisibilityCheck slug={vault.repo} gh={false} />
      </div>
    );
  return <LocalGit status={status} />;
}

function LocalGit({ status }: Pick<StepProps, "status">) {
  const res = useResource<GitStatus>("/setup/git");
  const git = res.data ?? status.git;
  const dir = status.vault?.dir ?? status.defaults.dir;
  if (!git && res.error) return <ErrorCallout error={res.error} onRetry={() => void res.reload()} />;
  if (!git) return <SkeletonPanel lines={4} />;
  const slug = git.remote ? repoSlug(git.remote.path) : undefined;

  return (
    <div className="stack">
      <Effects
        items={[
          ["reads", "git's status in the vault folder: branch, remote, and what isn't pushed yet. Credentials in remote URLs are never shown."],
          ["contacts", "GitHub, only when you check the repository's visibility."],
          ["never", "pushes, pulls or commits for you. Every command below is yours to run."],
        ]}
      />

      <div className="row sz-gitbar">
        <h3 className="sz-subhead sz-flush">What git says</h3>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => void res.reload()} disabled={res.loading}>
          <Icon name="refresh" size={16} /> {res.loading ? "Looking…" : "Look again"}
        </button>
      </div>
      {git.repo ? (
        <Facts
          rows={[
            ["Branch", <span className="mono">{git.branch ?? "(none yet)"}</span>],
            ["Remote", git.remote ? <span className="mono sz-break">{git.remote.name} → {git.remote.host}/{slug}</span> : <strong className="sz-warn-text">None yet</strong>],
            ...(git.remote
              ? ([
                  ["Tracking", git.upstream ? <span className="mono">{git.upstream}</span> : <span className="sz-warn-text">Not tracking a remote branch</span>],
                  ["Unpushed", git.ahead ? plural(git.ahead, "commit") : "Nothing"],
                  ["Behind", git.behind ? plural(git.behind, "commit") : "Nothing"],
                ] as [string, React.ReactNode][])
              : []),
            ["Uncommitted", git.dirty ? plural(git.dirty, "changed file") : "Nothing"],
          ]}
        />
      ) : (
        <div className="callout callout--warn">
          <Icon name="warn" />
          <div>
            <span className="mono">{dir}</span> isn't a git repository yet. The commands below start one.
          </div>
        </div>
      )}

      {git.remote ? (
        <>
          <VisibilityCheck slug={git.remote.host === "github.com" ? slug : undefined} gh={git.ghAvailable} host={git.remote.host} />
          <SyncCommands git={git} dir={dir} />
        </>
      ) : (
        <Publish git={git} dir={dir} />
      )}

      <p className="small muted">
        Want your own Obsidian edits to sync on their own? The obsidian-git community plugin can commit and push on a timer.
      </p>
    </div>
  );
}

function Publish({ git, dir }: { git: GitStatus; dir: string }) {
  const [owner, setOwner] = useState("");
  const [name, setName] = useState(repoName(dir));
  const snippets = publishSnippets(git, dir, { owner, name });
  return (
    <div className="stack">
      <h3 className="sz-subhead">Put it in a private repository</h3>
      {git.ghAvailable ? (
        <p>The GitHub CLI is installed, so one command creates the repository as private and pushes the vault to it.</p>
      ) : (
        <ol className="sz-howto">
          <li>
            Open <span className="mono">github.com/new</span>, signed in to your account.
          </li>
          <li>
            Name it, choose <strong>Private</strong>, and add nothing else: no README, license or .gitignore.
          </li>
          <li>Run the commands below in a terminal.</li>
        </ol>
      )}
      <div className="sz-form">
        {!git.ghAvailable && (
          <Field label="Your GitHub account" hint="Only used to fill in the commands below.">
            {(f) => <input id={f.id} className="input mono" value={owner} onChange={(e) => setOwner(e.target.value.trim())} aria-describedby={f.describedBy} placeholder="player" autoComplete="off" spellCheck={false} />}
          </Field>
        )}
        <Field label="Repository name" hint="Defaults to the vault folder's name.">
          {(f) => <input id={f.id} className="input mono" value={name} onChange={(e) => setName(e.target.value.trim())} aria-describedby={f.describedBy} autoComplete="off" spellCheck={false} />}
        </Field>
      </div>
      <Snippets snippets={snippets} />
      <p className="small muted">Then come back and press “Look again” above.</p>
    </div>
  );
}

function SyncCommands({ git, dir }: { git: GitStatus; dir: string }) {
  const snippets = syncSnippets(git, dir);
  if (!snippets.length)
    return (
      <div className="callout callout--ok">
        <Icon name="check" />
        <div>In sync with {git.upstream ?? "the remote"}: nothing to commit or push.</div>
      </div>
    );
  return (
    <div className="stack">
      <h3 className="sz-subhead">To bring it in sync</h3>
      <Snippets snippets={snippets} />
    </div>
  );
}

/** Asks the server whether the remote repository is private. A public vault is the one loud alarm on this page. */
function VisibilityCheck({ slug, gh, host }: { slug?: string; gh: boolean; host?: string }) {
  const { v } = useTerms();
  const action = useAction();
  const [seen, setSeen] = useState<Visibility>();
  const check = async () => {
    const res = await action.run(() => postJson<{ visibility: Visibility }>("/setup/git/visibility", {}));
    if (res) setSeen(res.visibility);
  };
  return (
    <div className="stack sz-tight">
      <div className="row">
        <button type="button" className="btn" onClick={() => void check()} disabled={action.busy}>
          <Icon name="lock" /> {action.busy ? "Checking…" : "Check that the repo is private"}
        </button>
        {host && host !== "github.com" && <span className="hint">The remote is on {host}; the check may not know it.</span>}
      </div>
      {seen === "public" && (
        <div className="callout callout--danger sz-loud" role="alert">
          <Icon name="warn" />
          <div className="stack sz-tight">
            <strong>This repository is PUBLIC.</strong>
            <span>
              Anyone can read {v("your memory: notes, inbox, timeline", "your campaign: notes, inbox, chronicle")}. Make it private now, then assume anything already pushed may have been seen; change any password or account detail that reached the inbox in plain text.
            </span>
            {gh && slug ? (
              <SnippetBlock snippet={{ label: "Make it private (GitHub CLI)", lang: "bash", code: `gh repo edit ${slug} --visibility private --accept-visibility-change-consequences` }} />
            ) : (
              <span>
                On GitHub: the repository → <strong>Settings</strong> → <strong>General</strong> → <strong>Danger Zone</strong> → <strong>Change visibility</strong> → Private.
              </span>
            )}
          </div>
        </div>
      )}
      {seen === "private" && (
        <div className="callout callout--ok" role="status">
          <Icon name="lock" />
          <div>Private. Only you, and whoever you invite, can read it.</div>
        </div>
      )}
      {seen === "unknown" && (
        <div className="callout callout--warn" role="status">
          <Icon name="warn" />
          <div>
            Couldn't tell from here{gh ? "" : " (signing in to the GitHub CLI helps)"}. Look on GitHub: a private repository shows a <strong>Private</strong> badge next to its name.
          </div>
        </div>
      )}
      {action.error !== undefined && <ErrorCallout error={action.error} />}
    </div>
  );
}
