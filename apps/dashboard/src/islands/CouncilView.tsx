import { useId, useState } from "react";
import "../styles/play.css";
import { postJson } from "../lib/api.ts";
import { patch, useResource } from "../lib/cache.ts";
import { toast } from "../lib/events.ts";
import { fieldLabel, plural, titleCase } from "../lib/format.ts";
import { href } from "../lib/routes.ts";
import type { ClaimView, DisputeView, Overview, PartyMember, RuleResult, SessionInfo, Shown } from "../lib/types.ts";
import { EntityLink } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Dialog, Panel, RelTime, SkeletonPanel } from "../ui/Parts.tsx";
import { Seal } from "../ui/Seal.tsx";
import { Value } from "../ui/Value.tsx";
import { errorMessage, settle, useHashTarget } from "../ui/play/actions.ts";
import { AuthorityBadge, PageHead } from "../ui/play/Bits.tsx";
import { roman } from "../ui/play/model.ts";

type Choice = { kind: "claim"; index: number } | { kind: "value"; value: string } | { kind: "pending" };
interface Proposal {
  d: DisputeView;
  choice: Choice;
}

export default function CouncilView() {
  return <PageGate>{(session) => <Council session={session} />}</PageGate>;
}

function Council({ session }: { session: SessionInfo }) {
  const { data: o, error } = useResource<Overview>("/overview", { poll: 60_000 });
  const [proposal, setProposal] = useState<Proposal | null>(null);
  useHashTarget(!!o);
  if (error && !o) return <div className="callout callout--danger">{error.message}</div>;
  if (!o)
    return (
      <div className="grid grid--main">
        <SkeletonPanel lines={8} />
        <SkeletonPanel lines={5} />
      </div>
    );

  const human = session.human ?? o.human;
  const canRule = session.capabilities.rule;
  // The longest-waiting case first.
  const disputes = [...o.attention.disputes].sort((a, b) => (a.opened ?? "").localeCompare(b.opened ?? ""));
  return (
    <div className="stack play" style={{ ["--gap" as string]: "28px" }}>
      <PageHead
        kicker={<>The council chamber · {o.campaign}</>}
        title="The Council"
        lede={
          disputes.length ? (
            <>
              {plural(disputes.length, "dispute")} await{disputes.length === 1 ? "s" : ""} your ruling. Your sources disagree and precedence couldn't settle it safely, so the curator left the choice to you.
              {canRule ? " Whatever you rule becomes canon at once." : " Rule in Obsidian by writing ruling: in each dispute note; the next sleep applies it."}
            </>
          ) : (
            "Where disagreements between agents come for your ruling."
          )
        }
      />
      <div className="grid grid--main council">
        <div className="stack" style={{ ["--gap" as string]: "24px" }}>
          {disputes.length ? disputes.map((d) => <Case key={d.slug} d={d} party={o.party} human={human} canRule={canRule} onPropose={setProposal} />) : <Adjourned />}
        </div>
        <HowItWorks />
      </div>
      <RulingDialog proposal={proposal} human={human} onClose={() => setProposal(null)} />
    </div>
  );
}

// ── One case ───────────────────────────────────────────────────────────────

