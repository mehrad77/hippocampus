import { useState } from "react";
import { postJson } from "../../lib/api.ts";
import { toast } from "../../lib/events.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Effects, ErrorCallout, Field, JobRunner, refreshSetup, Snippets, StateBadge, useAction } from "./common.tsx";
import { EMBED_PROVIDERS, normalizeUrl, providerDef, workerDeploySteps, type StepProps } from "./model.ts";

interface Reach {
  mcp: boolean;
  oauth: boolean;
  dashboard: boolean;
  error?: string;
}

export function RemoteStep({ status, hasVault }: StepProps) {
  const savedUrl = status.remote.workerUrl ?? "";
  return (
    <div className="stack">
      <Effects
        items={[
          ["writes", <>the Worker's URL and the embedding settings (HIPPO_EMBED_*) to <code>{status.envFile}</code>.</>],
          ["contacts", "your Worker, only when you press Check."],
          ["shows", "the Cloudflare and GitHub steps to deploy a Worker. Deploying is yours to run; nothing here talks to Cloudflare."],
        ]}
      />
      <WorkerUrl saved={savedUrl} />
      <DeployGuide url={savedUrl} open={!savedUrl} />
      <Embeddings status={status} savedUrl={savedUrl} hasVault={hasVault} />
    </div>
  );
}

function WorkerUrl({ saved }: { saved: string }) {
  const [url, setUrl] = useState(saved);
  const [tried, setTried] = useState(false);
  const [reach, setReach] = useState<Reach>();
  const check = useAction();
  const save = useAction();
  const normalized = normalizeUrl(url);
  const problem = url.trim() && !normalized ? "Use the Worker's https URL (http only for localhost)." : undefined;

  const runCheck = async () => {
    setTried(true);
    if (!normalized) return;
    setReach(undefined);
    const res = await check.run(() => postJson<Reach>("/setup/remote/check", { url: normalized }));
    if (res) setReach(res);
  };
  const runSave = async () => {
    setTried(true);
    if (problem) return;
    // An empty string clears the saved URL.
    const res = await save.run(() => postJson<{ ok: boolean }>("/setup/remote", { workerUrl: normalized ?? "" }));
    if (!res) return;
    if (normalized) setUrl(normalized);
    toast(normalized ? "Worker URL saved." : "Worker URL cleared.", "ok");
    void refreshSetup();
  };

  return (
    <section className="stack" aria-labelledby="sz-worker-h">
      <h3 className="sz-subhead" id="sz-worker-h">
        Your Worker
      </h3>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void runCheck();
        }}
      >
        <Field label="Worker URL" hint="Where your Worker answers, e.g. https://hippocampus.<your-subdomain>.workers.dev" problem={tried ? problem : undefined} wide>
          {(f) => <input id={f.id} className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder="https://hippocampus.example.workers.dev" inputMode="url" autoComplete="off" spellCheck={false} />}
        </Field>
        <div className="row">
          <button type="submit" className="btn" disabled={check.busy || !normalized}>
            <Icon name="eye" /> {check.busy ? "Checking…" : "Check"}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void runSave()} disabled={save.busy || (normalized ?? "") === saved}>
            <Icon name="cloud" /> {save.busy ? "Saving…" : url.trim() ? "Save" : "Clear"}
          </button>
        </div>
      </form>
      {reach && (
        <ul className="sz-reach" aria-label="What answered">
          <ReachRow ok={reach.mcp} label="MCP endpoint" detail="/mcp, where agents and connectors talk to it" />
          <ReachRow ok={reach.oauth} label="OAuth sign-in" detail="needed for Claude.ai and ChatGPT connectors" />
          <ReachRow ok={reach.dashboard} label="Dashboard" detail="this dashboard, served by the Worker" />
        </ul>
      )}
      {reach?.error && (
        <div className="callout callout--warn" role="status">
          <Icon name="warn" />
          <div>{reach.error}</div>
        </div>
      )}
      {check.error !== undefined && <ErrorCallout error={check.error} />}
      {save.error !== undefined && <ErrorCallout error={save.error} />}
    </section>
  );
}

function ReachRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li>
      <StateBadge state={ok ? "done" : "error"} compact />
      <span>
        <strong>{label}</strong> <span className="small muted">· {ok ? "answers" : "no answer"}, {detail}</span>
      </span>
    </li>
  );
}

function DeployGuide({ url, open }: { url: string; open: boolean }) {
  const steps = workerDeploySteps(url);
  return (
    <details className="sz-more sz-deploy" open={open}>
      <summary>
        <Icon name="cloud" size={18} /> Deploy a Worker <span className="small muted">· about 15 minutes, on Cloudflare's free plan</span>
      </summary>
      <p className="small">
        The Worker reads your private vault repository through GitHub's API, keeps its search index in D1, and writes every memory as one commit. It doesn't run the nightly sleep, so keep the one on this machine.
      </p>
      <ol className="sz-deploy__steps">
        {steps.map((s) => (
          <li key={s.title} className="sz-deploy__step">
            <h4>{s.title}</h4>
            <p className="small">{s.detail}</p>
            <Snippets snippets={s.snippets} />
          </li>
        ))}
      </ol>
    </details>
  );
}

