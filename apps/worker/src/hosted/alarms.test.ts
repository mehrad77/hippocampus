import { describe, expect, it } from "vitest";
import { nodeSqlStorage } from "@hippocampus/index/testing";
import { AlarmBook, alarmLate, nextAlarm, nextNight } from "./alarms.ts";

describe("the one alarm", () => {
  it("goes off for the earliest job, whatever was set before", () => {
    expect(nextAlarm({ lease: 3_000, gc: 1_000, night: 9_000, slice: undefined })).toBe(1_000);
    expect(nextAlarm({ gc: 1_000, slice: 500 })).toBe(500);
    expect(nextAlarm({ night: 9_000 })).toBe(9_000);
    expect(nextAlarm({ lease: undefined })).toBeUndefined();
  });

  it("finds the next night at the vault's hour, never the one that just started", () => {
    const now = new Date("2026-11-16T02:30:00Z");
    expect(new Date(nextNight(3, now)).toISOString()).toBe("2026-11-16T03:00:00.000Z");
    expect(new Date(nextNight(2, now)).toISOString()).toBe("2026-11-17T02:00:00.000Z");
    expect(new Date(nextNight(2, new Date("2026-11-16T02:00:00Z"))).toISOString()).toBe("2026-11-17T02:00:00.000Z");
  });

  it("keeps every job's time, so setting one never loses another", async () => {
    const storage = nodeSqlStorage();
    let alarm: number | null = null;
    const port = { setAlarm: async (t: number) => void (alarm = t), deleteAlarm: async () => void (alarm = null), getAlarm: async () => alarm };
    const book = new AlarmBook(storage.sql, port);
    await book.set("gc", 9_000);
    await book.set("lease", 3_000);
    await book.set("night", 5_000);
    expect(alarm).toBe(3_000);
    // The lease moving later doesn't push the night out.
    await book.set("lease", 7_000);
    expect(alarm).toBe(5_000);
    // Survives the object starting over.
    const again = new AlarmBook(storage.sql, port);
    expect(again.jobs()).toEqual({ gc: 9_000, lease: 7_000, night: 5_000 });
    expect([...again.due(7_000)].sort()).toEqual(["lease", "night"]);
    await again.arm();
    expect(alarm).toBe(9_000);
    alarm = null;
    expect(await again.ensure()).toBe(true);
    expect(alarm).toBe(9_000);
    expect(await again.ensure()).toBe(false);
    await again.set("gc", undefined);
    expect(alarm).toBeNull();
  });

  it("re-arms only a missing or late alarm", () => {
    expect(alarmLate(null, 1_000)).toBe(true);
    expect(alarmLate(2_000, 1_000)).toBe(true);
    expect(alarmLate(1_000, 1_000)).toBe(false);
    expect(alarmLate(null, undefined)).toBe(false);
  });
});
