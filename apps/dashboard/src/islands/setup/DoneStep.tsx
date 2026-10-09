import { useTerms } from "../../lib/prefs.ts";
import { href } from "../../lib/routes.ts";
import { Icon } from "../../ui/Icon.tsx";
import { StateBadge } from "./common.tsx";
import { itemTitle, parseStep, type StepProps } from "./model.ts";

export function DoneStep({ status }: StepProps) {
  const { t, v, plain } = useTerms();
  const open = status.items.filter((i) => i.state === "todo" || i.state === "warn" || i.state === "error");
  return (
    <div className="stack sz-done">
      <div className="sz-done__seal" aria-hidden>
        <Icon name={v("check", "d20")} size={56} />
      </div>
      <p className="sz-done__lede">
        {v(
          "From here on, agents send notes about what they learn, the nightly update turns them into confirmed records, and this dashboard is where you read everything, decide disputes and track goals.",
          "From here on, agents file what they learn, the curator turns it into canon each night, and this dashboard is where you read the campaign, rule on disputes and steer quests.",
        )}
      </p>
      {open.length > 0 && (
        <div className="callout callout--warn">
          <Icon name="warn" />
          <div className="stack sz-tight">
            <strong>Still open, whenever you're ready:</strong>
            <ul className="sz-open">
              {open.map((i) => (
                <li key={i.id}>
                  <StateBadge state={i.state} compact /> {parseStep(i.id) ? <a href={`#${i.id}`}>{itemTitle(i, plain)}</a> : itemTitle(i, plain)}
                  <span className="small muted"> · {i.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="sz-doors">
        <a className="sz-door" href={href.page("tavern")}>
          <Icon name="tavern" size={28} />
          <strong>{v(t("tavern"), "The Tavern")}</strong>
          <span className="small muted">What happened, what needs you</span>
        </a>
        <a className="sz-door" href={href.page("quests")}>
          <Icon name="quest" size={28} />
          <strong>{t("quests")}</strong>
          <span className="small muted">Objectives, clocks and deadlines</span>
        </a>
        <a className="sz-door" href={href.page("guides")}>
          <Icon name="guides" size={28} />
          <strong>{t("guides")}</strong>
          <span className="small muted">{v("How it works, disputes, secrets", "The daily loop, rulings, secrets")}</span>
        </a>
      </div>
    </div>
  );
}
