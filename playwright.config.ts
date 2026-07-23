import { defineConfig } from "@playwright/test";

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
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run build && bun run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
