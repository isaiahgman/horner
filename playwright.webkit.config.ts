import { defineConfig, devices } from "@playwright/test";

import config from "./playwright.config";

const previewCommand = "node scripts/preview-webkit.mjs";

export default defineConfig({
  ...config,
  use: {
    ...config.use,
    baseURL: "https://127.0.0.1:4174",
    // The isolated test context uses a disposable local self-signed certificate.
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: process.env.CI ? previewCommand : `npm run build && ${previewCommand}`,
    url: "https://127.0.0.1:4174",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
