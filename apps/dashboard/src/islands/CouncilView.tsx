import { useId, useState } from "react";
import "../styles/play.css";
import { postJson } from "../lib/api.ts";
import { patch, useResource } from "../lib/cache.ts";
import { toast } from "../lib/events.ts";
import { fieldLabel, plural, titleCase } from "../lib/format.ts";
import { useTerms } from "../lib/prefs.ts";
import { href } from "../lib/routes.ts";
import type { ClaimView, DisputeView, Overview, PartyMember, ProposalDecision, RuleResult, SessionInfo, Shown } from "../lib/types.ts";
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
  const { t, v } = useTerms();
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

  // Who "you" are: the human the dashboard acts as (several people may share the vault).
  const human = session.actor?.kind === "human" ? session.actor.id : (session.human ?? o.human);
  const canRule = session.capabilities.rule;
  const canDecide = !!session.capabilities.proposal;
  // The longest-waiting case first. Proposals and possible duplicates are asks, not disagreements.
  const all = [...o.attention.disputes].sort((a, b) => (a.opened ?? "").localeCompare(b.opened ?? ""));
  const disputes = all.filter((d) => (d.kind ?? "conflict") === "conflict");
  const proposals = all.filter((d) => d.kind === "proposal");
  const merges = all.filter((d) => d.kind === "merge");
  const name = o.name ?? o.campaign;
  return (
    <div className="stack play" style={{ ["--gap" as string]: "28px" }}>
      <PageHead
        kicker={v<React.ReactNode>(name, <>The council chamber · {name}</>)}
        title={v(t("council"), "The Council")}
        lede={
          disputes.length ? (
            v(
              <>
                {plural(disputes.length, "dispute")} need{disputes.length === 1 ? "s" : ""} your decision. Your sources disagree and the precedence rules couldn't settle it safely, so the choice is yours.
                {canRule ? " Your decision becomes the confirmed value right away." : " To decide in Obsidian, write ruling: in each dispute note; the next nightly update applies it."}
              </>,
              <>
                {plural(disputes.length, "dispute")} await{disputes.length === 1 ? "s" : ""} your ruling. Your sources disagree and precedence couldn't settle it safely, so the curator left the choice to you.
                {canRule ? " Whatever you rule becomes canon at once." : " Rule in Obsidian by writing ruling: in each dispute note; the next sleep applies it."}
              </>,
            )
          ) : (
            v("Disagreements between your agents come here for your decision.", "Where disagreements between agents come for your ruling.")
          )
        }
      />
      <div className="grid grid--main council">
        <div className="stack" style={{ ["--gap" as string]: "24px" }}>
          {disputes.length ? disputes.map((d) => <Case key={d.slug} d={d} party={o.party} human={human} canRule={canRule} onPropose={setProposal} />) : <Adjourned asks={proposals.length + merges.length} />}
          {proposals.length > 0 && (
            <section className="stack" aria-labelledby="proposals-h" style={{ ["--gap" as string]: "16px" }}>
              <h2 className="play-h" id="proposals-h">
                <Icon name="quill" /> {v("Suggestions", "Petitions")} <span className="play-h__count">{proposals.length}</span>
              </h2>
              <p className="muted small play-note">
                {v(
                  "Only a person sets these fields. An agent suggested a value: accept it, give your own, or decline (the same value isn't suggested again).",
                  "Only a player sets these fields. An agent petitions for a value: grant it, give your own, or turn it down (the same petition won't come back).",
                )}
              </p>
              {proposals.map((d) => (
                <ProposalCase key={d.slug} d={d} party={o.party} human={human} canDecide={canDecide} />
              ))}
            </section>
          )}
          {merges.length > 0 && (
            <section className="stack" aria-labelledby="merges-h" style={{ ["--gap" as string]: "16px" }}>
              <h2 className="play-h" id="merges-h">
                <Icon name="link" /> {v("Possible duplicates", "Two entries, one soul?")} <span className="play-h__count">{merges.length}</span>
              </h2>
              <p className="muted small play-note">
                {v(
                  "Two notes share something that identifies one thing (an email, an address). If they're the same, merge them in Obsidian; if not, decline and they won't be flagged again.",
                  "Two entries share a mark that names one thing. If they're one, merge them by hand in Obsidian; if not, decline and the council lets it rest.",
                )}
              </p>
              {merges.map((d) => (
                <MergeCase key={d.slug} d={d} canDecide={canDecide} />
              ))}
            </section>
          )}
        </div>
        <HowItWorks />
      </div>
      <RulingDialog proposal={proposal} human={human} onClose={() => setProposal(null)} />
    </div>
  );
}

