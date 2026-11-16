import { useState } from "react";
import { CURATION_PLACES } from "@hippocampus/dashboard/connect";
import { postJson } from "../../lib/api.ts";
import { invalidate } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import type { HostedCuratorLlmRequest, HostedCuratorRunResult, HostedCuratorStatus, HostedLlmProvider, HostedStatus, HostedStepMix, HostedVaultCurator } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { RelTime } from "../../ui/Parts.tsx";
import { ErrorCallout, Field, refreshSetup, ToneTag, useAction } from "./common.tsx";
import {
  capProblems,
  curatorError,
  curatorProviders,
  ESTIMATE_ASSUMES,
  estimatePer100,
  hourOptions,
  isUniform,
  keyNeeded,
  LLM_STEPS,
  modelsOf,
  money,
  outcomeTone,
  pausedBanner,
  priceWords,
  PROVIDER_WORDS,
  RUN_NOTHING_TO_DO,
  standbyWords,
  startingMix,
  stopTone,
  uniformMix,
} from "./hosted.ts";

const TITLE = CURATION_PLACES.find((p) => p.id === "hosted")!.title;

type Mode = "recommended" | "one" | "steps";

/**
 * Hippocampus runs this vault's nightly sleep itself, with the owner's own model key: the provider and
 * models, the write-only key, the caps, the nightly hour, Run now, this month's spend, any pause, and who
 * stands by. Only the owner sees it. `compact` (onboarding) leaves out the last run and the standby.
 */
export function HostedCurator({ status, compact }: { status: HostedStatus; compact?: boolean }) {
  const c = status.hostedCurator;
  if (!c?.available) return null;
  return <HostedCuratorCard c={c} compact={compact} />;
}

