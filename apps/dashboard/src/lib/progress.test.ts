import { describe, expect, it } from "vitest";
import { addInterval, progressLabel, progressShape, repeatLabel } from "./progress.ts";

describe("progressShape", () => {
  it("draws up to 12 steps as cells, more as a bar", () => {
    expect(progressShape(3, 6)).toEqual({ done: 3, total: 6, segmented: true, percent: 50 });
    expect(progressShape(12, 12).segmented).toBe(true);
    expect(progressShape(40, 100)).toEqual({ done: 40, total: 100, segmented: false, percent: 40 });
  });

  it("clamps what it's given", () => {
    expect(progressShape(9, 6)).toMatchObject({ done: 6, percent: 100 });
    expect(progressShape(-1, 6)).toMatchObject({ done: 0, percent: 0 });
    expect(progressShape(0, 0)).toMatchObject({ done: 0, total: 1 });
    expect(progressLabel(2, 4)).toBe("2 of 4");
  });
});

describe("addInterval", () => {
  it("adds days, weeks, calendar months and years like core", () => {
    expect(addInterval("2026-10-09", "3d")).toBe("2026-10-12");
    expect(addInterval("2026-10-09", "2w")).toBe("2026-10-23");
    expect(addInterval("2026-01-31", "1m")).toBe("2026-02-28");
    expect(addInterval("2028-02-29", "1y")).toBe("2029-02-28");
    expect(addInterval("2026-10-09", "soon")).toBeUndefined();
    expect(addInterval("2026-10-09", "0w")).toBeUndefined();
  });

  it("names a repeat", () => {
    expect(repeatLabel({ every: "1m" })).toBe("every month");
    expect(repeatLabel({ every: "5d" })).toBe("every 5d");
    expect(repeatLabel({ every: "2w", after_last: "interaction" })).toBe("every 2 weeks after the last interaction");
    expect(repeatLabel(undefined)).toBeUndefined();
  });
});