// ── One case ───────────────────────────────────────────────────────────────

function Case({ d, party, human, canRule, onPropose }: { d: DisputeView; party: PartyMember[]; human: string; canRule: boolean; onPropose: (p: Proposal) => void }) {
  const { v } = useTerms();
  const titleId = useId();
  const sameAsNow = (c: ClaimView) => !!d.current && !c.secret && !d.current.secret && c.value !== null && c.value === d.current.value;
  return (
    <article className="case panel" id={d.slug} aria-labelledby={titleId}>
      <header className="case__head">
        <div>
          <div className="case__kicker">
            {v("Dispute about the", "Case of the")} {fieldLabel(d.field)}
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
        <span className="label">{v("Current value", "In the codex now")}</span>
        {d.current ? (
          <span className="row">
            <Value shown={d.current} /> <Seal status={d.current.status} />
            <span className="muted small">set by {d.current.byHuman && d.current.by.toLowerCase() === human.toLowerCase() ? `${human} (you)` : d.current.by}</span>
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
              {v("You already wrote a decision in Obsidian: ", "You already wrote a ruling in Obsidian: ")}
              <strong>
                <Value shown={d.ruling} />
              </strong>
              {v(". The next nightly update applies it", ". The next sleep applies it")}
              {canRule ? ", or apply it now." : "."}
            </div>
            {canRule && (
              <div>
                <button type="button" className="btn btn--sm btn--primary" onClick={() => onPropose({ d, choice: { kind: "pending" } })}>
                  <Icon name="check" size={16} /> {v("Apply your decision", "Apply the ruling you wrote")}
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
              Claim {v(String(i + 1), roman(i + 1))}
              {sameAsNow(c) && <span className="chip claim__tag">{v("current value", "in the codex now")}</span>}
            </div>
            <div className="claim__value">
              <Value shown={c} />
            </div>
            <dl className="claim__facts">
              <dt>Who</dt>
              <dd>
                <span className="row" style={{ ["--gap" as string]: "6px" }}>
                  <Who c={c} party={party} human={human} />
                  <AuthorityBadge authority={c.authority} by={c.by} me={human} />
                </span>
              </dd>
              <dt>When</dt>
              <dd>{c.at ? <RelTime at={c.at} /> : <span className="muted">not recorded</span>}</dd>
              <dt>Sources</dt>
              <dd className="claim__src">
                {c.src.length ? (
                  c.src.map((s) => (
                    <a key={s} className="mono" href={href.chronicle(c.at?.slice(0, 7), s)} title={v("Find this note in the timeline", "Find this episode in the chronicle")}>
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
                aria-label={v(`Choose claim ${i + 1}${c.secret ? " (hidden value)" : `: ${c.value ?? "empty"}`}`, `Rule for claim ${roman(i + 1)}${c.secret ? " (sealed value)" : `: ${c.value ?? "empty"}`}`)}
              >
                <Icon name="council" size={16} /> {v("Choose this claim", "Rule for this claim")}
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
  const { v } = useTerms();
  if (c.byHuman) return <strong>{c.by.toLowerCase() === human.toLowerCase() ? `${human} (you)` : c.by}</strong>;
  const member = party.find((p) => p.slug === c.by.toLowerCase());
  if (member) return <EntityLink entity={member} />;
  return (
    <span title={v("Not set up as an agent: there's no agent note for it", "Not in the party: no party note for this agent")}>
      {titleCase(c.by)} <span className="muted small mono">{c.by}</span>
    </span>
  );
}

function DifferentValue({ d, onPropose }: { d: DisputeView; onPropose: (p: Proposal) => void }) {
  const voice = useTerms();
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
          {voice.v(
            "This field holds a secret. A value typed here would be saved in the note as plain text, so choose one of the hidden claims instead.",
            "This field holds a secret. A value typed here would be written into the note as plain text, so rule for one of the sealed claims instead.",
          )}
        </p>
      </div>
    );
  if (!open)
    return (
      <div className="case__custom">
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(true)}>
          <Icon name="quill" size={16} /> Different value…
        </button>
        <span className="hint">{voice.v("Neither claim is right? Enter the correct value yourself.", "Neither claim is right? Rule the true value yourself.")}</span>
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
        {voice.v("The correct", "The true")} {fieldLabel(d.field)}
      </label>
      <div className="inline-form">
        <input id={inputId} className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} autoFocus placeholder={voice.v("Type the value exactly as it should be saved", "Type the value as it should read in the codex")} />
        <button type="submit" className="btn btn--sm btn--primary" disabled={!v}>
          {voice.v("Use this value…", "Rule this value…")}
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

// ── Proposals and possible duplicates ─────────────────────────────────────

/** Accept or decline a proposal (or decline a possible duplicate); the card leaves the list at once. */
async function decide(d: DisputeView, body: { decision: "accept" | "decline"; value?: string; claim?: number }, say: (accepted: string, declined: string) => string): Promise<boolean> {
  try {
    const res = await postJson<ProposalDecision>("/actions/proposal", { dispute: d.slug, ...body });
    patch<Overview>("/overview", (o) => ({
      ...o,
      attention: { ...o.attention, disputes: o.attention.disputes.filter((x) => x.slug !== d.slug) },
      counts: { ...o.counts, disputes: Math.max(0, o.counts.disputes - 1) },
    }));
    const shown = res.secret || res.confidential || res.value == null ? "" : `: ${res.value}`;
    toast(res.decision === "accepted" ? `${say("Accepted", "Granted")}: ${d.entity.title} · ${fieldLabel(d.field)}${shown}` : `${say("Declined", "Turned down")}: ${d.entity.title} · ${fieldLabel(d.field)}`, "ok");
    return true;
  } catch (err) {
    toast(errorMessage(err), "error");
    return false;
  } finally {
    void settle();
  }
}

function ProposalCase({ d, party, human, canDecide }: { d: DisputeView; party: PartyMember[]; human: string; canDecide: boolean }) {
  const { v } = useTerms();
  const titleId = useId();
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [own, setOwn] = useState<string | null>(null);
  const latest = d.claims.length - 1;
  const run = async (body: Parameters<typeof decide>[1]) => {
    setBusy(true);
    await decide(d, body, v);
    setBusy(false);
  };
  return (
    <article className="case panel" id={d.slug} aria-labelledby={titleId}>
      <header className="case__head">
        <div>
          <div className="case__kicker">
            {v("Suggested value for the", "Petition for the")} {fieldLabel(d.field)}
            {d.opened && (
              <>
                {" "}
                · <RelTime at={d.opened} />
              </>
            )}
          </div>
          <h2 className="case__title" id={titleId}>
            <EntityLink entity={d.entity} /> <span className="case__field">· {fieldLabel(d.field)}</span>
          </h2>
        </div>
        <span className="chip chip--proposal">
          <span aria-hidden>✎</span> {v("suggestion", "petition")}
        </span>
      </header>
      {d.evidence && <p className="small">{d.evidence}</p>}
      <div className="case__now">
        <span className="label">{v("Current value", "In the codex now")}</span>
        {d.current ? (
          <span className="row">
            <Value shown={d.current} /> <Seal status={d.current.status} />
          </span>
        ) : (
          <span className="muted">{v("Not set yet.", "Unwritten.")}</span>
        )}
      </div>
      <ol className="claims" aria-label={v("Suggested values", "Petitions")}>
        {d.claims.map((c, i) => (
          <li key={i} className="claim">
            <div className="claim__value">
              <Value shown={c} />
            </div>
            <dl className="claim__facts">
              <dt>Who</dt>
              <dd>
                <span className="row" style={{ ["--gap" as string]: "6px" }}>
                  <Who c={c} party={party} human={human} />
                  <AuthorityBadge authority={c.authority} by={c.by} me={human} />
                </span>
              </dd>
              <dt>When</dt>
              <dd>{c.at ? <RelTime at={c.at} /> : <span className="muted">not recorded</span>}</dd>
            </dl>
            {canDecide && (
              <button type="button" className="btn btn--sm btn--primary claim__rule" disabled={busy} onClick={() => void run({ decision: "accept", claim: i })}>
                <Icon name="check" size={16} /> {i === latest ? v("Accept", "Grant it") : v("Accept this one", "Grant this one")}
              </button>
            )}
          </li>
        ))}
      </ol>
      {canDecide && (
        <div className="case__custom">
          {own === null ? (
            <span className="row" style={{ ["--gap" as string]: "8px" }}>
              {!d.secretField && (
                <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setOwn("")}>
                  <Icon name="quill" size={16} /> {v("Use my own value…", "Write my own…")}
                </button>
              )}
              <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void run({ decision: "decline" })}>
                <Icon name="close" size={16} /> {v("Decline", "Turn it down")}
              </button>
            </span>
          ) : (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (own.trim()) void run({ decision: "accept", value: own.trim() });
              }}
            >
              <label className="label" htmlFor={inputId}>
                {fieldLabel(d.field)}
              </label>
              <input id={inputId} className="input" value={own} onChange={(e) => setOwn(e.target.value)} maxLength={500} autoFocus />
              <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !own.trim()}>
                {v("Save", "Make it canon")}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOwn(null)}>
                Cancel
              </button>
            </form>
          )}
        </div>
      )}
    </article>
  );
}

function MergeCase({ d, canDecide }: { d: DisputeView; canDecide: boolean }) {
  const { v } = useTerms();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const targets = d.targets ?? [d.entity];
  return (
    <article className="case panel" id={d.slug} aria-labelledby={titleId}>
      <header className="case__head">
        <div>
          <div className="case__kicker">
            {v("They share the same", "Both bear the same")} {fieldLabel(d.field)}
            {d.opened && (
              <>
                {" "}
                · <RelTime at={d.opened} />
              </>
            )}
          </div>
          <h2 className="case__title" id={titleId}>
            {targets.map((t, i) => (
              <span key={t.slug}>
                {i > 0 && <span className="case__field"> · </span>}
                <EntityLink entity={t} />
              </span>
            ))}
          </h2>
        </div>
        <span className="chip chip--proposal">
          <span aria-hidden>⧉</span> {v("possible duplicate", "one soul?")}
        </span>
      </header>
      {d.evidence && <p className="small">{d.evidence}</p>}
      {canDecide && (
        <div className="case__custom">
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await decide(d, { decision: "decline" }, v);
              setBusy(false);
            }}
          >
            <Icon name="close" size={16} /> {v("Not the same: decline", "Two souls: decline")}
          </button>
          <span className="hint">{v("Same thing? Merge the two notes in Obsidian; this closes on the next nightly update.", "One soul? Merge the entries by hand in Obsidian.")}</span>
        </div>
      )}
    </article>
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
  const { v } = useTerms();
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
      const shown = res.secret || res.value === null ? "" : `: ${res.value}`;
      toast(v(`Decided: ${d.entity.title} · ${fieldLabel(d.field)} is now confirmed${shown}.`, `So ruled: ${d.entity.title} · ${fieldLabel(d.field)} is canon${shown}.`), "ok");
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
          <Icon name="council" /> {v("Confirm this value?", "Make it canon?")}
        </span>
      }
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            {v("Cancel", "Not yet")}
          </button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={busy || !p}>
            <Icon name="check" /> {busy ? v("Saving…", "Sealing…") : v("Confirm value", "Make it canon")}
          </button>
        </>
      }
    >
      {p && decree && (
        <div className="stack">
          <div className="decree">
            <div className="decree__label">{v("Your decision", "The council rules")}</div>
            <div className="decree__line">
              {p.d.entity.title} · {fieldLabel(p.d.field)}
            </div>
            <div className="decree__value">
              <Value shown={decree.shown} />
            </div>
            {p.choice.kind === "claim" && (
              <div className="small muted">
                Claim {v(String(p.choice.index + 1), roman(p.choice.index + 1))}, as {p.d.claims[p.choice.index]?.byHuman ? "you" : p.d.claims[p.choice.index]?.by} reported it.
              </div>
            )}
            {p.choice.kind === "pending" && <div className="small muted">{v("The decision you wrote in the dispute note.", "The ruling you wrote in the dispute note.")}</div>}
            <span className="decree__seal" aria-hidden>
              ✓
            </span>
          </div>
          {v(
            <ul className="consequences">
              <li>
                <Icon name="check" />
                <span>
                  <strong>Your decision becomes the confirmed value right away</strong> in {p.d.entity.title}'s note. No need to wait for the nightly update.
                </span>
              </li>
              <li>
                <Icon name="quill" />
                <span>
                  It's saved as <strong>{human}</strong> (you). What you decide outranks every agent: no agent can replace it, and if one reports something different later, it comes back here as a new dispute.
                </span>
              </li>
              <li>
                <Icon name="council" />
                <span>
                  The dispute is marked <strong>resolved</strong> and leaves this list. The value it replaces stays in the fact's history.
                </span>
              </li>
            </ul>,
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
            </ul>,
          )}
        </div>
      )}
    </Dialog>
  );
}

