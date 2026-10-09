import { useState } from "react";
import type { LocalSetupStatus, ScheduleStatus } from "@hippocampus/dashboard";
import { postJson } from "../../lib/api.ts";
import { patch } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { Icon } from "../../ui/Icon.tsx";
import { RelTime } from "../../ui/Parts.tsx";
import { ConfirmDialog, Effects, ErrorCallout, Facts, Field, JobRunner, refreshSetup, SnippetBlock, useAction } from "./common.tsx";
import { hhmm, pad2, type StepProps } from "./model.ts";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function ScheduleStep({ status }: StepProps) {
  const sched = status.schedule;
  const [hour, setHour] = useState(sched.hour ?? 3);
  const [minute, setMinute] = useState(sched.minute ?? 30);
  const [confirm, setConfirm] = useState<"install" | "remove">();
  const [limit, setLimit] = useState(5);
  const action = useAction();
  const plist = sched.plistPath ?? `~/Library/LaunchAgents/${sched.label}.plist`;
  const minutes = [...new Set([...Array.from({ length: 12 }, (_, i) => i * 5), minute])].sort((a, b) => a - b);
  const changed = !sched.installed || sched.hour !== hour || sched.minute !== minute;

  const apply = async (body: { hour: number; minute: number } | { remove: true }) => {
    const res = await action.run(() => postJson<ScheduleStatus>("/setup/schedule", body));
    setConfirm(undefined);
    if (!res) return;
    patch<LocalSetupStatus>("/setup/status", (s) => ({ ...s, schedule: res }));
    toast("remove" in body ? "The nightly sleep is unscheduled." : `The curator will sleep at ${hhmm(body.hour, body.minute)} every night.`, "ok");
    void refreshSetup();
  };

  return (
    <div className="stack">
      {sched.supported ? (
        <Effects
          items={[
            ["writes", <>a launchd agent, <code className="sz-break">{plist}</code>, and loads it with launchctl. Removing it unloads and deletes that file.</>],
            ["runs", <>hippo sleep for this vault every night at the time you pick, with the curator settings from <code>{status.envFile}</code>. If your Mac is asleep then, launchd runs it when it wakes.</>],
            ["never", "touches the vault by scheduling. The dry run below writes nothing either."],
          ]}
        />
      ) : (
        <Effects
          items={[
            ["shows", "a cron line for you to add yourself. This dashboard installs schedules only on macOS."],
            ["never", "touches the vault. The dry run below writes nothing either."],
          ]}
        />
      )}

      <Facts
        rows={[
          ["Scheduled", sched.installed ? (sched.hour !== undefined && sched.minute !== undefined ? `Every night at ${hhmm(sched.hour, sched.minute)}` : "Yes") : <span className="sz-warn-text">Not yet</span>],
          ...(sched.installed ? ([["Loaded", sched.loaded === false ? <strong className="sz-warn-text">No: installed but not loaded</strong> : "Yes"]] as [string, React.ReactNode][]) : []),
          ...(sched.nextRun ? ([["Next sleep", <RelTime at={sched.nextRun} />]] as [string, React.ReactNode][]) : []),
          ["Platform", sched.platform],
        ]}
      />

      {sched.supported && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setConfirm("install");
          }}
        >
          <div className="sz-form sz-form--time">
            <Field label="Hour">
              {(f) => (
                <select id={f.id} className="select" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {pad2(h)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Minute">
              {(f) => (
                <select id={f.id} className="select" value={minute} onChange={(e) => setMinute(Number(e.target.value))}>
                  {minutes.map((m) => (
                    <option key={m} value={m}>
                      {pad2(m)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <p className="hint sz-flush">A quiet hour works best, after your agents are done for the day and before you wake. Times are this machine's local time.</p>
          <div className="row">
            <button type="submit" className="btn btn--primary" disabled={action.busy || !changed}>
              <Icon name="moonStars" /> {sched.installed ? (changed ? `Move it to ${hhmm(hour, minute)}` : `Sleeping at ${hhmm(hour, minute)}`) : `Sleep nightly at ${hhmm(hour, minute)}`}
            </button>
            {sched.installed && (
              <button type="button" className="btn btn--danger" onClick={() => setConfirm("remove")} disabled={action.busy}>
                Remove the schedule
              </button>
            )}
          </div>
        </form>
      )}

      {action.error !== undefined && <ErrorCallout error={action.error} />}

      {sched.supported ? (
        <details className="sz-more">
          <summary>Prefer cron?</summary>
          <SnippetBlock snippet={{ label: "Add with crontab -e", lang: "text", code: sched.cron }} />
        </details>
      ) : (
        <SnippetBlock snippet={{ label: "Add this line with crontab -e", lang: "text", code: sched.cron, note: "Or run the same command from a systemd timer. It needs the curator settings in its environment." }} />
      )}

      <h3 className="sz-subhead">Rehearse a sleep</h3>
      <p>
        A dry run reads up to a few inbox episodes and shows what the curator would make of them, <strong>without writing anything</strong>. It uses the saved curator model, so it can take a minute or two; with a hosted API, the episodes it reads are sent there.
      </p>
      <div className="row">
        <label className="field sz-limit">
          <span>Episodes</span>
          <input className="input" type="number" min={1} max={50} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
        </label>
      </div>
      <JobRunner kind="sleep-dry-run" limit={limit} label="Rehearse a sleep (dry run)" idleHint="Nothing is written to the vault." />

      <ConfirmDialog
        open={confirm === "install"}
        onClose={() => setConfirm(undefined)}
        title={sched.installed ? "Move the nightly sleep?" : "Schedule the nightly sleep?"}
        confirmLabel={sched.installed ? `Move it to ${hhmm(hour, minute)}` : `Schedule it at ${hhmm(hour, minute)}`}
        busy={action.busy}
        onConfirm={() => void apply({ hour, minute })}
      >
        <p>
          This writes <code className="sz-break">{plist}</code> and loads it with launchctl, so your Mac runs <code>hippo sleep</code> on this vault at <strong>{hhmm(hour, minute)}</strong> every night.
        </p>
        <p className="muted">Remove it here any time.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "remove"} onClose={() => setConfirm(undefined)} title="Remove the nightly sleep?" confirmLabel="Remove it" danger busy={action.busy} onConfirm={() => void apply({ remove: true })}>
        <p>
          This unloads the launchd agent and deletes <code className="sz-break">{plist}</code>. The vault is untouched; episodes simply wait in the inbox until the next sleep you run.
        </p>
      </ConfirmDialog>
    </div>
  );
}
