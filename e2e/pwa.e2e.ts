import { expect, test } from "@playwright/test";

import { openToday } from "./helpers.js";

interface ManifestIcon {
  readonly src: string;
  readonly sizes?: string;
  readonly type?: string;
  readonly purpose?: string;
}

interface WebManifest {
  readonly name?: string;
  readonly display?: string;
  readonly start_url?: string;
  readonly scope?: string;
  readonly icons?: readonly ManifestIcon[];
}

test("the production shell starts without content-security-policy violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/content security policy|refused to (connect|frame|load|execute)/i.test(text)) {
      violations.push(text);
    }
  });

  await openToday(page);
  await page.waitForTimeout(750);
  expect(violations).toEqual([]);
});

test("manifest and install icons are valid production responses", async ({ page, request }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref).toBeTruthy();
  const manifestResponse = await request.get(manifestHref!);
  expect(manifestResponse.ok()).toBe(true);
  expect(manifestResponse.headers()["content-type"]).toContain("application/manifest+json");

  const manifest = await manifestResponse.json() as WebManifest;
  expect(manifest.name).toBe("Horner — Next Ten");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("./");
  expect(manifest.scope).toBe("./");

  const icons = manifest.icons ?? [];
  expect(icons.some(({ sizes }) => sizes === "192x192")).toBe(true);
  expect(icons.some(({ sizes, purpose }) => sizes === "512x512" && purpose === "any")).toBe(true);
  expect(icons.some(({ sizes, purpose }) => sizes === "512x512" && purpose === "maskable")).toBe(true);

  for (const icon of icons) {
    const iconUrl = new URL(icon.src, manifestResponse.url()).toString();
    const iconResponse = await request.get(iconUrl);
    expect(iconResponse.ok(), `${iconUrl} should return successfully`).toBe(true);
    expect(iconResponse.headers()["content-type"], `${iconUrl} should be a PNG`).toContain("image/png");
    expect((await iconResponse.body()).byteLength, `${iconUrl} should not be empty`).toBeGreaterThan(100);
  }

  const appleIconHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect(appleIconHref).toBeTruthy();
  const appleIconResponse = await request.get(appleIconHref!);
  expect(appleIconResponse.ok()).toBe(true);
  expect(appleIconResponse.headers()["content-type"]).toContain("image/png");
});

test("installed shell reloads from the service worker while offline", async ({ context, page }) => {
  await openToday(page);
  await page.evaluate(async () => navigator.serviceWorker.ready);

  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "Next Ten" })).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(10);
    await expect(page.getByRole("link", { name: "Open Matthew 24 in YouVersion" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test("checks for a service worker update when the app regains focus", async ({ page }) => {
  await page.addInitScript(() => {
    const registrationPrototype = ServiceWorkerRegistration.prototype;
    const originalUpdate = registrationPrototype.update;
    (window as Window & { __pwaUpdateChecks?: number }).__pwaUpdateChecks = 0;
    registrationPrototype.update = function update(...args) {
      const testWindow = window as Window & { __pwaUpdateChecks?: number };
      testWindow.__pwaUpdateChecks = (testWindow.__pwaUpdateChecks ?? 0) + 1;
      return originalUpdate.apply(this, args);
    };
  });

  await openToday(page);
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.waitForTimeout(250);

  const checksBeforeFocus = await page.evaluate(
    () => (window as Window & { __pwaUpdateChecks?: number }).__pwaUpdateChecks ?? 0,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect.poll(() => page.evaluate(
    () => (window as Window & { __pwaUpdateChecks?: number }).__pwaUpdateChecks ?? 0,
  )).toBeGreaterThan(checksBeforeFocus);
});
