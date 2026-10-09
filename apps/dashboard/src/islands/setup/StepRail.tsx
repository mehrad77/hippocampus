import type { SetupItem } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { StateBadge } from "./common.tsx";
import { STATE_META, STEPS, stepIndex, stepState, type StepId } from "./model.ts";

/** The steps as a numbered rail on wide screens; a compact stepper (count, jump menu, track) on phones. */
export function StepRail({ current, items, hasVault }: { current: StepId; items: readonly SetupItem[]; hasVault: boolean }) {
  const index = stepIndex(current);
  return (
    <>
      <nav className="sz-rail" aria-label="Session Zero steps">
        <ol className="sz-rail__list">
          {STEPS.map((step, i) => {
            const state = stepState(step.id, items, hasVault);
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
                      {step.title}
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
            Step {index + 1} <span className="muted">of {STEPS.length}</span>
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
              {STEPS.map((step, i) => {
                const state = stepState(step.id, items, hasVault);
                return (
                  <option key={step.id} value={step.id}>
                    {i + 1}. {step.title}
                    {state ? ` · ${STATE_META[state].word}` : ""}
                  </option>
                );
              })}
            </select>
          </label>
        </div>
        <ol className="sz-stepper__track" aria-hidden>
          {STEPS.map((step) => (
            <li key={step.id} data-state={stepState(step.id, items, hasVault) ?? "none"} data-current={step.id === current ? "" : undefined} />
          ))}
        </ol>
      </div>
    </>
  );
}
