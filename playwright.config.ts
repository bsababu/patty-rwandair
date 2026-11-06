import { defineConfig } from "@playwright/test";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test|verification/i.test(new URL(databaseUrl).pathname)) {
  throw new Error("Browser tests require TEST_DATABASE_URL pointing at an isolated test database");
}

const apiPort = process.env.TEST_API_PORT || "4401";
const webPort = process.env.TEST_WEB_PORT || "4301";
const baseURL = `http://127.0.0.1:${webPort}`;
const apiURL = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npm --prefix apps/api run build && node apps/api/dist/main.js",
      url: `${apiURL}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { DATABASE_URL: databaseUrl, PORT: apiPort, COOKIE_SECURE: "false", WEB_ORIGIN: baseURL, NODE_ENV: "test" },
    },
    {
      command: `node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${webPort}`,
      url: baseURL,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { DATABASE_URL: databaseUrl, API_PROXY_TARGET: apiURL, COOKIE_SECURE: "false", WEB_ORIGIN: baseURL, NEXT_PUBLIC_DEMO_PERSONAS: "false" },
    },
  ],
});
