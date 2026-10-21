// What the top bar shows about the account and the market clock.

/** The last four characters of the account id, the rest hidden (docs/design-system.md#layout-shell). */
export function maskAccount(accountId: string): string {
  return `•• ${accountId.slice(-4)}`;
}

const marketClock = new Intl.DateTimeFormat("es", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "America/New_York",
});

/** Market time as "10:42 ET"; America/New_York follows daylight saving through Intl. */
export function formatMarketClock(now: Date): string {
  return `${marketClock.format(now)} ET`;
}

/** Milliseconds until the next minute boundary, so the clock ticks when the minute changes. */
export function msToNextMinute(now: Date): number {
  return 60_000 - (now.getTime() % 60_000);
}
