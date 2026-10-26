import { describe, expect, it } from "bun:test";
import { EXPIRY_CLOSE_LEAD_MS } from "./config.ts";
import { expiryCloseAt, isExpirationDay, shouldCloseAtExpiry } from "./expiry.ts";

// 2026-11-20 is a normal Friday; 2026-11-27 (day after Thanksgiving) closes early at 13:00 ET.
const et = (day: string, time: string, offset: "-05:00" | "-04:00") =>
  new Date(`${day}T${time}${offset}`);

describe("closing an option on its expiration day", () => {
  it("uses a 15 minute lead", () => {
    expect(EXPIRY_CLOSE_LEAD_MS).toBe(15 * 60_000);
  });

  it("closes at 15:45 ET on a normal day", () => {
    expect(expiryCloseAt("2026-11-20")).toEqual(et("2026-11-20", "15:45:00", "-05:00"));
  });

  it("closes at 12:45 ET on an early-close day", () => {
    expect(expiryCloseAt("2026-11-27")).toEqual(et("2026-11-27", "12:45:00", "-05:00"));
  });

  it("follows daylight saving time", () => {
    expect(expiryCloseAt("2026-10-30")).toEqual(et("2026-10-30", "15:45:00", "-04:00"));
  });

  it("has no close on a day without a session", () => {
    expect(expiryCloseAt("2026-11-21")).toBeNull();
    expect(expiryCloseAt("2026-11-26")).toBeNull(); // Thanksgiving
  });

  it("fires from the lead before the close until the close", () => {
    const due = (time: string) =>
      shouldCloseAtExpiry("2026-11-20", et("2026-11-20", time, "-05:00"));
    expect(due("15:44:59")).toBe(false);
    expect(due("15:45:00")).toBe(true);
    expect(due("15:59:59")).toBe(true);
    expect(due("16:00:00")).toBe(false);
  });

  it("uses the early close on an early-close day", () => {
    const due = (time: string) =>
      shouldCloseAtExpiry("2026-11-27", et("2026-11-27", time, "-05:00"));
    expect(due("12:44:59")).toBe(false);
    expect(due("12:45:00")).toBe(true);
    expect(due("13:00:00")).toBe(false);
  });

  it("does nothing on other days", () => {
    expect(shouldCloseAtExpiry("2026-11-20", et("2026-11-19", "15:50:00", "-05:00"))).toBe(false);
    expect(shouldCloseAtExpiry("2026-11-20", et("2026-11-23", "15:50:00", "-05:00"))).toBe(false);
  });

  it("knows the expiration day in New York time, not UTC", () => {
    // 22:00 ET on the 19th is already the 20th in UTC.
    expect(isExpirationDay("2026-11-20", et("2026-11-19", "22:00:00", "-05:00"))).toBe(false);
    expect(isExpirationDay("2026-11-20", et("2026-11-20", "00:00:00", "-05:00"))).toBe(true);
    expect(isExpirationDay("2026-11-20", et("2026-11-20", "23:59:59", "-05:00"))).toBe(true);
  });
});
