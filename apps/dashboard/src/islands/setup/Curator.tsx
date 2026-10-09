import { useState } from "react";
import { postJson } from "../../lib/api.ts";
import { patch, useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { plural } from "../../lib/format.ts";
import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import type { CuratorStatus } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Empty, Panel, RelTime, SkeletonPanel } from "../../ui/Parts.tsx";
import { ConfirmDialog, ErrorCallout, Facts, ToneTag, useAction } from "./common.tsx";
import { OUTCOME_TONE } from "./hosted.ts";

type Run = NonNullable<CuratorStatus["run"]>;
type Past = CuratorStatus["history"][number];

const newestFirst = (runs: readonly Past[]) => [...runs].sort((a, b) => b.ended.localeCompare(a.ended));

/** The agent-run sleep: the open run (with abort) and the runs before it. No memory content, only counts. */
export function CuratorPanel({ repo, branch }: { repo?: string; branch?: string }) {
  const { v } = useTerms();
  const s = useResource<CuratorStatus>("/curator", { poll: 30_000 });
  const [aborting, setAborting] = useState<Run>();
  const abort = useAction();

  return (
    <Panel title={v("Curator", "The curator")} icon="moonStars" id="sz-curator" aside={<a className="small" href="#curator">How to set one up</a>}>
      {s.error && !s.data ? (
        <ErrorCallout error={s.error} onRetry={() => void s.reload()} />
      ) : !s.data ? (
        <SkeletonPanel lines={3} />
      ) : (
        <div className="stack">
          {s.data.run ? <OpenRun run={s.data.run} onAbort={() => setAborting(s.data?.run)} /> : <p className="small muted">{v("No update is running right now.", "Nobody is sleeping right now.")}</p>}
          <History runs={newestFirst(s.data.history)} repo={repo} branch={branch} />
        </div>
      )}
      <ConfirmDialog
        open={!!aborting}
        onClose={() => {
          setAborting(undefined);
          abort.clear();
        }}
        title={v("Stop this run?", "Wake the curator?")}
        confirmLabel="Stop the run"
        danger
        busy={abort.busy}
        onConfirm={async () => {
          if (!aborting) return;
          const next = await abort.run(() => postJson<CuratorStatus>("/actions/curator", { abort: aborting.id }));
          if (!next) return;
          patch<CuratorStatus>("/curator", () => next);
          toast("Stopped the run.", "ok");
          setAborting(undefined);
          void s.reload();
        }}
      >
        {aborting && (
          <p>
            <strong>{aborting.curator}</strong> ({aborting.model}) stops where it is, after {aborting.progress.done} of {plural(aborting.progress.total, aborting.progress.unit)}. What it already committed stays; the rest waits in the inbox for the next run.
          </p>
        )}
        {abort.error !== undefined && <ErrorCallout error={abort.error} />}
      </ConfirmDialog>
    </Panel>
  );
}

function OpenRun({ run, onAbort }: { run: Run; onAbort: () => void }) {
  const { v } = useTerms();
  const { done, total, unit } = run.progress;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <section className="sz-card" aria-label="The open run">
      <div className="sz-card__head">
        <Icon name="hourglass" />
        <strong>{v("Running now", "Sleeping now")}</strong>
        {run.live ? <ToneTag tone="wait" word="Running" title="The curator holds the lease and is answering" compact /> : <ToneTag tone="error" word="Lease expired" title="The curator stopped answering; the run ends on its own, or stop it now" compact />}
      </div>
      <Facts
        rows={[
          ["Curator", <span className="mono">{run.curator}</span>],
          ["Model", <span className="mono sz-break">{run.model}</span>],
          ["Started", <RelTime at={run.started} />],
          [
            "Progress",
            <span className="hz-progress">
              <progress max={total || 1} value={done} aria-label={`${done} of ${total} ${unit}`} />
              <span className="small">
                {done} of {plural(total, unit)} ({pct}%)
              </span>
            </span>,
          ],
          ["Lease", run.live ? <>ends <RelTime at={run.leaseUntil} /> unless it keeps answering</> : <>ran out <RelTime at={run.leaseUntil} /></>],
        ]}
      />
      <div className="row">
        <button type="button" className="btn btn--sm btn--danger" onClick={onAbort}>
          <Icon name="close" size={16} /> Stop the run…
        </button>
      </div>
    </section>
  );
}

function History({ runs, repo, branch }: { runs: Past[]; repo?: string; branch?: string }) {
  const { v } = useTerms();
  if (!runs.length)
    return (
      <Empty icon="moonStars" title={v("No runs yet", "The curator hasn't slept yet")}>
        <a href="#curator">Set up a curator</a> to turn the inbox into records.
      </Empty>
    );
  return (
    <div className="table-wrap">
      <table className="table hz-rtable">
        <caption className="sr-only">Past runs, newest first</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Curator</th>
            <th scope="col">Outcome</th>
            <th scope="col">Consolidated</th>
            <th scope="col">Failed</th>
            <th scope="col">Skipped</th>
            <th scope="col">Commits</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const o = OUTCOME_TONE[r.outcome];
            return (
              <tr key={r.id}>
                <td data-label="When">
                  <RelTime at={r.ended} />
                </td>
                <td data-label="Curator">
                  <span className="mono">{r.curator}</span>
                  <span className="small muted sz-break"> {r.model}</span>
                </td>
                <td data-label="Outcome">
                  <ToneTag tone={o.tone} word={o.word} title={o.help} compact />
                </td>
                <td data-label="Consolidated">{r.consolidated}</td>
                <td data-label="Failed">{r.failed ? <strong className="sz-danger-text">{r.failed}</strong> : 0}</td>
                <td data-label="Skipped">{r.skipped}</td>
                <td data-label="Commits">
                  {r.commits ? (
                    repo ? (
                      <a href={href.githubCommits(repo, branch)} rel="noopener noreferrer" title="The vault's history on GitHub">
                        {plural(r.commits, "commit")}
                      </a>
                    ) : (
                      plural(r.commits, "commit")
                    )
                  ) : (
                    <span className="muted">none</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One line for the inbox page: the run going on now, or the last one. */
export function CuratorLine() {
  const { v } = useTerms();
  const s = useResource<CuratorStatus>("/curator", { poll: 60_000 });
  if (!s.data) return null;
  const run = s.data.run;
  const last = newestFirst(s.data.history)[0];
  const o = last ? OUTCOME_TONE[last.outcome] : undefined;
  return (
    <p className="hz-curline small" role="status">
      <Icon name="moonStars" size={16} />
      <span>
        {run ? (
          <>
            <strong>{v("Updating now:", "Sleeping now:")}</strong> <span className="mono">{run.curator}</span> ({run.model}), {run.progress.done} of {plural(run.progress.total, run.progress.unit)}.
          </>
        ) : last && o ? (
          <>
            <strong>{v("Last curator run", "Last sleep")}</strong> <RelTime at={last.ended} /> by <span className="mono">{last.curator}</span> ({last.model}): {last.consolidated} consolidated
            {last.failed ? `, ${last.failed} failed` : ""}
            {last.skipped ? `, ${last.skipped} skipped` : ""}. <ToneTag tone={o.tone} word={o.word} title={o.help} compact />
          </>
        ) : (
          v("No curator has run yet.", "No curator has slept yet.")
        )}
      </span>
      <a href={href.page("setup", "#sz-curator")}>Curator →</a>
    </p>
  );
}
