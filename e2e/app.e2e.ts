import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow, openToday } from "./helpers.js";

const STARTING_CHAPTERS = [
  "Matthew 1",
  "Genesis 1",
  "Romans 1",
  "1 Thessalonians 1",
  "Job 1",
  "Psalm 1",
  "Proverbs 1",
  "Joshua 1",
  "Isaiah 1",
  "Acts 1",
] as const;

const STARTING_USFM_CHAPTERS = [
  "MAT.1",
  "GEN.1",
  "ROM.1",
  "1TH.1",
  "JOB.1",
  "PSA.1",
  "PRO.1",
  "JOS.1",
  "ISA.1",
  "ACT.1",
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
    await expect(page.getByRole("link", { name: `Open ${chapter} in YouVersion` })).toBeVisible();
  }
  for (const chapter of STARTING_CHAPTERS.slice(6)) {
    await expect(page.getByRole("checkbox", { name: `Mark read: ${chapter}` })).toBeVisible();
  }
});

test("keyboard import restores an exported backup and preserves a safety copy", async ({ page }) => {
  await openToday(page);
  await page.getByRole("checkbox", { name: "Mark read: Matthew 1" }).click();
  await page.getByRole("button", { name: "Settings" }).click();

  const exportedDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON backup" }).click();
  const exportedPath = await (await exportedDownloadPromise).path();
  expect(exportedPath).toBeTruthy();

  await page.getByRole("button", { name: "Today" }).click();
  await page.getByRole("checkbox", { name: "Mark unread: Matthew 1" }).click();
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
  await expect(page.getByRole("checkbox", { name: "Mark unread: Matthew 1" })).toBeVisible();
});

test("confirmed reset returns to Day 1 and downloads a safety backup", async ({ page }) => {
  await openToday(page);
  await page.getByRole("checkbox", { name: "Mark read: Matthew 1" }).click();
  await page.getByRole("button", { name: "Settings" }).click();

  page.once("dialog", (dialog) => dialog.accept());
  const safetyDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Reset to Day 1" }).click();
  await safetyDownloadPromise;
  await expect(page.getByText(/Progress reset to Day 1/)).toBeVisible();

  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
  for (const chapter of STARTING_CHAPTERS) {
    await expect(page.getByRole("link", { name: `Open ${chapter} in YouVersion` })).toBeVisible();
  }
});

test("chapter links open YouVersion on mobile and ESV.org on desktop", async ({ browser, page }) => {
  await openToday(page);

  for (const [index, chapter] of STARTING_CHAPTERS.entries()) {
    const link = page.getByRole("link", { name: `Open ${chapter} in YouVersion` });
    await expect(link).toHaveAttribute(
      "href",
      `https://www.bible.com/bible/59/${STARTING_USFM_CHAPTERS[index]}.ESV`,
    );
    await expect(link).not.toHaveAttribute("target");
    await expect(link).not.toHaveAttribute("rel");
    await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  }

  const ipadContext = await browser.newContext({
    ...devices["iPad Pro 11"],
    baseURL: "http://127.0.0.1:4173",
  });
  try {
    const ipadPage = await ipadContext.newPage();
    await openToday(ipadPage);
    const ipadLink = ipadPage.getByRole("link", {
      name: "Open Matthew 1 in YouVersion",
    });
    await expect(ipadLink).toHaveAttribute(
      "href",
      "https://www.bible.com/bible/59/MAT.1.ESV",
    );
    await expect(ipadLink).not.toHaveAttribute("target");
    await expect(ipadLink).toHaveAttribute("referrerpolicy", "no-referrer");
  } finally {
    await ipadContext.close();
  }

  const desktopContext = await browser.newContext({
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
  });
  try {
    const desktopPage = await desktopContext.newPage();
    await openToday(desktopPage);
    for (const chapter of STARTING_CHAPTERS) {
      const link = desktopPage.getByRole("link", {
        name: `Open ${chapter} on ESV.org in a new tab`,
      });
      await expect(link).toHaveAttribute(
        "href",
        `https://www.esv.org/${chapter.replaceAll(" ", "+")}/`,
      );
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
    }
  } finally {
    await desktopContext.close();
  }
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme} mode has no automated WCAG A/AA violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await openToday(page);
    await page.getByRole("checkbox", { name: "Mark read: Matthew 1" }).click();

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