// ── Asides ─────────────────────────────────────────────────────────────────

function Adjourned({ asks = 0 }: { asks?: number }) {
  const { t, v } = useTerms();
  return (
    <div className="panel adjourned">
      <span className="adjourned__seal" aria-hidden>
        <Icon name="council" size={34} />
      </span>
      <h2 className="adjourned__title">{v("No open disputes", "The council is adjourned")}</h2>
      <p>{asks ? v("No disagreements. The suggestions below still wait for you.", "No disputes. The petitions below still await your word.") : v("Nothing needs your decision. All your records agree.", "No disputes wait for your ruling. Every fact in the codex agrees with itself.")}</p>
      <p className="small muted">{v("When sources disagree and the precedence rules can't settle it, the dispute appears here after the nightly update.", "When sources disagree and precedence can't settle it, the case lands here after a sleep.")}</p>
      <a className="btn btn--sm" href={href.page("tavern")}>
        <Icon name="tavern" size={16} /> {v(`Back to ${t("tavern")}`, "Back to the tavern")}
      </a>
    </div>
  );
}

function HowItWorks() {
  const { v } = useTerms();
  const rank: [plainTitle: string, plainText: string, codexTitle: string, codexText: string][] = [
    ["People", "What a person writes outranks every agent, always. Between two people, the one whose domain it is wins; otherwise it's a dispute.", "The players", "A player's word outranks every agent, always. Between players, the one whose domain it is wins; otherwise the council decides."],
    ["Responsible agent", "An agent responsible for this kind of record (its type or tags).", "Lane authority", "An agent whose authority covers the entity's type or tags."],
    ["Confirmation", "When several agents report the same value, an unverified fact becomes confirmed.", "Corroboration", "Several agents reporting the same value turn a rumor into canon."],
    ["Recency", "A newer report from the same source replaces its older one.", "Recency", "A newer report from the same source replaces its older one."],
  ];
  return (
    <aside className="council__aside">
      <Panel title={v("How disputes work", "How the council works")} icon="scroll">
        <p className="small">
          {v(
            "When sources disagree about a fact and the precedence rules can't settle it safely, Hippocampus doesn't guess. It opens a dispute here, and the field stays disputed until you decide. Even what you wrote yourself can be challenged: if an agent reports something different, you decide whether things changed.",
            "When sources disagree about a fact and precedence can't settle it safely, the curator doesn't guess. It opens a case here and the field stays disputed until you rule. Even your own word can be challenged: if an agent reports something different, you decide whether things changed.",
          )}
        </p>
        <div className="label">Who outranks whom</div>
        <ol className="precedence">
          {rank.map(([pt, px, ct, cx]) => (
            <li key={ct}>
              <strong>{v(pt, ct)}</strong>
              <span>{v(px, cx)}</span>
            </li>
          ))}
        </ol>
        <p className="small muted">
          {v("You can also decide in Obsidian: write ", "You can also rule in Obsidian: write ")}
          <code>ruling:</code>
          {v(" in the dispute note, and the next nightly update applies it.", " in the dispute note, and the next sleep applies it.")}
        </p>
        <a href={href.guide("precedence-and-disputes")}>{v("Read the guide on how disputes are settled →", "Read the guide on precedence and disputes →")}</a>
      </Panel>
    </aside>
  );
}
