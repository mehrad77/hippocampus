import { useMemo, useState } from "react";
import type { LocalSetupStatus, LocalVaultStatus, VaultSetupRequest } from "@hippocampus/dashboard";
import { postJson } from "../../lib/api.ts";
import { invalidate } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import type { SessionInfo } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { ChipsInput, Effects, ErrorCallout, Facts, Field, SnippetBlock, TabPanel, Tabs, useAction } from "./common.tsx";
import { agentIdProblem, domainProblem, isTimeZone, migrateCommand, normalizeUrl, REPO, type StepProps } from "./model.ts";

type Tab = "create" | "open" | "github" | "mcp";
const TABS = [
  ["create", "Create"],
  ["open", "Open existing"],
  ["github", "Connect GitHub repo"],
  ["mcp", "Connect MCP server"],
] as const;

type Submit = (req: VaultSetupRequest, done: string) => void;

export function VaultStep({ session, status, hasVault }: StepProps) {
  const [tab, setTab] = useState<Tab>("create");
  const action = useAction();
  const submit: Submit = async (req, done) => {
    const res = await action.run(() => postJson<{ ok: boolean }>("/setup/vault", req));
    if (!res) return;
    toast(done, "ok");
    // The server switched to the new vault in place: everything cached belongs to the old one.
    await invalidate();
    location.hash = "party";
  };

  return (
    <div className="stack">
      {status.vault && <CurrentVault vault={status.vault} session={session} envFile={status.envFile} busy={action.busy} onSubmit={submit} />}
      {!status.vault && session.error && <SessionError session={session} />}

      <h3 className="sz-subhead">{hasVault ? "Or switch to another vault" : "Choose how to begin"}</h3>
      <Tabs tabs={TABS} value={tab} onChange={setTab} label="How to get a vault" idBase="sz-vault" />
      <TabPanel idBase="sz-vault" id={tab}>
        {tab === "create" && <CreateForm status={status} busy={action.busy} onSubmit={submit} />}
        {tab === "open" && <OpenForm status={status} busy={action.busy} onSubmit={submit} />}
        {tab === "github" && <GithubForm status={status} busy={action.busy} onSubmit={submit} />}
        {tab === "mcp" && <McpForm busy={action.busy} onSubmit={submit} />}
      </TabPanel>
      {action.error !== undefined && <ErrorCallout error={action.error} />}
    </div>
  );
}

const KIND: Record<LocalVaultStatus["kind"], string> = { dir: "A folder on this machine", github: "A GitHub repository, through the API", mcp: "An MCP server" };

function CurrentVault({ vault, session, envFile, busy, onSubmit }: { vault: LocalVaultStatus; session: SessionInfo; envFile: string; busy: boolean; onSubmit: Submit }) {
  const where = vault.kind === "dir" ? vault.dir : vault.kind === "github" ? `${vault.repo ?? ""}${vault.branch ? ` (${vault.branch})` : ""}` : vault.url;
  const canDefault = !vault.isDefault && ((vault.kind === "dir" && vault.dir) || (vault.kind === "github" && vault.repo));
  return (
    <div className="sz-card">
      <div className="sz-card__head">
        <Icon name="codex" />
        <strong>Current vault</strong>
        {session.campaign && <span className="chip">{session.campaign}</span>}
      </div>
      <Facts
        rows={[
          ["Kind", KIND[vault.kind]],
          ["Where", <span className="mono sz-break">{where ?? "unknown"}</span>],
          ["Format", <VersionWord version={vault.version} />],
          [
            "Default",
            vault.isDefault ? (
              <>
                Yes: <span className="mono">hippo dashboard</span> opens it
              </>
            ) : (
              "No"
            ),
          ],
        ]}
      />
      {canDefault && (
        <div className="row">
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy}
            onClick={() =>
              onSubmit(
                vault.kind === "dir" ? { action: "open", dir: vault.dir!, makeDefault: true } : { action: "github", repo: vault.repo!, branch: vault.branch, makeDefault: true },
                "Saved as your default vault.",
              )
            }
          >
            Make it my default
          </button>
          <span className="hint">
            Saves it in <code>{envFile}</code>.
          </span>
        </div>
      )}
      {vault.version === "older" && (
        <div className="callout callout--warn">
          <Icon name="warn" />
          <div className="stack sz-tight">
            <strong>This vault uses an older format.</strong>
            <span>The tool won't write to it until it is migrated. Commit or back it up first, then run{vault.kind === "dir" ? "" : " in a clone of the repository (and push afterwards)"}:</span>
            <SnippetBlock snippet={{ label: "Upgrade the vault's files", lang: "bash", code: migrateCommand(vault.kind === "dir" && vault.dir ? vault.dir : ".") }} />
          </div>
        </div>
      )}
      {vault.version === "newer" && (
        <div className="callout callout--danger">
          <Icon name="warn" />
          <div>
            <strong>A newer hippo wrote this vault.</strong> Update the tool before writing to it, e.g. <code>npx @mehrad77/hippocampus@latest dashboard</code>.
          </div>
        </div>
      )}
      {session.error && <SessionError session={session} />}
    </div>
  );
}

