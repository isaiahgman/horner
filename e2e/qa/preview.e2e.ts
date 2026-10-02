import { expect, test } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const origin = "http://127.0.0.1:4175";

test("synthetic guest preview makes no external requests across reading and reloads", async ({ page, context }) => {
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  context.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("checkbox")).toHaveCount(10);
  await expect(page.getByRole("complementary", { name: "QA preview" })).toContainText("Synthetic guest data only");
  const metadata = await (await page.request.get("/qa-build.json")).json();
  expect(metadata).toMatchObject({ schema: 1, mode: "qa" });
  expect(metadata.commit).toMatch(/^[a-f0-9]{40}$/);
  await expect(page.getByRole("complementary", { name: "QA preview" })).toContainText(metadata.commit.slice(0, 12));
  await expect(page.getByRole("checkbox", { name: "Mark read: Matthew 1" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Mark read: Matthew 1" }).click();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Mark unread: Matthew 1" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import JSON backup" })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByText("Synthetic QA preview.", { exact: true })).toBeVisible();
  await page.getByLabel("Reading day begins").selectOption("3");
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Mark unread: Matthew 1" })).toBeVisible();
  const databases = await page.evaluate(() => indexedDB.databases());
  expect(databases.map((db) => db.name)).toContain("qa-preview:horner-next-ten");
  expect(databases.map((db) => db.name)).not.toContain("horner-next-ten");
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("QA reading never opens or mutates the production local store", async ({ page }) => {
  // A same-origin metadata page lets us seed a fake production store before the
  // QA app runs. These sentinels contain no personal progress or backup data.
  await page.goto("/qa-build.json");
  await page.evaluate(async () => {
    localStorage.setItem("horner-next-ten-pending-v4:guest", "synthetic-production-journal");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("horner-next-ten", 2);
      request.onupgradeneeded = () => request.result.createObjectStore("appState", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("appState", "readwrite");
      transaction.objectStore("appState").put({ id: "guest", sentinel: "synthetic-production-state" });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.goto("/");
  await page.getByRole("checkbox", { name: "Mark read: Matthew 1" }).click();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Mark unread: Matthew 1" })).toBeVisible();
  const sentinel = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("horner-next-ten", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction("appState").objectStore("appState").get("guest");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { value, journal: localStorage.getItem("horner-next-ten-pending-v4:guest") };
  });
  expect(sentinel).toEqual({
    value: { id: "guest", sentinel: "synthetic-production-state" },
    journal: "synthetic-production-journal",
  });
});

test("preview CSP blocks production network connections", async ({ page }) => {
  // Blocked by CSP before network, not by a test route or fabricated cloud adapter.
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("checkbox")).toHaveCount(10);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(policy).toContain("connect-src 'self'");
  expect(policy).toContain("form-action 'none'");
  const blocked = await page.evaluate(async () => {
    try { await fetch("https://firestore.googleapis.com/"); return false; } catch { return true; }
  });
  expect(blocked).toBe(true);
  expect(externalRequests).toEqual([]);
});

test("QA output has no Firebase runtime, production configuration, or source maps", () => {
  function inspect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { inspect(path); continue; }
      expect(entry.name).not.toMatch(/\.map$/);
      expect(entry.name).not.toMatch(/^firebase-(auth|firestore)/);
      if (/\.(?:js|html|json)$/.test(entry.name)) {
        const content = readFileSync(path, "utf8");
        expect(content).not.toMatch(/isaiahgathala@gmail\.com|horner-next-ten-isaiah|331301995758|AIzaSy|identitytoolkit\.googleapis\.com|firestore\.googleapis\.com/);
      }
    }
  }
  inspect("dist-qa");
});