function Case({ d, party, human, canRule, onPropose }: { d: DisputeView; party: PartyMember[]; human: string; canRule: boolean; onPropose: (p: Proposal) => void }) {
  const titleId = useId();
  const sameAsNow = (c: ClaimView) => !!d.current && !c.secret && !d.current.secret && c.value !== null && c.value === d.current.value;
  return (
    <article className="case panel" id={d.slug} aria-labelledby={titleId}>
      <header className="case__head">
        <div>
          <div className="case__kicker">
            Case of the {fieldLabel(d.field)}
            {d.opened && (
              <>
                {" "}
                · opened <RelTime at={d.opened} />
              </>
            )}
          </div>
          <h2 className="case__title" id={titleId}>
            <EntityLink entity={d.entity} /> <span className="case__field">· {fieldLabel(d.field)}</span>
          </h2>
        </div>
        <Seal status="disputed" />
      </header>

      <div className="case__now">
        <span className="label">In the codex now</span>
        {d.current ? (
          <span className="row">
            <Value shown={d.current} /> <Seal status={d.current.status} />
            <span className="muted small">set by {d.current.byHuman ? `${human} (you)` : d.current.by}</span>
          </span>
        ) : (
          <span className="muted">No value recorded yet.</span>
        )}
      </div>

      {d.ruling && (
        <div className="callout callout--ok case__written">
          <Icon name="quill" />
          <div className="stack" style={{ ["--gap" as string]: "8px" }}>
            <div>
              You already wrote a ruling in Obsidian: <strong><Value shown={d.ruling} /></strong>. The next sleep applies it{canRule ? ", or apply it now." : "."}
            </div>
            {canRule && (
              <div>
                <button type="button" className="btn btn--sm btn--primary" onClick={() => onPropose({ d, choice: { kind: "pending" } })}>
                  <Icon name="check" size={16} /> Apply the ruling you wrote
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <ol className="claims" aria-label="Claims">
        {d.claims.map((c, i) => (
          <li key={i} className={`claim${sameAsNow(c) ? " claim--now" : ""}`}>
            <div className="claim__num">
              Claim {roman(i + 1)}
              {sameAsNow(c) && <span className="chip claim__tag">in the codex now</span>}
            </div>
            <div className="claim__value">
              <Value shown={c} />
            </div>
            <dl className="claim__facts">
              <dt>Who</dt>
              <dd>
                <span className="row" style={{ ["--gap" as string]: "6px" }}>
                  <Who c={c} party={party} human={human} />
                  <AuthorityBadge authority={c.authority} />
                </span>
              </dd>
              <dt>When</dt>
              <dd>{c.at ? <RelTime at={c.at} /> : <span className="muted">not recorded</span>}</dd>
              <dt>Sources</dt>
              <dd className="claim__src">
                {c.src.length ? (
                  c.src.map((s) => (
                    <a key={s} className="mono" href={href.chronicle(c.at?.slice(0, 7), s)} title="Find this episode in the chronicle">
                      {s}
                    </a>
                  ))
                ) : (
                  <span className="muted">none</span>
                )}
              </dd>
            </dl>
            {canRule && (
              <button
                type="button"
                className="btn btn--sm claim__rule"
                onClick={() => onPropose({ d, choice: { kind: "claim", index: i } })}
                aria-label={`Rule for claim ${roman(i + 1)}${c.secret ? " (sealed value)" : `: ${c.value ?? "empty"}`}`}
              >
                <Icon name="council" size={16} /> Rule for this claim
              </button>
            )}
          </li>
        ))}
      </ol>

      {canRule && <DifferentValue d={d} onPropose={onPropose} />}
    </article>
  );
}

function Who({ c, party, human }: { c: ClaimView; party: PartyMember[]; human: string }) {
  if (c.byHuman) return <strong>{human} (you)</strong>;
  const member = party.find((p) => p.slug === c.by.toLowerCase());
  if (member) return <EntityLink entity={member} />;
  return (
    <span title="Not in the party: no party note for this agent">
      {titleCase(c.by)} <span className="muted small mono">{c.by}</span>
    </span>
  );
}

function DifferentValue({ d, onPropose }: { d: DisputeView; onPropose: (p: Proposal) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const inputId = useId();
  const whyId = useId();
  if (d.secretField)
    return (
      <div className="case__custom">
        <button type="button" className="btn btn--sm btn--ghost" disabled aria-describedby={whyId}>
          <Icon name="lock" size={16} /> Different value…
        </button>
        <p className="hint" id={whyId}>
          This field holds a secret. A value typed here would be written into the note as plain text, so rule for one of the sealed claims instead.
        </p>
      </div>
    );
  if (!open)
    return (
      <div className="case__custom">
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(true)}>
          <Icon name="quill" size={16} /> Different value…
        </button>
        <span className="hint">Neither claim is right? Rule the true value yourself.</span>
      </div>
    );
  const v = value.trim();
  return (
    <form
      className="case__custom case__custom--open"
      onSubmit={(e) => {
        e.preventDefault();
        if (v) onPropose({ d, choice: { kind: "value", value: v } });
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
          setValue("");
        }
      }}
    >
      <label className="label" htmlFor={inputId}>
        The true {fieldLabel(d.field)}
      </label>
      <div className="inline-form">
        <input id={inputId} className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} autoFocus placeholder="Type the value as it should read in the codex" />
        <button type="submit" className="btn btn--sm btn--primary" disabled={!v}>
          Rule this value…
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => {
            setOpen(false);
            setValue("");
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Ruling ─────────────────────────────────────────────────────────────────

function decreeOf(p: Proposal): { shown: Shown; body: Record<string, unknown> } {
  const { d, choice } = p;
  if (choice.kind === "claim") return { shown: d.claims[choice.index]!, body: { dispute: d.slug, claim: choice.index } };
  if (choice.kind === "value") return { shown: { value: choice.value, secret: false }, body: { dispute: d.slug, value: choice.value } };
  return { shown: d.ruling ?? { value: null, secret: false }, body: { dispute: d.slug, pending: true } };
}

function RulingDialog({ proposal, human, onClose }: { proposal: Proposal | null; human: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  // Keep the last proposal on screen while the dialog closes.
  const [last, setLast] = useState<Proposal | null>(null);
  if (proposal && proposal !== last) setLast(proposal);
  const p = proposal ?? last;

  const submit = async () => {
    if (!p) return;
    const { d } = p;
    setBusy(true);
    try {
      const res = await postJson<RuleResult>("/actions/rule", decreeOf(p).body);
      patch<Overview>("/overview", (o) => ({
        ...o,
        attention: { ...o.attention, disputes: o.attention.disputes.filter((x) => x.slug !== d.slug) },
        counts: { ...o.counts, disputes: Math.max(0, o.counts.disputes - 1) },
      }));
      toast(`So ruled: ${d.entity.title} · ${fieldLabel(d.field)} is canon${res.secret || res.value === null ? "" : `: ${res.value}`}.`, "ok");
      onClose();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
      void settle();
    }
  };

  const decree = p ? decreeOf(p) : undefined;
  return (
    <Dialog
      open={!!proposal}
      onClose={() => !busy && onClose()}
      title={
        <span className="row">
          <Icon name="council" /> Make it canon?
        </span>
      }
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Not yet
          </button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={busy || !p}>
            <Icon name="check" /> {busy ? "Sealing…" : "Make it canon"}
          </button>
        </>
      }
    >
      {p && decree && (
        <div className="stack">
          <div className="decree">
            <div className="decree__label">The council rules</div>
            <div className="decree__line">
              {p.d.entity.title} · {fieldLabel(p.d.field)}
            </div>
            <div className="decree__value">
              <Value shown={decree.shown} />
            </div>
            {p.choice.kind === "claim" && <div className="small muted">Claim {roman(p.choice.index + 1)}, as {p.d.claims[p.choice.index]?.byHuman ? "you" : p.d.claims[p.choice.index]?.by} reported it.</div>}
            {p.choice.kind === "pending" && <div className="small muted">The ruling you wrote in the dispute note.</div>}
            <span className="decree__seal" aria-hidden>
              ✓
            </span>
          </div>
          <ul className="consequences">
            <li>
              <Icon name="check" />
              <span>
                <strong>It becomes canon immediately</strong> in {p.d.entity.title}'s note. No need to wait for a sleep.
              </span>
            </li>
            <li>
              <Icon name="quill" />
              <span>
                It's written as <strong>{human}</strong>, the human. Human authority outranks every agent: none can replace it, and a later disagreement comes back here as a new case.
              </span>
            </li>
            <li>
              <Icon name="council" />
              <span>
                The dispute is marked <strong>resolved</strong> and leaves the council. The value it replaces stays in the fact's history.
              </span>
            </li>
          </ul>
        </div>
      )}
    </Dialog>
  );
}

// ── Asides ─────────────────────────────────────────────────────────────────

function Adjourned() {
  return (
    <div className="panel adjourned">
      <span className="adjourned__seal" aria-hidden>
        <Icon name="council" size={34} />
      </span>
      <h2 className="adjourned__title">The council is adjourned</h2>
      <p>No disputes wait for your ruling. Every fact in the codex agrees with itself.</p>
      <p className="small muted">When sources disagree and precedence can't settle it, the case lands here after a sleep.</p>
      <a className="btn btn--sm" href={href.page("tavern")}>
        <Icon name="tavern" size={16} /> Back to the tavern
      </a>
    </div>
  );
}

function HowItWorks() {
  return (
    <aside className="council__aside">
      <Panel title="How the council works" icon="scroll">
        <p className="small">When sources disagree about a fact and precedence can't settle it safely, the curator doesn't guess. It opens a case here and the field stays disputed until you rule. Even your own word can be challenged: if an agent reports something different, you decide whether things changed.</p>
        <div className="label">Who outranks whom</div>
        <ol className="precedence">
          <li>
            <strong>Your word</strong>
            <span>The human outranks every agent, always.</span>
          </li>
          <li>
            <strong>Lane authority</strong>
            <span>An agent whose authority covers the entity's type or tags.</span>
          </li>
          <li>
            <strong>Corroboration</strong>
            <span>Several agents reporting the same value turn a rumor into canon.</span>
          </li>
          <li>
            <strong>Recency</strong>
            <span>A newer report from the same source replaces its older one.</span>
          </li>
        </ol>
        <p className="small muted">
          You can also rule in Obsidian: write <code>ruling:</code> in the dispute note, and the next sleep applies it.
        </p>
        <a href={href.guide("precedence-and-disputes")}>Read the guide on precedence and disputes →</a>
      </Panel>
    </aside>
  );
}