function VersionWord({ version }: { version: LocalVaultStatus["version"] }) {
  if (version === "current") return <>Up to date</>;
  if (version === "older") return <strong className="sz-warn-text">Older: needs hippo migrate</strong>;
  if (version === "newer") return <strong className="sz-danger-text">Newer than this tool</strong>;
  return <span className="muted">Unknown</span>;
}

function SessionError({ session }: { session: SessionInfo }) {
  if (!session.error) return null;
  return (
    <div className="callout callout--danger" role="alert">
      <Icon name="warn" />
      <div>
        <strong>The vault is configured but didn't load ({session.error.code}).</strong>
        <div>{session.error.message}</div>
      </div>
    </div>
  );
}

function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function MakeDefault({ checked, onChange, envFile, what }: { checked: boolean; onChange: (v: boolean) => void; envFile: string; what: string }) {
  return (
    <div className="field sz-wide">
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        Make this my default vault
      </label>
      <span className="hint">
        Saves {what} in <code>{envFile}</code>, so <code>hippo dashboard</code> opens it next time.
      </span>
    </div>
  );
}

function CreateForm({ status, busy, onSubmit }: { status: LocalSetupStatus; busy: boolean; onSubmit: Submit }) {
  const d = status.defaults;
  const [dir, setDir] = useState(d.dir);
  const [campaign, setCampaign] = useState("");
  const [human, setHuman] = useState("player");
  const [timezone, setTimezone] = useState(() => localTimeZone() ?? d.timezone ?? "UTC");
  const [domains, setDomains] = useState<string[]>(() => [...d.domains]);
  const [seed, setSeed] = useState("");
  const [makeDefault, setMakeDefault] = useState(true);
  const [tried, setTried] = useState(false);
  const zones = useMemo(() => (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []), []);

  const problems = {
    dir: dir.trim() ? undefined : "Choose a folder.",
    campaign: campaign.trim() ? undefined : "Name the campaign.",
    human: agentIdProblem(human),
    timezone: isTimeZone(timezone) ? undefined : "Use a time zone name such as Europe/Lisbon.",
  };
  const show = (p: string | undefined) => (tried ? p : undefined);
  const valid = Object.values(problems).every((p) => !p);

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!valid) return;
        onSubmit(
          { action: "create", dir: dir.trim(), campaign: campaign.trim(), human: human.trim(), timezone: timezone.trim(), domains, seed: seed || undefined, makeDefault },
          `${campaign.trim()} begins: the vault is at ${dir.trim()}.`,
        );
      }}
    >
      <div className="sz-form">
        <Field label="Folder" hint="A new or empty folder. ~ means your home folder." problem={show(problems.dir)}>
          {(f) => <input id={f.id} className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} autoComplete="off" spellCheck={false} />}
        </Field>
        <Field label="Campaign name" hint="What this memory is about, e.g. “Lisbon Arc”." problem={show(problems.campaign)}>
          {(f) => <input id={f.id} className="input" value={campaign} onChange={(e) => setCampaign(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder="Lisbon Arc" />}
        </Field>
        <Field label="Your id" hint="How notes and agents refer to you. Your word outranks every agent's." problem={show(problems.human)}>
          {(f) => <input id={f.id} className="input mono" value={human} onChange={(e) => setHuman(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} autoComplete="off" spellCheck={false} />}
        </Field>
        <Field label="Time zone" hint="Dates and the nightly sleep follow it." problem={show(problems.timezone)}>
          {(f) => (
            <>
              <input id={f.id} className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} list="sz-zones" autoComplete="off" spellCheck={false} />
              <datalist id="sz-zones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <ChipsInput label="Domains (your lanes)" values={domains} onChange={setDomains} validate={domainProblem} placeholder="add a domain…" />
        <p className="hint sz-wide sz-flush">Domains are the areas an agent can be the authority on, like housing or career. You give agents authority over them in the party step.</p>
        {d.seeds.length > 0 && (
          <Field label="Start from" hint={seed === "example-relocation" ? "A fictional campaign (a move to Lisbon, with a residency agent, a home finder and friends) to look around in before you make your own." : seed ? "Copies the seed's example notes into the new vault." : "An empty vault: just the template."}>
            {(f) => (
              <select id={f.id} className="select" value={seed} onChange={(e) => setSeed(e.target.value)} aria-describedby={f.describedBy}>
                <option value="">The empty template</option>
                {d.seeds.map((s) => (
                  <option key={s} value={s}>
                    Seed: {s}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <MakeDefault checked={makeDefault} onChange={setMakeDefault} envFile={status.envFile} what="HIPPO_VAULT" />
      </div>
      <Effects
        items={[
          ["writes", <>a new folder at <code>{dir.trim() || "…"}</code> from the vault template (config, Obsidian templates, Dataview dashboards){seed ? <>, plus the <code>{seed}</code> notes</> : null}, with your choices in <code>_hippo/config.yaml</code>.</>],
          ["runs", <><code>git init</code> in that folder. Nothing is committed or pushed.</>],
          makeDefault && ["writes", <>HIPPO_VAULT to <code>{status.envFile}</code>.</>],
          ["never", "sends anything off this machine."],
        ]}
      />
      {tried && !valid && (
        <p className="sz-problem" role="alert">
          A few fields need a look before the vault can be made.
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          <Icon name="codex" /> {busy ? "Creating…" : "Create the vault"}
        </button>
      </div>
    </form>
  );
}

function OpenForm({ status, busy, onSubmit }: { status: LocalSetupStatus; busy: boolean; onSubmit: Submit }) {
  const [dir, setDir] = useState("");
  const [makeDefault, setMakeDefault] = useState(true);
  const [tried, setTried] = useState(false);
  const problem = dir.trim() ? undefined : "Type the vault's folder.";
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (problem) return;
        onSubmit({ action: "open", dir: dir.trim(), makeDefault }, `Opened the vault at ${dir.trim()}.`);
      }}
    >
      <div className="sz-form">
        <Field label="Vault folder" hint="The folder that has _hippo/config.yaml in it." problem={tried ? problem : undefined} wide>
          {(f) => <input id={f.id} className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder="~/vaults/lisbon-arc" autoComplete="off" spellCheck={false} />}
        </Field>
        <MakeDefault checked={makeDefault} onChange={setMakeDefault} envFile={status.envFile} what="HIPPO_VAULT" />
      </div>
      <Effects
        items={[
          ["reads", "the folder, to check it is a vault and which format it uses."],
          makeDefault && ["writes", <>HIPPO_VAULT to <code>{status.envFile}</code>.</>],
          ["never", "changes a file in the vault just by opening it."],
        ]}
      />
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          <Icon name="codex" /> {busy ? "Opening…" : "Open the vault"}
        </button>
      </div>
    </form>
  );
}

function GithubForm({ status, busy, onSubmit }: { status: LocalSetupStatus; busy: boolean; onSubmit: Submit }) {
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [token, setToken] = useState("");
  const [makeDefault, setMakeDefault] = useState(true);
  const [tried, setTried] = useState(false);
  const problem = REPO.test(repo.trim()) ? undefined : "Use owner/name, e.g. player/lisbon-arc.";
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (problem) return;
        onSubmit({ action: "github", repo: repo.trim(), branch: branch.trim() || undefined, token: token || undefined, makeDefault }, `Connected to ${repo.trim()}.`);
        setToken("");
      }}
    >
      <div className="sz-form">
        <Field label="Repository" hint="Your private vault repository, as owner/name." problem={tried ? problem : undefined}>
          {(f) => <input id={f.id} className="input mono" value={repo} onChange={(e) => setRepo(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder="player/lisbon-arc" autoComplete="off" spellCheck={false} />}
        </Field>
        <Field label="Branch (optional)" hint="The repository's default branch if empty.">
          {(f) => <input id={f.id} className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} aria-describedby={f.describedBy} placeholder="main" autoComplete="off" spellCheck={false} />}
        </Field>
        <Field label="Token (optional)" hint="A fine-grained token with Contents: read and write on this repository only. Leave empty to use GITHUB_TOKEN from your environment. It is never shown here again." wide>
          {(f) => <input id={f.id} type="password" className="input mono" value={token} onChange={(e) => setToken(e.target.value)} aria-describedby={f.describedBy} autoComplete="new-password" spellCheck={false} />}
        </Field>
        <MakeDefault checked={makeDefault} onChange={setMakeDefault} envFile={status.envFile} what="HIPPO_GITHUB_REPO" />
      </div>
      <Effects
        items={[
          ["contacts", "GitHub's API to read the repository. Later writes are one commit each; nothing is cloned to this machine."],
          makeDefault && ["writes", <>the connection to <code>{status.envFile}</code>.</>],
          ["never", "shows the token back to this page."],
        ]}
      />
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          <Icon name="github" /> {busy ? "Connecting…" : "Connect the repository"}
        </button>
      </div>
    </form>
  );
}

function McpForm({ busy, onSubmit }: { busy: boolean; onSubmit: Submit }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [tried, setTried] = useState(false);
  const normalized = normalizeUrl(url);
  const problem = normalized ? undefined : "Use the server's https URL (http only for localhost).";
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!normalized) return;
        onSubmit({ action: "mcp", url: normalized, token: token || undefined }, `Connected to ${normalized}.`);
        setToken("");
      }}
    >
      <div className="sz-form">
        <Field label="MCP server URL" hint="For example your Worker's …/mcp endpoint." problem={tried ? problem : undefined} wide>
          {(f) => <input id={f.id} className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder="https://hippocampus.example.workers.dev/mcp" autoComplete="off" spellCheck={false} inputMode="url" />}
        </Field>
        <Field label="Agent token (optional)" hint="The dashboard acts with this token's agent and scopes. It is never shown here again." wide>
          {(f) => <input id={f.id} type="password" className="input mono" value={token} onChange={(e) => setToken(e.target.value)} aria-describedby={f.describedBy} autoComplete="new-password" spellCheck={false} />}
        </Field>
      </div>
      <Effects
        items={[
          ["contacts", "the MCP server, to read the vault through it."],
          ["never", "does more than the token allows: steps that need the vault's files (secrets, git, the nightly sleep) stay with the machine that has them."],
        ]}
      />
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          <Icon name="link" /> {busy ? "Connecting…" : "Connect the server"}
        </button>
      </div>
    </form>
  );
}
