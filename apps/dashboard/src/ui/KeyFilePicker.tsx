import { useRef, useState } from "react";
import { identityFrom } from "../lib/secrets.ts";
import { Icon } from "./Icon.tsx";

/**
 * Pick a key file and hand its private key to `onKey`. The file is read here, in the browser, and nothing about it
 * is sent anywhere; whoever receives the key keeps it only as long as they need it.
 */
export function KeyFilePicker({ onKey, label = "Pick your key file" }: { onKey: (identity: string) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  return (
    <div className="stack" style={{ ["--gap" as string]: "6px" }}>
      <div className="row">
        <button type="button" className="btn" onClick={() => input.current?.click()}>
          <Icon name="key" /> {label}
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept=".agekey,.txt,text/plain"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          // Clear the input, so the browser holds no reference to the file once its key is taken.
          e.target.value = "";
          if (!file) return;
          setProblem(undefined);
          try {
            onKey(identityFrom(await file.slice(0, 16 * 1024).text()));
          } catch (err) {
            setProblem((err as Error).message);
          }
        }}
      />
      <p className="hint">The file stays on this device: it's read here, and the key is never sent anywhere.</p>
      {problem && (
        <p className="sz-problem" role="status">
          {problem}
        </p>
      )}
    </div>
  );
}
