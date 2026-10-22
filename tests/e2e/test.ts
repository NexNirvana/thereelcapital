import { expect, test as base } from "@playwright/test";
import { resendDroppedApiPosts, resendDroppedPosts } from "./support.ts";

// Every spec imports `test` from here, so a page that breaks the Content-Security-Policy (an
// inline script or style the nonce does not cover, an off-origin load) fails the test that
// rendered it, not just a dedicated header check.
export const test = base.extend<{
  cspViolations: void;
  resendDroppedPosts: void;
  resendDroppedRequests: void;
}>({
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
