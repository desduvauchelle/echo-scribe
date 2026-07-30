import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4173);

// Onboarding e2e suite: runs the real built frontend in Chromium with the
// Tauri IPC layer mocked (see e2e/mock.ts). Pure-logic unit tests stay in
// tests/ under bun:test — this suite only covers view routing + onboarding.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bun run build && bun run preview -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
