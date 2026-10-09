import type { SetupItem } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Runes } from "../../ui/Parts.tsx";
import { HowChip, StateBadge } from "./common.tsx";
import { tally } from "./model.ts";

/** "Setup & health": every status item at a glance, each linking to where it is fixed. */
export function HealthChecklist({ items, linkFor, defaultOpen = true, title = "Setup & health" }: { items: readonly SetupItem[]; linkFor: (id: string) => string | undefined; defaultOpen?: boolean; title?: string }) {
  const t = tally(items);
  return (
    <details className="panel sz-health" open={defaultOpen}>
      <summary className="sz-health__summary">
        <span className="panel__title">
          <Icon name="setup" /> {title}
        </span>
        <span className="sz-health__count">
          <span aria-hidden>
            <Runes done={t.done} total={t.total} />
          </span>
          <span>
            {t.done} of {t.total} in order
            {t.attention ? <span className="muted"> · {t.attention} to look at</span> : null}
          </span>
        </span>
        <Icon name="chevron" className="sz-health__chev" />
      </summary>
      <ul className="sz-health__list">
        {items.map((item) => {
          const link = linkFor(item.id);
          return (
            <li key={item.id} className={`sz-health__item sz-health__item--${item.state}`}>
              <StateBadge state={item.state} />
              <span className="sz-health__text">
                <strong>{link ? <a href={link}>{item.title}</a> : item.title}</strong>
                <span className="small muted">{item.detail}</span>
              </span>
              <HowChip how={item.how} />
            </li>
          );
        })}
      </ul>
    </details>
  );
}
