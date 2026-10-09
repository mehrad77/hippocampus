import { useEffect, useId, useRef } from "react";
import { useTerms } from "../../lib/prefs.ts";
import type { Snippet } from "../../lib/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { CopyButton } from "../../ui/Parts.tsx";
import { Facts, Snippets } from "./common.tsx";

/** What a reveal shows: the secret, a few facts about it, and how to connect with it. */
export interface Reveal {
  title: string;
  /** What to call it in the warning: agent tokens on a self-hosted Worker, keys on the hosted app. */
  noun: "token" | "key";
  secret: string;
  facts: [React.ReactNode, React.ReactNode][];
  snippets: readonly Snippet[];
  /** Extra guidance under the snippets. */
  after?: React.ReactNode;
}

/**
 * A freshly minted secret, shown exactly once. Unlike the shared Dialog, a stray backdrop click or
 * Escape doesn't close it: losing it means minting another, so only the explicit button does.
 */
export function SecretReveal({ reveal, onClose }: { reveal?: Reveal; onClose: () => void }) {
  const { v } = useTerms();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (reveal && !d.open) d.showModal();
    if (!reveal && d.open) d.close();
  }, [reveal]);
  return (
    <dialog ref={ref} className="dialog dialog--wide" aria-labelledby={titleId} onCancel={(e) => e.preventDefault()} onClose={() => reveal && onClose()}>
      <div className="dialog__head">
        <h2 id={titleId}>
          <span className="row">
            <Icon name="key" /> {reveal ? reveal.title : "Token"}
          </span>
        </h2>
      </div>
      <div className="dialog__body">
        {reveal && (
          <div className="stack">
            <div className="callout callout--warn" role="note">
              <Icon name="lock" />
              <div>
                <strong>You won't see this {reveal.noun} again.</strong> Copy it into the agent's settings now. Only its hash is kept; if it's lost, revoke it and {v("create", "mint")} another.
              </div>
            </div>
            <Facts rows={reveal.facts} />
            <div className="sz-token">
              <pre className="sz-token__value" tabIndex={0} aria-label={`The new ${reveal.noun}`}>
                <code>{reveal.secret}</code>
              </pre>
              <CopyButton text={reveal.secret} label={`Copy the ${reveal.noun}`} />
            </div>
            {reveal.snippets.length > 0 && (
              <>
                <h3 className="sz-subhead">Connect with it</h3>
                <Snippets snippets={reveal.snippets} />
              </>
            )}
            {reveal.after}
          </div>
        )}
      </div>
      <div className="dialog__foot">
        <button type="button" className="btn btn--primary" onClick={onClose}>
          <Icon name="check" /> I've copied it, close
        </button>
      </div>
    </dialog>
  );
}
