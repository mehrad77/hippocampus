import { useState } from "react";
import type { LlmServer, LlmSettings, LlmSetupRequest } from "@hippocampus/dashboard";
import { postJson } from "../../lib/api.ts";
import { useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Effects, ErrorCallout, Field, refreshSetup, useAction } from "./common.tsx";
import { LLM_PROVIDERS, providerDef, providerForServer, type StepProps } from "./model.ts";

interface TestResult {
  ok: boolean;
  model: string;
  ms: number;
  error?: string;
}

export function LlmStep({ status }: StepProps) {
  // What the server holds; updated from each save's answer so the form settles at once.
  const [saved, setSaved] = useState<LlmSettings>(status.llm);
  const [provider, setProvider] = useState(saved.provider);
  const [model, setModel] = useState(saved.model);
  const [baseURL, setBaseURL] = useState(saved.baseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [keySet, setKeySet] = useState(saved.apiKey === "set");
  const [tried, setTried] = useState(false);
  const servers = useResource<{ servers: LlmServer[] }>("/setup/llm/models");
  const save = useAction();
  const test = useAction();
  const [result, setResult] = useState<TestResult>();

  const def = providerDef(LLM_PROVIDERS, provider);
  const showsURL = def?.baseURL !== undefined;
  const urlRequired = def?.baseURL === "required";
  const showsKey = def?.key !== "none" || keySet;
  const savedURL = saved.baseURL ?? "";
  const dirty = provider !== saved.provider || model.trim() !== saved.model || (showsURL ? baseURL.trim() : "") !== (showsURL ? savedURL : "") || !!apiKey || removeKey;
  const problems = {
    model: model.trim() ? undefined : "Name the model.",
    baseURL: urlRequired && !baseURL.trim() ? "This provider needs the server's URL." : baseURL.trim() && !/^https?:\/\//.test(baseURL.trim()) ? "Start with http:// or https://." : undefined,
  };
  const valid = !problems.model && !problems.baseURL;

  const pickProvider = (next: string) => {
    const before = providerDef(LLM_PROVIDERS, provider);
    const after = providerDef(LLM_PROVIDERS, next);
    // Swap in the new provider's defaults unless the user typed their own.
    if (!baseURL.trim() || baseURL === before?.baseURL) setBaseURL(after?.baseURL && after.baseURL !== "required" ? after.baseURL : "");
    if (!model.trim() || model === before?.modelHint) setModel(after?.modelHint && !after.modelHint.includes(" ") ? after.modelHint : "");
    setProvider(next);
  };

  const submit = async () => {
    setTried(true);
    if (!valid) return;
    const body: LlmSetupRequest = { provider, model: model.trim() };
    if (showsURL && baseURL.trim()) body.baseURL = baseURL.trim();
    if (removeKey) body.apiKey = null;
    else if (apiKey) body.apiKey = apiKey;
    const res = await save.run(() => postJson<LlmSettings>("/setup/llm", body));
    if (!res) return;
    // Settle on what the server stored (it may drop a default base URL, for instance).
    setSaved(res);
    setProvider(res.provider);
    setModel(res.model);
    setBaseURL(res.baseURL ?? "");
    setApiKey("");
    setRemoveKey(false);
    setKeySet(res.apiKey === "set");
    setResult(undefined);
    toast(`Curator settings saved to ${status.envFile}.`, "ok");
    void refreshSetup();
  };

  const runTest = async () => {
    setResult(undefined);
    const res = await test.run(() => postJson<TestResult>("/setup/llm/test", {}));
    if (res) setResult(res);
  };

  const found = servers.data?.servers.filter((s) => s.models.length) ?? [];
  const suggestions = [...new Set(found.filter((s) => providerForServer(s.name) === provider || provider === "openai-compatible").flatMap((s) => s.models))];

  return (
    <div className="stack">
      <Effects
        items={[
          ["writes", <>HIPPO_LLM_* settings (and the key, if you give one) to <code>{status.envFile}</code>. The nightly sleep reads them from there.</>],
          ["contacts", <>LM Studio (:1234) and Ollama (:11434) on this machine, to list their models. Testing sends one short prompt to the saved model{def?.key === "required" ? ", which for a hosted API means its servers" : ""}.</>],
          ["never", "sends a saved API key back to this page."],
        ]}
      />

      {saved.overriddenBy.length > 0 && (
        <div className="callout callout--warn" role="note">
          <Icon name="warn" />
          <div>
            <strong>Your shell or a .env file wins over these settings:</strong> {saved.overriddenBy.map((v, i) => (
              <span key={v}>
                {i > 0 && ", "}
                <code>{v}</code>
              </span>
            ))}
            . Remove {saved.overriddenBy.length === 1 ? "it" : "them"} there if you want what you save here to apply.
          </div>
        </div>
      )}

      {found.length > 0 && (
        <div className="sz-card sz-found">
          <div className="sz-card__head">
            <Icon name="sparkle" />
            <strong>Found on this machine</strong>
          </div>
          {found.map((s) => (
            <div key={s.url} className="stack sz-tight">
              <span className="small">
                {s.name} at <span className="mono">{s.url}</span>
              </span>
              <div className="row">
                {s.models.map((m) => {
                  const p = providerForServer(s.name);
                  const on = provider === p && model === m && baseURL === s.url;
                  return (
                    <button
                      key={m}
                      type="button"
                      className="chip"
                      aria-pressed={on}
                      onClick={() => {
                        setProvider(p);
                        setBaseURL(s.url);
                        setModel(m);
                      }}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {servers.data && !found.length && (
        <p className="small muted">
          No model server answered on this machine. Start LM Studio's server or Ollama and{" "}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void servers.reload()}>
            <Icon name="refresh" size={14} /> look again
          </button>
          , or use a hosted API.
        </p>
      )}

      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="sz-form">
          <Field label="Provider">
            {(f) => (
              <select id={f.id} className="select" value={provider} onChange={(e) => pickProvider(e.target.value)}>
                {LLM_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                {!def && <option value={provider}>{provider}</option>}
              </select>
            )}
          </Field>
          <Field label="Model" hint={def ? `e.g. ${def.modelHint}` : undefined} problem={tried ? problems.model : undefined}>
            {(f) => (
              <>
                <input id={f.id} className="input mono" value={model} onChange={(e) => setModel(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} list="sz-llm-models" autoComplete="off" spellCheck={false} />
                <datalist id="sz-llm-models">
                  {suggestions.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          {showsURL && (
            <Field label={urlRequired ? "Base URL" : "Base URL (optional)"} hint={urlRequired ? "The server's OpenAI-compatible endpoint, usually ending in /v1." : `Default: ${def?.baseURL}`} problem={tried ? problems.baseURL : undefined} wide>
              {(f) => <input id={f.id} className="input mono" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder={urlRequired ? "http://localhost:8000/v1" : def?.baseURL} autoComplete="off" spellCheck={false} inputMode="url" />}
            </Field>
          )}
          {showsKey && (
            <Field
              label={def?.key === "required" ? "API key" : "API key (optional)"}
              hint={
                keySet && !removeKey
                  ? "A key is saved. Type a new one to replace it."
                  : def?.keyEnv
                    ? `Or leave empty and set ${def.keyEnv} in your environment.`
                    : "Only if your server asks for one."
              }
              wide
            >
              {(f) => (
                <div className="sz-keyrow">
                  <input
                    id={f.id}
                    type="password"
                    className="input mono"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setRemoveKey(false);
                    }}
                    aria-describedby={f.describedBy}
                    placeholder={keySet && !removeKey ? "•••••••• saved" : ""}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  {keySet && (
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      aria-pressed={removeKey}
                      onClick={() => {
                        setRemoveKey((v) => !v);
                        setApiKey("");
                      }}
                    >
                      {removeKey ? "Keep the saved key" : "Remove the saved key"}
                    </button>
                  )}
                </div>
              )}
            </Field>
          )}
        </div>
        {removeKey && <p className="small sz-warn-text">The saved key will be removed when you save.</p>}
        {save.error !== undefined && <ErrorCallout error={save.error} />}
        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={save.busy || !dirty}>
            <Icon name="brain" /> {save.busy ? "Saving…" : dirty ? "Save curator settings" : "Saved"}
          </button>
          <button type="button" className="btn" onClick={() => void runTest()} disabled={test.busy || dirty}>
            <Icon name={test.busy ? "hourglass" : "sparkle"} className={test.busy ? "sz-spin" : undefined} /> {test.busy ? "Asking the curator…" : "Test the curator"}
          </button>
          {dirty && <span className="hint">Save first: the test uses the saved settings.</span>}
        </div>
      </form>

      {result &&
        (result.ok ? (
          <div className="callout callout--ok" role="status">
            <Icon name="check" />
            <div>
              The curator answered in <strong>{(result.ms / 1000).toFixed(result.ms < 10_000 ? 1 : 0)} s</strong> with <span className="mono">{result.model}</span>. It's ready to sleep on your inbox.
            </div>
          </div>
        ) : (
          <div className="callout callout--danger" role="alert">
            <Icon name="warn" />
            <div>
              <strong>The curator didn't answer properly</strong> (<span className="mono">{result.model}</span>, {result.ms} ms).
              <div>{result.error ?? "No error message."}</div>
            </div>
          </div>
        ))}
      {test.error !== undefined && <ErrorCallout error={test.error} />}
    </div>
  );
}
