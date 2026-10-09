import { useRef, useState } from "react";
import { postJson } from "../../lib/api.ts";
import { invalidate, useResource } from "../../lib/cache.ts";
import { toast } from "../../lib/events.ts";
import { titleCase } from "../../lib/format.ts";
import { readPrefs, useTerms } from "../../lib/prefs.ts";
import type { Catalog, Overview, PartyMember } from "../../lib/types.ts";
import { EntityLink } from "../../ui/EntityLink.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Empty, RelTime, SkeletonPanel } from "../../ui/Parts.tsx";
import { DomainChips, Effects, ErrorCallout, Field, useAction } from "./common.tsx";
import { agentIdProblem, type StepProps } from "./model.ts";

interface NewMember {
  id: string;
  title: string;
  lane?: string;
  authority?: string[];
  host?: string;
}

/** `POST actions/party` (the main API, so it works wherever the source can add members), then refresh what shows the party. */
export async function addPartyMember(body: NewMember): Promise<{ slug: string; path: string }> {
  const res = await postJson<{ slug: string; path: string }>("/actions/party", body);
  toast(readPrefs().look === "codex" ? `${body.title} joined the party (${res.path}).` : `Added ${body.title} as an agent (${res.path}).`, "ok");
  void invalidate((k) => k.startsWith("/overview") || k.startsWith("/catalog") || k.startsWith("/setup") || k.startsWith("/entity"));
  return res;
}

