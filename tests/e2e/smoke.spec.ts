import { expect, test } from "@playwright/test";

test("smoke page shows the engine ping result", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ping")).toHaveText("pong");
});
