import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser",
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  timeout: 45000,
  reporter: [["list"], ["junit", { outputFile: "reports/browser.xml" }]],
  use: {
    baseURL: process.env.BROWSER_BASE_URL || "http://127.0.0.1:3001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.BROWSER_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://127.0.0.1:3001/healthz",
        reuseExistingServer: !process.env.CI,
        timeout: 30000,
      },
});