export function PartyStep({ session, status }: StepProps) {
  const { v } = useTerms();
  const overview = useResource<Overview>("/overview");
  const catalog = useResource<Catalog>("/catalog");
  const [prefill, setPrefill] = useState<string>();
  const formRef = useRef<HTMLDivElement>(null);
  const domains = catalog.data?.domains ?? status.defaults.domains;
  const members = overview.data?.party ?? [];
  const taken = [...members.map((m) => m.slug), ...(session.human ? [session.human] : [])];
  const canAdd = session.capabilities.party;

  return (
    <div className="stack">
      <Effects
        items={[
          ["writes", <>one note per agent, <code>party/&lt;id&gt;.md</code>, in the vault, signed by you. It's an ordinary note: change it in Obsidian any time.</>],
          [
            "never",
            v(
              "gives an agent authority you didn't tick. Without authority, what an agent reports stays unverified until another source confirms it.",
              "gives an agent authority you didn't tick. Without authority, an agent's word stays a rumor until something corroborates it.",
            ),
          ],
        ]}
      />

      <UnknownAgents
        ids={status.unknownAgents.filter((a) => !taken.includes(a))}
        canAdd={canAdd}
        onCustomize={(id) => {
          setPrefill(id);
          window.setTimeout(() => formRef.current?.querySelector("input")?.focus(), 0);
        }}
      />

      <h3 className="sz-subhead">{v("Your agents", "Around the table")}</h3>
      {overview.error && !overview.data ? (
        <ErrorCallout error={overview.error} onRetry={() => void overview.reload()} />
      ) : !overview.data ? (
        <SkeletonPanel lines={3} />
      ) : members.length ? (
        <MemberList members={members} />
      ) : (
        <Empty icon="party" title={v("No agents yet", "No one at the table yet")}>
          Add your first agent below.
        </Empty>
      )}

      <h3 className="sz-subhead">{v("Add an agent", "Add a party member")}</h3>
      <div ref={formRef}>
        {canAdd ? (
          <AddMember key={prefill ?? ""} initialId={prefill} domains={domains} taken={taken} />
        ) : (
          <div className="callout callout--warn">
            <Icon name="warn" />
            <div>
              {v("This vault can't add agents from the dashboard.", "This vault can't take new party members from the dashboard.")} Add a note to <code>party/</code> in Obsidian instead.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function UnknownAgents({ ids, canAdd, onCustomize }: { ids: readonly string[]; canAdd: boolean; onCustomize?: (id: string) => void }) {
  const { v } = useTerms();
  const action = useAction();
  const [adding, setAdding] = useState<string>();
  if (!ids.length) return null;
  return (
    <div className="callout callout--warn">
      <Icon name="party" />
      <div className="stack sz-tight">
        <strong>
          {ids.length === 1
            ? v("An unknown agent sends notes to the inbox", "A stranger writes to the inbox")
            : v(`${ids.length} unknown agents send notes to the inbox`, `${ids.length} strangers write to the inbox`)}
        </strong>
        <span className="small">
          {v(
            "These agents sent notes but aren't set up as agents yet, so what they report stays unverified. Add them:",
            "These agents filed memories but have no party note, so their word counts as rumor. Give them a seat:",
          )}
        </span>
        <ul className="sz-strangers">
          {ids.map((id) => (
            <li key={id}>
              <span className="mono">{id}</span>
              {canAdd && (
                <span className="row">
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={action.busy}
                    onClick={async () => {
                      setAdding(id);
                      await action.run(() => addPartyMember({ id, title: titleCase(id) }));
                      setAdding(undefined);
                    }}
                  >
                    <Icon name="plus" size={16} /> {adding === id ? "Adding…" : `Add as “${titleCase(id)}”`}
                  </button>
                  {onCustomize && (
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => onCustomize(id)}>
                      With details…
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
        {action.error !== undefined && <ErrorCallout error={action.error} />}
      </div>
    </div>
  );
}

function MemberList({ members }: { members: readonly PartyMember[] }) {
  const { v } = useTerms();
  return (
    <ul className="list sz-members">
      {members.map((p) => (
        <li key={p.slug} className="sz-member">
          <div className="sz-member__head">
            <EntityLink entity={p} />
            <span className="mono small muted">{p.slug}</span>
            <span className="small muted sz-member__seen">{p.lastSeen ? <>seen <RelTime at={p.lastSeen} /></> : "not seen yet"}</span>
          </div>
          {p.lane && <div className="small">{p.lane}</div>}
          <div className="row small">
            {p.authority.length ? (
              <>
                <span className="muted">Authority:</span>
                {p.authority.map((a) => (
                  <span key={a} className="chip">
                    {a}
                  </span>
                ))}
              </>
            ) : (
              <span className="muted">{v("No authority yet: what it reports stays unverified until another source confirms it.", "No authority yet: its word is a rumor until corroborated.")}</span>
            )}
            {p.host && <span className="muted">· runs in {p.host}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function AddMember({ initialId, domains, taken }: { initialId?: string; domains: readonly string[]; taken: readonly string[] }) {
  const { v } = useTerms();
  const [id, setId] = useState(initialId ?? "");
  const [title, setTitle] = useState(initialId ? titleCase(initialId) : "");
  const [lane, setLane] = useState("");
  const [authority, setAuthority] = useState<string[]>([]);
  const [host, setHost] = useState("");
  const [tried, setTried] = useState(false);
  const action = useAction();
  const cleanId = id.trim();
  const problem = agentIdProblem(cleanId, taken);

  const reset = () => {
    setId("");
    setTitle("");
    setLane("");
    setAuthority([]);
    setHost("");
    setTried(false);
  };

  return (
    <form
      className="stack sz-card"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setTried(true);
        if (problem) return;
        const res = await action.run(() =>
          addPartyMember({ id: cleanId, title: title.trim() || titleCase(cleanId), lane: lane.trim() || undefined, authority: authority.length ? authority : undefined, host: host.trim() || undefined }),
        );
        if (res) reset();
      }}
    >
      <div className="sz-form">
        <Field label="Id" hint={v("How it signs its notes. Lowercase letters, digits and dashes.", "How it signs its memories. Lowercase letters, digits and dashes.")} problem={tried || cleanId ? problem : undefined}>
          {(f) => <input id={f.id} className="input mono" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} aria-describedby={f.describedBy} aria-invalid={f.invalid} placeholder="residency-agent" autoComplete="off" spellCheck={false} />}
        </Field>
        <Field label="Name" hint={v("Shown on its profile.", "Shown on its character sheet.")}>
          {(f) => <input id={f.id} className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-describedby={f.describedBy} placeholder={cleanId ? titleCase(cleanId) : "Residency Agent"} maxLength={120} />}
        </Field>
        <Field label={v("Role (optional)", "Lane (optional)")} hint="What it handles, in a sentence." wide>
          {(f) => <input id={f.id} className="input" value={lane} onChange={(e) => setLane(e.target.value)} aria-describedby={f.describedBy} placeholder="Visa, residence permit and the migration agency" maxLength={500} />}
        </Field>
        <div className="field sz-wide">
          <span>Authority (optional)</span>
          {domains.length ? (
            <DomainChips domains={domains} value={authority} onChange={setAuthority} label="Authority over domains" />
          ) : (
            <span className="hint">
              This vault has no domains yet. Add some under <code>domains</code> in <code>_hippo/config.yaml</code>.
            </span>
          )}
          <span className="hint">{v("Topics where its reports count as confirmed on their own. Your edits still outrank it.", "Where its word becomes canon on its own. Yours still outranks it.")}</span>
        </div>
        <Field label="Runs in (optional)" hint="The app or machine it lives in, as a reminder.">
          {(f) => <input id={f.id} className="input" value={host} onChange={(e) => setHost(e.target.value)} aria-describedby={f.describedBy} placeholder="Claude Desktop" maxLength={120} />}
        </Field>
      </div>
      {action.error !== undefined && <ErrorCallout error={action.error} />}
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={action.busy}>
          <Icon name="party" /> {action.busy ? "Adding…" : v("Add the agent", "Add to the party")}
        </button>
        {cleanId && !problem && (
          <span className="hint">
            Writes <code>party/{cleanId}.md</code>
          </span>
        )}
      </div>
    </form>
  );
}
