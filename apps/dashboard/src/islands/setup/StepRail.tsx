import type { IconName } from "../../lib/icons.ts";
import { useTerms } from "../../lib/prefs.ts";
import type { SetupItem } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { StateBadge } from "./common.tsx";
import { STATE_META, STEPS, stepState, type BadgeState, type StepId, type Wording } from "./model.ts";

/** What the rail needs of a step, whichever wizard it belongs to. */
export interface RailStep {
  id: string;
  title: Wording;
  icon: IconName;
}

/** The local wizard's rail. */
export function StepRail({ current, items, hasVault }: { current: StepId; items: readonly SetupItem[]; hasVault: boolean }) {
  return <StepRailView steps={STEPS} current={current} stateOf={(id) => stepState(id as StepId, items, hasVault)} />;
}

/** The steps as a numbered rail on wide screens; a compact stepper (count, jump menu, track) on phones. */
export function StepRailView({ steps, current, stateOf }: { steps: readonly RailStep[]; current: string; stateOf: (id: string) => BadgeState | undefined }) {
  const { t, v } = useTerms();
  const index = Math.max(0, steps.findIndex((s) => s.id === current));
  return (
    <>
      <nav className="sz-rail" aria-label={`${t("sessionZero")} steps`}>
        <ol className="sz-rail__list">
          {steps.map((step, i) => {
            const state = stateOf(step.id);
            const here = step.id === current;
            return (
              <li key={step.id} className="sz-rail__item" data-state={state ?? "none"}>
                <a className="sz-rail__link" href={`#${step.id}`} aria-current={here ? "step" : undefined}>
                  <span className="sz-rail__num" aria-hidden>
                    {i + 1}
                  </span>
                  <span className="sz-rail__text">
                    <span className="sz-rail__title">
                      <span className="sr-only">Step {i + 1}: </span>
                      {v(...step.title)}
                    </span>
                    {state && <StateBadge state={state} compact />}
                  </span>
                  <Icon name={step.icon} size={18} className="sz-rail__icon" />
                </a>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="sz-stepper">
        <div className="sz-stepper__row">
          <span className="sz-stepper__count">
            Step {index + 1} <span className="muted">of {steps.length}</span>
          </span>
          <label className="sz-stepper__jump">
            <span className="sr-only">Go to step</span>
            <select
              className="select"
              value={current}
              onChange={(e) => {
                location.hash = e.target.value;
              }}
            >
              {steps.map((step, i) => {
                const state = stateOf(step.id);
                return (
                  <option key={step.id} value={step.id}>
                    {i + 1}. {v(...step.title)}
                    {state ? ` · ${STATE_META[state].word}` : ""}
                  </option>
                );
              })}
            </select>
          </label>
        </div>
        <ol className="sz-stepper__track" aria-hidden>
          {steps.map((step) => (
            <li key={step.id} data-state={stateOf(step.id) ?? "none"} data-current={step.id === current ? "" : undefined} />
          ))}
        </ol>
      </div>
    </>
  );
}
