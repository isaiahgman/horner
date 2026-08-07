import { expect, type Page } from "@playwright/test";

export async function openToday(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Next Ten" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(10);
  await expect(page.getByRole("checkbox", { name: "Mark read: Matthew 1" })).toBeEnabled();
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const measurements = await page.evaluate(() => {
    const documentElement = document.documentElement;
    const navRect = document.querySelector(".bottom-nav")?.getBoundingClientRect();
    const shellRect = document.querySelector(".app-shell")?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentWidth: documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      navLeft: navRect?.left ?? -1,
      navRight: navRect?.right ?? window.innerWidth + 1,
      shellLeft: shellRect?.left ?? -1,
      shellRight: shellRect?.right ?? window.innerWidth + 1,
    };
  });

  expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.viewportWidth);
  expect(measurements.bodyWidth).toBeLessThanOrEqual(measurements.viewportWidth);
  expect(measurements.navLeft).toBeGreaterThanOrEqual(0);
  expect(measurements.navRight).toBeLessThanOrEqual(measurements.viewportWidth);
  expect(measurements.shellLeft).toBeGreaterThanOrEqual(0);
  expect(measurements.shellRight).toBeLessThanOrEqual(measurements.viewportWidth);
}
