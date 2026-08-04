import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow, openToday } from "./helpers.js";

const STARTING_CHAPTERS = [
  "Matthew 24",
  "Genesis 24",
  "1 Corinthians 8",
  "James 2",
  "Job 24",
  "Psalm 24",
  "Proverbs 24",
  "Joshua 24",
  "Isaiah 24",
  "Acts 24",
] as const;

test("rapid checkbox taps persist in order across an immediate reload", async ({ page }) => {
  await openToday(page);

  await page.locator(".check-button").evaluateAll((buttons) => {
    const controls = buttons as HTMLButtonElement[];
    controls[0]?.click();
    controls[0]?.click();
    controls[0]?.click();
    for (const control of controls.slice(1, 6)) control.click();
  });

  // Reload as soon as the synchronous burst finishes. This deliberately gives
  // IndexedDB no artificial settling delay and catches stale-state/write-order bugs.
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.getByRole("checkbox")).toHaveCount(10);
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(6);
  await expect(page.getByRole("checkbox", { checked: false })).toHaveCount(4);
  await expect(page.getByRole("progressbar", { name: "Chapters completed today" }))
    .toHaveAttribute("aria-valuenow", "6");

  for (const chapter of STARTING_CHAPTERS.slice(0, 6)) {
    await expect(page.getByRole("checkbox", { name: `Mark unread: ${chapter}` })).toBeVisible();
    await expect(page.getByRole("link", { name: chapter })).toBeVisible();
  }
  for (const chapter of STARTING_CHAPTERS.slice(6)) {
    await expect(page.getByRole("checkbox", { name: `Mark read: ${chapter}` })).toBeVisible();
  }
});

test("keyboard import restores an exported backup and preserves a safety copy", async ({ page }) => {
  await openToday(page);
  await page.getByRole("checkbox", { name: "Mark read: Matthew 24" }).click();
  await page.getByRole("button", { name: "Settings" }).click();

  const exportedDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON backup" }).click();
  const exportedPath = await (await exportedDownloadPromise).path();
  expect(exportedPath).toBeTruthy();

  await page.getByRole("button", { name: "Today" }).click();
  await page.getByRole("checkbox", { name: "Mark unread: Matthew 24" }).click();
  await page.getByRole("button", { name: "Settings" }).click();

  const importButton = page.getByRole("button", { name: "Import JSON backup" });
  const fileChooserPromise = page.waitForEvent("filechooser");
  await importButton.focus();
  await page.keyboard.press("Enter");
  const fileChooser = await fileChooserPromise;
  const safetyDownloadPromise = page.waitForEvent("download");
  await fileChooser.setFiles(exportedPath!);
  await safetyDownloadPromise;
  await expect(page.getByText("Backup restored.")).toBeVisible();

  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.getByRole("checkbox", { name: "Mark unread: Matthew 24" })).toBeVisible();
});

test("confirmed reset returns to Day 24 and downloads a safety backup", async ({ page }) => {
  await openToday(page);
  await page.getByRole("checkbox", { name: "Mark read: Matthew 24" }).click();
  await page.getByRole("button", { name: "Settings" }).click();

  page.once("dialog", (dialog) => dialog.accept());
  const safetyDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Reset to Day 24" }).click();
  await safetyDownloadPromise;
  await expect(page.getByText(/Progress reset to Day 24/)).toBeVisible();

  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
  for (const chapter of STARTING_CHAPTERS) {
    await expect(page.getByRole("link", { name: chapter })).toBeVisible();
  }
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme} mode has no automated WCAG A/AA violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await openToday(page);
    await page.getByRole("checkbox", { name: "Mark read: Matthew 24" }).click();

    const todayResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
      .analyze();
    expect(todayResults.violations, JSON.stringify(todayResults.violations, null, 2)).toEqual([]);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Settings" })).toBeVisible();
    const settingsResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
      .analyze();
    expect(settingsResults.violations, JSON.stringify(settingsResults.violations, null, 2)).toEqual([]);

    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "History" })).toBeVisible();
    const historyResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
      .analyze();
    expect(historyResults.violations, JSON.stringify(historyResults.violations, null, 2)).toEqual([]);
  });
}

test("phone layouts do not overflow horizontally", async ({ page }) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
  ]) {
    await page.setViewportSize(viewport);
    await openToday(page);
    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Settings" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});
