import { describe, expect, it } from "vitest";
import { extractJson } from "./llm.ts";

describe("extractJson", () => {
  it("finds JSON inside prose and code fences", () => {
    expect(extractJson('Sure!\n```json\n{"a": {"b": "}"}}\n```')).toEqual({ a: { b: "}" } });
    expect(extractJson('\n\n{"entities": []}')).toEqual({ entities: [] });
  });

  it("skips invalid candidates and returns undefined when there is none", () => {
    expect(extractJson('{not json} then {"ok": true}')).toEqual({ ok: true });
    expect(extractJson("no json here")).toBeUndefined();
  });
});