function HostedCuratorCard({ c, compact }: { c: HostedCuratorStatus; compact?: boolean }) {
  const { v } = useTerms();
  const providers = curatorProviders(c.models);
  const [provider, setProvider] = useState<HostedLlmProvider>(c.provider ?? providers[0] ?? "anthropic");
  const first = startingMix(c, provider);
  const [mode, setMode] = useState<Mode>(first?.recommended ? "recommended" : first && !isUniform(first.mix) ? "steps" : "one");
  const [one, setOne] = useState(first?.mix.mentions ?? "");
  const [steps, setSteps] = useState<HostedStepMix | undefined>(first?.mix);
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [caps, setCaps] = useState({ month: String(c.monthCapUsd ?? 10), run: String(c.runCapUsd ?? 2) });
  const [tried, setTried] = useState(false);
  const save = useAction();

  const models = modelsOf(c.models, provider);
  const rec = c.recommended[provider];
  const mix: HostedStepMix | undefined = mode === "recommended" ? rec : mode === "one" ? (one ? uniformMix(one) : undefined) : steps;
  const per100 = mix ? estimatePer100(mix, c.models, provider) : undefined;
  const needsKey = keyNeeded(c, provider);
  const showKeyField = needsKey || replacing;
  const problems = { ...capProblems(caps), key: showKeyField && needsKey && !key.trim() ? `Paste your ${PROVIDER_WORDS[provider]} API key.` : undefined };
  const valid = !problems.month && !problems.run && !problems.key && !!mix;
  const monthCap = Number(caps.month);

  const pickProvider = (next: HostedLlmProvider) => {
    setProvider(next);
    const start = startingMix(c, next);
    setMode(start?.recommended ? "recommended" : start && !isUniform(start.mix) ? "steps" : "one");
    setOne(start?.mix.mentions ?? "");
    setSteps(start?.mix);
  };

  const submit = async () => {
    setTried(true);
    if (!valid || !mix) return;
    const body: HostedCuratorLlmRequest = { provider, steps: mix, monthCapUsd: Number(caps.month), runCapUsd: Number(caps.run), ...(key.trim() ? { key: key.trim() } : {}) };
    const res = await save.run(() => postJson<HostedCuratorStatus>("/setup/curator-llm", body).catch((e: unknown) => Promise.reject(curatorError(e))));
    // The key leaves the page with the request: the field empties whatever the answer.
    setKey("");
    if (!res) return;
    setReplacing(false);
    setTried(false);
    toast(body.key ? `Saved. ${PROVIDER_WORDS[provider]} accepted the key; it won't be shown again.` : "Saved.", "ok");
    await refreshSetup();
  };

  const paused = c.paused;
  const spentPct = c.monthCapUsd ? Math.min(100, Math.round((c.spentThisMonthUsd / c.monthCapUsd) * 100)) : 0;
  const tone = paused ? { tone: "warn" as const, word: "Paused" } : c.vault?.enabled ? { tone: "done" as const, word: "On" } : c.keyHint ? { tone: "na" as const, word: "Off for this vault" } : { tone: "todo" as const, word: "Not set up" };

  return (
    <section className="sz-card hz-hosted" aria-labelledby="hz-hosted-title">
      <div className="sz-card__head">
        <Icon name="cloud" />
        <strong id="hz-hosted-title">{TITLE}</strong>
        <ToneTag tone={tone.tone} word={tone.word} compact />
      </div>

      {paused && <PausedBanner paused={paused} standby={c.vault?.standby} />}

      <p className="small">
        {v(
          "Hippocampus runs this vault's sleep every night itself, with your own model key, and stops at the caps you set. Nothing of yours has to stay on.",
          "Hippocampus sleeps on the party's notes every night itself, with your own model key, and stops at the caps you set. Nothing of yours has to stay on.",
        )}
      </p>
      <ul className="hz-hosted__notes small">
        <li>
          <Icon name="lock" size={16} />
          <span>
            {v("Every new memory, secret and confidential ones included, goes to ", "Every new note of the party's, secrets and confidential ones included, goes to ")}
            <strong>{PROVIDER_WORDS[provider]}</strong> under your key while it's curated. Pick a provider you trust with them.
          </span>
        </li>
        <li>
          <Icon name="party" size={16} />
          <span>
            {v("Members' agents add to the inbox this key pays for. The monthly cap is what bounds it.", "Every player's agents add to the satchel this key pays for. The monthly cap is what bounds it.")}
          </span>
        </li>
      </ul>

      {c.monthCapUsd !== undefined && (
        <div className="hz-hosted__spend">
          <span className="small">
            This month: <strong>{money(c.spentThisMonthUsd)}</strong> of {money(c.monthCapUsd)}
          </span>
          <progress max={100} value={spentPct} aria-label={`${spentPct}% of this month's cap spent`} />
        </div>
      )}

      <div className="sz-form">
        <Field label="Provider">
          {(f) => (
            <select id={f.id} className="input" value={provider} onChange={(e) => pickProvider(e.target.value as HostedLlmProvider)}>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_WORDS[p] ?? p}
                </option>
              ))}
            </select>
          )}
        </Field>
        <KeyField provider={provider} hint={!needsKey ? c.keyHint : undefined} showField={showKeyField} value={key} onChange={setKey} replacing={replacing} setReplacing={setReplacing} problem={tried ? problems.key : undefined} />
      </div>

      <fieldset className="sz-fieldset">
        <legend className="label">Models</legend>
        {rec ? (
          <label className="check sz-scope">
            <input type="radio" name="hz-hosted-mode" checked={mode === "recommended"} onChange={() => setMode("recommended")} />
            <span>
              <strong>The recommended mix</strong>
              <span className="small muted"> · picked by the curator eval: the cheapest model that does each step well</span>
            </span>
          </label>
        ) : (
          <p className="small muted">No recommended mix for {PROVIDER_WORDS[provider]} yet: the curator eval hasn't been run for it. Pick one model for every step.</p>
        )}
        {mode === "recommended" && rec && <MixList mix={rec} models={models} />}
        <label className="check sz-scope">
          <input type="radio" name="hz-hosted-mode" checked={mode === "one"} onChange={() => setMode("one")} />
          <span>
            <strong>One model for every step</strong>
          </span>
        </label>
        {mode === "one" && (
          <select className="input" value={one} onChange={(e) => setOne(e.target.value)} aria-label="The model for every step">
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.model} · {priceWords(m)}
              </option>
            ))}
          </select>
        )}
        <label className="check sz-scope">
          <input type="radio" name="hz-hosted-mode" checked={mode === "steps"} onChange={() => setMode("steps")} />
          <span>
            <strong>Advanced: a model for each step</strong>
          </span>
        </label>
        {mode === "steps" && (
          <div className="sz-form">
            {LLM_STEPS.map((s) => (
              <Field key={s.id} label={s.word} hint={s.help}>
                {(f) => (
                  <select id={f.id} className="input" aria-describedby={f.describedBy} value={steps?.[s.id] ?? ""} onChange={(e) => setSteps({ ...(steps ?? uniformMix(e.target.value)), [s.id]: e.target.value })}>
                    {models.map((m) => (
                      <option key={m.model} value={m.model}>
                        {m.model} · {priceWords(m)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ))}
          </div>
        )}
      </fieldset>

      {per100 !== undefined && (
        <p className="small hz-hosted__estimate">
          <strong>At most about {money(per100)} per 100 memories</strong>
          {Number.isFinite(monthCap) && monthCap > 0 && per100 > 0 ? <>, so a {money(monthCap)} monthly cap covers at least {Math.floor((monthCap / per100) * 100).toLocaleString("en-US")} a month</> : null}.{" "}
          <span className="muted">Assumes {ESTIMATE_ASSUMES}</span>
        </p>
      )}

      <div className="sz-form">
        <Field label="Monthly cap (USD)" hint="Runs pause once this month's spend reaches it." problem={tried ? problems.month : undefined}>
          {(f) => <input id={f.id} className="input" type="number" min={0} step="any" inputMode="decimal" value={caps.month} onChange={(e) => setCaps({ ...caps, month: e.target.value })} aria-describedby={f.describedBy} aria-invalid={tried && !!problems.month} />}
        </Field>
        <Field label="Per-run cap (USD)" hint="One night's run stops here; what it finished stays." problem={tried ? problems.run : undefined}>
          {(f) => <input id={f.id} className="input" type="number" min={0} step="any" inputMode="decimal" value={caps.run} onChange={(e) => setCaps({ ...caps, run: e.target.value })} aria-describedby={f.describedBy} aria-invalid={tried && !!problems.run} />}
        </Field>
      </div>

      {save.error !== undefined && <ErrorCallout error={save.error} />}
      <div className="row">
        <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={save.busy}>
          <Icon name="key" /> {save.busy ? "Checking the key…" : key.trim() ? "Save and check the key" : c.keyHint ? "Save" : "Save the key"}
        </button>
      </div>

      {c.keyHint && c.vault && <VaultSchedule vault={c.vault} compact={compact} />}
      {c.keyHint && !c.vault && <p className="small muted">The nightly hour and Run now are set per vault, by its owner, once the vault is ready.</p>}
    </section>
  );
}

/** The key: write-only. A saved one shows only its last characters, and can be replaced. */
function KeyField(p: { provider: HostedLlmProvider; hint?: string; showField: boolean; value: string; onChange: (v: string) => void; replacing: boolean; setReplacing: (b: boolean) => void; problem?: string }) {
  const label = `${PROVIDER_WORDS[p.provider]} API key`;
  if (!p.showField)
    return (
      <Field label={label} hint="Saved, sealed, and never shown again.">
        {(f) => (
          <span className="row sz-tight-row" id={f.id}>
            <span className="mono">{p.hint}</span>
            <button type="button" className="btn btn--sm" onClick={() => p.setReplacing(true)}>
              Replace key
            </button>
          </span>
        )}
      </Field>
    );
  return (
    <Field label={label} hint={`Hippocampus checks it with ${PROVIDER_WORDS[p.provider]}, seals it, and never shows it again.`} problem={p.problem}>
      {(f) => (
        <span className="sz-keyrow">
          <input
            id={f.id}
            className="input mono"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={p.value}
            onChange={(e) => p.onChange(e.target.value)}
            placeholder={p.provider === "anthropic" ? "sk-ant-…" : "your API key"}
            aria-describedby={f.describedBy}
            aria-invalid={!!p.problem}
          />
          {p.replacing && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => {
                p.onChange("");
                p.setReplacing(false);
              }}
            >
              Keep the saved key
            </button>
          )}
        </span>
      )}
    </Field>
  );
}

function MixList({ mix, models }: { mix: HostedStepMix; models: HostedCuratorStatus["models"] }) {
  return (
    <ul className="hz-hosted__mix small">
      {LLM_STEPS.map((s) => {
        const m = models.find((x) => x.model === mix[s.id]);
        return (
          <li key={s.id}>
            <strong>{s.word}</strong> <span className="mono sz-break">{mix[s.id]}</span>
            {m && <span className="muted"> · {priceWords(m)}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function PausedBanner({ paused, standby }: { paused: NonNullable<HostedCuratorStatus["paused"]>; standby: HostedVaultCurator["standby"] }) {
  const b = pausedBanner(paused, standby);
  return (
    <div className="callout callout--warn" role="status">
      <Icon name="warn" />
      <div className="stack sz-tight">
        <span>
          <strong>{b.head}.</strong>{" "}
          {b.standby ? (
            <>
              Your standby curator <code>{b.standby}</code> will run tonight.
            </>
          ) : (
            "No standby curator: nothing curates until this is fixed."
          )}
        </span>
        <span className="small">{b.fix}</span>
      </div>
    </div>
  );
}

/** The vault's part: on or off, the hour (shown in local time, stored as UTC), Run now, the last run and the standby. */
function VaultSchedule({ vault, compact }: { vault: HostedVaultCurator; compact?: boolean }) {
  const { v } = useTerms();
  const now = new Date();
  const options = hourOptions(now);
  const [hour, setHour] = useState<number>(vault.hourUtc ?? options.find((o) => o.label === "03:00")?.hourUtc ?? 3);
  const sched = useAction();
  const run = useAction();
  const utc = (h: number) => `${String(h).padStart(2, "0")}:00 UTC`;

  const setSchedule = async (hourUtc: number | null) => {
    const res = await sched.run(() => postJson<HostedVaultCurator>("/setup/curator-llm/vault", { hourUtc }).catch((e: unknown) => Promise.reject(curatorError(e))));
    if (!res) return;
    toast(hourUtc === null ? "Hosted curation is off for this vault." : `Hippocampus curates this vault every night at ${options.find((o) => o.hourUtc === hourUtc)?.label ?? utc(hourUtc)} your time.`, "ok");
    await refreshSetup();
  };

  const runNow = async () => {
    const res = await run.run(async () => {
      try {
        return await postJson<HostedCuratorRunResult>("/setup/curator-llm/run", {});
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        // Nothing waiting isn't a failure: say so, and stop there.
        if (typeof code === "string" && RUN_NOTHING_TO_DO.has(code)) return { nothing: (e as Error).message || "Nothing is waiting in the inbox." };
        throw curatorError(e);
      }
    });
    if (!res) return;
    if ("nothing" in res) toast(res.nothing, "info");
    else toast(v("Started a run. It shows under the runs as it goes.", "The curator went to sleep. The run shows under the runs as it goes."), "ok");
    await Promise.all([invalidate((k) => k === "/curator"), refreshSetup()]);
  };

  const last = vault.lastRun;
  const standby = standbyWords(vault.standby);
  return (
    <div className="stack sz-tight hz-hosted__vault">
      <hr className="hz-hosted__rule" />
      <label className="check">
        <input type="checkbox" checked={vault.enabled} disabled={sched.busy} onChange={(e) => void setSchedule(e.target.checked ? hour : null)} /> {v("Curate this vault every night", "Sleep on this campaign every night")}
      </label>
      <div className="sz-form">
        <Field label="At (your time)" hint={`Stored as ${utc(hour)}.`}>
          {(f) => (
            <select
              id={f.id}
              className="input"
              value={hour}
              disabled={sched.busy}
              aria-describedby={f.describedBy}
              onChange={(e) => {
                const h = Number(e.target.value);
                setHour(h);
                if (vault.enabled) void setSchedule(h);
              }}
            >
              {options.map((o) => (
                <option key={o.hourUtc} value={o.hourUtc}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="field">
          <span className="label">Next run</span>
          <span className="small">{vault.enabled && vault.nextRun ? <RelTime at={vault.nextRun} /> : <span className="muted">not scheduled</span>}</span>
        </div>
      </div>
      {sched.error !== undefined && <ErrorCallout error={sched.error} />}
      <div className="row">
        <button type="button" className="btn" onClick={() => void runNow()} disabled={run.busy || vault.running}>
          <Icon name="moonStars" /> {run.busy ? "Starting…" : vault.running ? "Running now…" : "Run now"}
        </button>
        <span className="small muted">Set-aside memories get another try, and it counts against the caps.</span>
      </div>
      {run.error !== undefined && <ErrorCallout error={run.error} />}

      {!compact && last && (
        <p className="small">
          <strong>Last hosted run</strong> <RelTime at={last.ended} />: {last.consolidated} consolidated
          {last.costUsd !== undefined ? <>, {money(last.costUsd)}</> : null}.{" "}
          {last.stop ? <StopTag stop={last.stop} /> : <OutcomeTag outcome={last.outcome} />}
        </p>
      )}
      {!compact && (
        <p className="small" role="status">
          {standby ? (
            <>
              <strong>Standby:</strong> <code>{standby.curator}</code>, checked in <RelTime at={standby.at} /> <span className="muted">({standby.decision})</span>.
            </>
          ) : (
            <>
              <strong>No standby:</strong> paste the setup prompt into an agent (<a href={href.page("setup", "#connections")}>Connect an app</a>), or raise the cap.
            </>
          )}{" "}
          <span className="muted">A standby curator runs only when hosted curation pauses or memories wait too long.</span>
        </p>
      )}
    </div>
  );
}

function StopTag({ stop }: { stop: string }) {
  const s = stopTone(stop);
  return <ToneTag tone={s.tone} word={s.word} title={s.help} compact />;
}

function OutcomeTag({ outcome }: { outcome: string }) {
  const o = outcomeTone(outcome);
  return <ToneTag tone={o.tone} word={o.word} title={o.help} compact />;
}
