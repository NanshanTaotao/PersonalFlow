import fs from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const e2eRoot = path.resolve(".tmp/e2e");
const sqlitePath = path.join(e2eRoot, "personalflow-e2e.sqlite");
const apiPort = 4174;
const webPort = 4173;
const playwrightChannel =
  process.env.PLAYWRIGHT_CHANNEL === undefined || process.env.PLAYWRIGHT_CHANNEL === "bundled"
    ? undefined
    : process.env.PLAYWRIGHT_CHANNEL;

fs.rmSync(e2eRoot, { recursive: true, force: true });
fs.mkdirSync(e2eRoot, { recursive: true });

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "personalflow-mvp.spec.ts",
  outputDir: path.join(e2eRoot, "artifacts"),
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(playwrightChannel === undefined ? {} : { channel: playwrightChannel })
      }
    }
  ],
  webServer: [
    {
      command: "pnpm --filter @personalflow/api dev",
      url: `http://127.0.0.1:${apiPort}/health`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        HOST: "127.0.0.1",
        PORT: String(apiPort),
        PERSONALFLOW_SQLITE_PATH: sqlitePath,
        PERSONALFLOW_LOCAL_ENCRYPTION_KEY: "e2e-deterministic-local-key-0001",
        PERSONALFLOW_MODEL_MODE: "fake"
      }
    },
    {
      command: `pnpm --filter @personalflow/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        VITE_PERSONALFLOW_API_TARGET: `http://127.0.0.1:${apiPort}`
      }
    }
  ]
});
