import { expect, test as base } from "@playwright/test";

// Every spec imports `test` from here, so a page that breaks the Content-Security-Policy (an
// inline script or style the nonce does not cover, an off-origin load) fails the test that
// rendered it, not just a dedicated header check.
export const test = base.extend<{ cspViolations: void }>({
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
