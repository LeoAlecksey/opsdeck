import { defineConfig } from "@playwright/test";

// UI tests: the real frontend (vite dev server) against a fake backend (tests/ui/mock.js).
export default defineConfig({
  testDir: "tests/ui",
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    locale: "ru-RU",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 1420 --strictPort",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
