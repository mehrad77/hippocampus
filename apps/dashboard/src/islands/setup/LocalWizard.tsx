import { useEffect, useRef, useState } from "react";
import { useTerms } from "../../lib/prefs.ts";
import type { LocalSetupStatus, SessionInfo } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Personalization } from "../../ui/Personalization.tsx";
import { AgentsStep } from "./AgentsStep.tsx";
import { StateBadge } from "./common.tsx";
import { DoneStep } from "./DoneStep.tsx";
import { GitStep } from "./GitStep.tsx";
import { HealthChecklist } from "./Health.tsx";
import { LlmStep } from "./LlmStep.tsx";
import { defaultStep, isLocked, neighbors, parseStep, stepDef, stepIndex, stepState, STEPS, type StepId, type StepProps } from "./model.ts";
import { PartyStep } from "./PartyStep.tsx";
import { RemoteStep } from "./RemoteStep.tsx";
import { ScheduleStep } from "./ScheduleStep.tsx";
import { SecretsStep } from "./SecretsStep.tsx";
import { StepRail } from "./StepRail.tsx";
import { VaultStep } from "./VaultStep.tsx";
import { WelcomeStep } from "./WelcomeStep.tsx";

const BODIES: Record<StepId, (p: StepProps) => React.ReactNode> = {
  welcome: WelcomeStep,
  vault: VaultStep,
  party: PartyStep,
  secrets: SecretsStep,
  llm: LlmStep,
  git: GitStep,
  agents: AgentsStep,
  schedule: ScheduleStep,
  remote: RemoteStep,
  done: DoneStep,
};

function useHash(): string {
  const [hash, setHash] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const onChange = () => setHash(location.hash.slice(1));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

/** Setup (Session Zero) against `hippo dashboard`: a wizard driven by `location.hash`, one step per hash. */
export function LocalWizard({ session, status }: { session: SessionInfo; status: LocalSetupStatus }) {
  const { t, v } = useTerms();
  const hasVault = session.mode !== "setup";
  const hash = useHash();
  const [arrivedWithHash] = useState(() => !!parseStep(location.hash.slice(1)));
  // A vault that is configured but won't load (say, an older format) needs the vault step, not the welcome.
  const fallback = !hasVault && (session.error || status.vault) ? "vault" : defaultStep(status.items, hasVault);
  // A hash that isn't a step (say, #personalization) keeps the step you were on and just scrolls.
  const parsed = parseStep(hash);
  const lastStep = useRef<StepId | undefined>(undefined);
  if (parsed) lastStep.current = parsed;
  const current = parsed ?? lastStep.current ?? fallback;
  const step = stepDef(current);
  const locked = isLocked(step, hasVault);
  const item = status.items.find((i) => i.id === current);
  const state = stepState(current, status.items, hasVault);
  const { prev, next } = neighbors(current);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  // Moving between steps puts focus (and the view) on the new step's heading, so keyboard and screen reader users follow along.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const h = headingRef.current;
    if (!h) return;
    h.focus({ preventScroll: true });
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    h.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
  }, [current]);

  useEffect(() => {
    if (!hash || parsed) return;
    let target: HTMLElement | null = null;
    try {
      target = document.getElementById(decodeURIComponent(hash));
    } catch {
      // A malformed hash: nothing to scroll to.
    }
    target?.scrollIntoView({ block: "start" });
  }, [hash, parsed]);

  const Body = BODIES[current];
  const props: StepProps = { session, status, hasVault, item };

  return (
    <div className="stack sz">
      <header className="page-head">
        <div>
          <div className="page-head__kicker">
            {t("sessionZero")}
            {session.campaign ? ` · ${session.campaign}` : ""}
          </div>
          <h1>{hasVault ? "Setup & health" : v("Get started", "Set the table")}</h1>
          <p className="page-head__lede">
            {hasVault
              ? v("How your setup is doing, and the steps to fix anything that needs it.", "How your campaign's machinery is doing, and the steps to put anything right.")
              : v(
                  "A few steps before you start: a vault, your agents, an encryption key and an AI model for the nightly update. Nothing happens until you press a button, and every button says what it will do.",
                  "Before the first session, the table gets set: a vault, a party, a key and a curator. Nothing happens until you press a button, and every button says what it will do.",
                )}
          </p>
        </div>
        <span className="chip sz-where" title="This dashboard runs on your machine and can act on it.">
          <Icon name="setup" size={14} /> On this machine
        </span>
      </header>

      {hasVault && status.items.length > 0 && <HealthChecklist items={status.items} linkFor={(id) => (parseStep(id) ? `#${id}` : undefined)} defaultOpen={!arrivedWithHash} />}

      <div className="sz-layout">
        <StepRail current={current} items={status.items} hasVault={hasVault} />
        <section className="panel sz-step" aria-labelledby="sz-step-title">
          <header className="sz-step__head">
            <div className="sz-step__kicker">
              <Icon name={step.icon} size={16} /> Step {stepIndex(current) + 1} of {STEPS.length}
            </div>
            <div className="sz-step__titlerow">
              <h2 id="sz-step-title" ref={headingRef} tabIndex={-1}>
                {v(...step.title)}
              </h2>
              {state && <StateBadge state={state} />}
            </div>
            <p className="sz-step__lede">{v(...step.lede)}</p>
            {item && !locked && item.state !== "done" && item.detail && (
              <p className="sz-step__status small">
                <span className="muted">Right now:</span> {item.detail}
              </p>
            )}
          </header>

          <div className="sz-step__body">
            {locked ? (
              <Locked />
            ) : (
              <>
                {item?.state === "na" && (
                  <div className="callout">
                    <Icon name="check" />
                    <div>Not needed for this vault{item.detail ? `: ${item.detail}` : "."}</div>
                  </div>
                )}
                <Body {...props} />
              </>
            )}
          </div>

          <footer className="sz-step__nav">
            {prev ? (
              <a className="btn btn--ghost" href={`#${prev.id}`}>
                <Icon name="back" /> <span className="sz-step__navword">Back:</span> {v(...prev.title)}
              </a>
            ) : (
              <span />
            )}
            {next && (
              <a className={`btn ${current === "welcome" ? "btn--primary" : ""}`} href={`#${next.id}`}>
                {current === "welcome" ? "Begin: " : <span className="sz-step__navword">Next: </span>}
                {v(...next.title)} <Icon name="chevron" />
              </a>
            )}
          </footer>
        </section>
      </div>
      <Personalization />
    </div>
  );
}

function Locked() {
  return (
    <div className="sz-locked">
      <Icon name="lock" size={36} />
      <p>
        <strong>This step needs a vault.</strong> Create or open one first; it takes a minute, and everything after it unlocks.
      </p>
      <a className="btn btn--primary" href="#vault">
        <Icon name="codex" /> To the vault step
      </a>
    </div>
  );
}
