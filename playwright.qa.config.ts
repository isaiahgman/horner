import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/qa",
  testMatch: "**/*.e2e.ts",
  outputDir: "node_modules/.cache/playwright-qa-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["line"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4175",
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "qa-chromium", use: { ...devices["Pixel 7"] } }],
  webServer: {
    command: "npm run preview -- --outDir dist-qa --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