function Embeddings({ status, savedUrl, hasVault }: { status: StepProps["status"]; savedUrl: string; hasVault: boolean }) {
  const saved = status.remote.embed;
  const [provider, setProvider] = useState(saved?.provider ?? (saved?.model ? "lmstudio" : "off"));
  const [model, setModel] = useState(saved?.model ?? "");
  const [baseURL, setBaseURL] = useState(saved?.baseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [tried, setTried] = useState(false);
  const save = useAction();
  const def = providerDef(EMBED_PROVIDERS, provider);
  const off = provider === "off";
  const urlRequired = def?.baseURL === "required";
  const problems = {
    model: !off && !model.trim() ? "Name the embedding model." : undefined,
    baseURL: urlRequired && !baseURL.trim() ? "This provider needs the API's URL." : baseURL.trim() && !/^https?:\/\//.test(baseURL.trim()) ? "Start with http:// or https://." : undefined,
  };
  const valid = !problems.model && !problems.baseURL;

  const submit = async () => {
    setTried(true);
    if (!valid) return;
    const embed = off ? { provider: "off" } : { provider, model: model.trim(), baseURL: baseURL.trim() || undefined, apiKey: apiKey || undefined };
    const res = await save.run(() => postJson<{ ok: boolean }>("/setup/remote", savedUrl ? { workerUrl: savedUrl, embed } : { embed }));
    if (!res) return;
    setApiKey("");
    toast(off ? "Semantic recall is off: search uses keywords." : "Embedding settings saved. Rebuild the index to use them.", "ok");
    void refreshSetup();
  };

  return (
    <section className="stack" aria-labelledby="sz-embed-h">
      <h3 className="sz-subhead" id="sz-embed-h">
        Semantic recall
      </h3>
      <p className="small">
        With an embedding model, recall also finds notes by meaning (“accommodation” finds the apartment hunt), not just by keyword. Notes are embedded once, and again only when they change. A multilingual model such as bge-m3 suits vaults that mix languages.
      </p>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="sz-form">
          <Field label="Embeddings">
            {(f) => (
              <select id={f.id} className="select" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {EMBED_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                {!def && <option value={provider}>{provider}</option>}
              </select>
            )}
          </Field>
          {!off && (
            <>
              <Field label="Model" hint={def?.modelHint ? `e.g. ${def.modelHint}` : undefined} problem={tried ? problems.model : undefined}>
                {(f) => <input id={f.id} className="input mono" value={model} onChange={(e) => setModel(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} autoComplete="off" spellCheck={false} />}
              </Field>
              <Field label={urlRequired ? "Base URL" : "Base URL (optional)"} hint={urlRequired ? "The API's OpenAI-compatible endpoint." : def?.baseURL ? `Default: ${def.baseURL}` : undefined} problem={tried ? problems.baseURL : undefined} wide>
                {(f) => <input id={f.id} className="input mono" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder={def?.baseURL && def.baseURL !== "required" ? def.baseURL : "https://…/v1"} inputMode="url" autoComplete="off" spellCheck={false} />}
              </Field>
              {def?.key !== "none" && (
                <Field label="API key (optional)" hint="Only if the API asks for one. It is never shown here again." wide>
                  {(f) => <input id={f.id} type="password" className="input mono" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={saved?.apiKey === "set" ? "Saved (leave empty to keep it)" : undefined} aria-describedby={f.describedBy} autoComplete="new-password" spellCheck={false} />}
                </Field>
              )}
            </>
          )}
        </div>
        {saved?.model && (
          <p className="hint sz-flush">
            Saved now: {saved.provider ?? "lmstudio"} · <span className="mono">{saved.model}</span>
          </p>
        )}
        {save.error !== undefined && <ErrorCallout error={save.error} />}
        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={save.busy}>
            <Icon name="sparkle" /> {save.busy ? "Saving…" : "Save embedding settings"}
          </button>
        </div>
      </form>
      <p className="small">
        On the Worker, semantic recall is set with <code>wrangler secret put HIPPO_EMBED_PROVIDER</code> (<code>workers-ai</code> uses Cloudflare's bge-m3) or the same HIPPO_EMBED_* settings pointed at a hosted embeddings API.
      </p>
      <h4 className="sz-subhead">Rebuild the index</h4>
      <JobRunner
        kind="reindex"
        label="Rebuild the index"
        disabled={!hasVault}
        idleHint={hasVault ? "Re-reads the vault and embeds what changed. The vault itself isn't modified." : "Needs a vault first."}
      />
    </section>
  );
}
