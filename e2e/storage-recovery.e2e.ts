import { expect, test, type Page } from "@playwright/test";

import { openToday } from "./helpers.js";

async function readGuestRecord(page: Page): Promise<unknown> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open("horner-next-ten");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("appState", "readonly");
      const request = transaction.objectStore("appState").get("guest");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      transaction.oncomplete = () => database.close();
    };
  }));
}

test("a failed saved-profile read preserves IndexedDB and Retry restores the same progress", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-02T12:00:00Z"));
  await openToday(page);
  await page.getByRole("checkbox", { name: "Mark read: Matthew 1" }).click();
  await page.getByRole("checkbox", { name: "Mark read: Acts 1" }).click();
  await expect.poll(() => readGuestRecord(page)).toMatchObject({
    id: "guest",
    state: { activeSession: { completedCounts: { gospels: 1, acts: 1 } } },
  });
  // Ensure the successful writes are durable before simulating a later read
  // failure. A retained journal would legitimately recover the state instead.
  await expect.poll(() => page.evaluate(() =>
    localStorage.getItem("horner-next-ten-pending-v4:guest"),
  )).toBeNull();
  const savedRecord = await readGuestRecord(page);

  await page.addInitScript(() => {
    const marker = "synthetic-profile-read-failed";
    if (sessionStorage.getItem(marker)) return;
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (query) {
      if (this.name === "appState" && query === "guest") {
        sessionStorage.setItem(marker, "true");
        IDBObjectStore.prototype.get = originalGet;
        throw new DOMException("Synthetic saved-profile read failure", "UnknownError");
      }
      return originalGet.call(this, query);
    };
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Saved progress couldn’t be opened" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Nothing has been replaced");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import JSON backup" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset to Day 1" })).toHaveCount(0);
  expect(await readGuestRecord(page)).toEqual(savedRecord);
  expect(await page.evaluate(() => localStorage.getItem("horner-next-ten-pending-v4:guest"))).toBeNull();

  await page.getByRole("button", { name: "Retry saved progress" }).click();
  await expect(page.getByRole("checkbox", { name: "Mark unread: Matthew 1" })).toBeEnabled();
  await expect(page.getByRole("checkbox", { name: "Mark unread: Acts 1" })).toBeEnabled();
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(2);
  expect(await readGuestRecord(page)).toEqual(savedRecord);
});
