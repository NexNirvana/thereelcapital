import { expect, test as base } from "@playwright/test";
import {
  MAX_RESENDS_PER_TEST,
  resendDroppedApiPosts,
  resendDroppedPosts,
  stopTradingClients,
  takeResends,
} from "./support.ts";

// Every spec imports `test` from here, so a page that breaks the Content-Security-Policy (an
// inline script or style the nonce does not cover, an off-origin load) fails the test that
// rendered it, not just a dedicated header check.
export const test = base.extend<{
  cspViolations: void;
  resendDroppedPosts: void;
  resendDroppedRequests: void;
  resendBudget: void;
  stopTradingClients: void;
}>({
  // Defined before resendBudget so its teardown runs after the budget check: a cleanup resend is
  // not a double submit, and a cleanup problem never fails a finished test.
  stopTradingClients: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use();
      await stopTradingClients();
    },
    { auto: true },
  ],
  // Each resend is logged by support.ts; more than a few in one test is a real double-submit or
  // proxy regression that the workaround must not hide.
  resendBudget: [
    // Playwright requires the destructuring pattern even when no fixture is used.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      takeResends();
      await use();
      const resends = takeResends();
      expect(
        resends.length,
        `POSTs resent in one test (${resends.join(", ")})`,
      ).toBeLessThanOrEqual(MAX_RESENDS_PER_TEST);
    },
    { auto: true },
  ],
  // wrangler dev's proxy drops some POSTs without delivering them (droppedByProxy in support.ts);
  // resendDroppedPosts resends them from the page and from page.request. A spec that opens its own
  // context with browser.newContext() calls it too.
  resendDroppedPosts: [
    async ({ context }, use) => {
      await resendDroppedPosts(context);
      await use();
    },
    { auto: true },
  ],
  // The standalone `request` fixture is a separate APIRequestContext from page.request.
  resendDroppedRequests: [
    async ({ request }, use) => {
      resendDroppedApiPosts(request);
      await use();
    },
    { auto: true },
  ],
  cspViolations: [
    async ({ context }, use) => {
      const violations: string[] = [];
      const watch = (page: import("@playwright/test").Page) =>
        page.on("console", (message) => {
          if (/Content Security Policy|violates the following/i.test(message.text()))
            violations.push(message.text());
        });
      context.pages().forEach(watch);
      context.on("page", watch);
      await use();
      expect(violations, "Content-Security-Policy violations").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
