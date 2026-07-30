import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

test("dashboard scroll never moves the app shell", async ({ page }) => {
  await page.setViewportSize({ width: 1094, height: 600 });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    projectCount: 8,
  });
  await page.goto("/");

  await expect(page.locator(".echo-app-shell")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();

  const layout = await page.evaluate(() => {
    const pageScroller = document.scrollingElement!;
    const dashboard = document.querySelector<HTMLElement>(
      ".echo-dashboard-scroll",
    )!;
    const sidebar = document.querySelector<HTMLElement>(".echo-sidebar")!;
    const projects = document.querySelector<HTMLElement>(
      'nav[aria-label="Projects"]',
    )!;

    return {
      pageClientHeight: pageScroller.clientHeight,
      pageScrollHeight: pageScroller.scrollHeight,
      rootOverflowY: getComputedStyle(document.documentElement).overflowY,
      rootOverscrollY: getComputedStyle(document.documentElement)
        .overscrollBehaviorY,
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      bodyOverscrollY: getComputedStyle(document.body).overscrollBehaviorY,
      dashboardOverflowY: getComputedStyle(dashboard).overflowY,
      dashboardOverscrollY: getComputedStyle(dashboard).overscrollBehaviorY,
      sidebarClientHeight: sidebar.clientHeight,
      sidebarScrollHeight: sidebar.scrollHeight,
      projectsClientHeight: projects.clientHeight,
      projectsScrollHeight: projects.scrollHeight,
    };
  });

  expect(layout.pageScrollHeight).toBe(layout.pageClientHeight);
  expect(layout.rootOverflowY).toBe("hidden");
  expect(layout.rootOverscrollY).toBe("none");
  expect(layout.bodyOverflowY).toBe("hidden");
  expect(layout.bodyOverscrollY).toBe("none");
  expect(layout.dashboardOverflowY).toBe("auto");
  expect(layout.dashboardOverscrollY).toBe("contain");
  expect(layout.sidebarScrollHeight).toBe(layout.sidebarClientHeight);
  expect(layout.projectsScrollHeight).toBeGreaterThan(layout.projectsClientHeight);

  // Give the real dashboard scroller deterministic overflow without coupling
  // this shell regression to the feed fixture's item count.
  await page.locator(".echo-dashboard-scroll").evaluate((dashboard) => {
    const spacer = document.createElement("div");
    spacer.dataset.testid = "scroll-spacer";
    spacer.style.height = "1200px";
    spacer.style.flex = "0 0 1200px";
    dashboard.append(spacer);
  });

  const dashboard = page.locator(".echo-dashboard-scroll");
  const dashboardBox = await dashboard.boundingBox();
  expect(dashboardBox).not.toBeNull();
  await page.mouse.move(
    dashboardBox!.x + dashboardBox!.width / 2,
    dashboardBox!.y + dashboardBox!.height / 2,
  );
  await page.mouse.wheel(0, 800);
  await expect
    .poll(() => dashboard.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  await dashboard.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.mouse.wheel(0, 2000);

  const pinnedShell = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".echo-app-shell")!;
    const toolbar = document.querySelector<HTMLElement>(".echo-app-toolbar")!;
    const sidebar = document.querySelector<HTMLElement>(".echo-sidebar")!;
    return {
      pageScrollTop: document.scrollingElement!.scrollTop,
      shellTop: shell.getBoundingClientRect().top,
      shellBottom: shell.getBoundingClientRect().bottom,
      toolbarTop: toolbar.getBoundingClientRect().top,
      sidebarBottom: sidebar.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    };
  });

  expect(pinnedShell).toEqual({
    pageScrollTop: 0,
    shellTop: 0,
    shellBottom: pinnedShell.viewportHeight,
    toolbarTop: 0,
    sidebarBottom: pinnedShell.viewportHeight,
    viewportHeight: pinnedShell.viewportHeight,
  });
});

test("dashboard stats follow the active filter and expose the stats page", async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
  });
  await page.goto("/");

  const stats = page.getByRole("region", { name: "Activity statistics" });
  await expect(stats).toContainText("Transcriptions");
  await expect(stats).toContainText("86 this week");
  await expect(page.getByRole("button", { name: "View stats" })).toBeVisible();

  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(stats).toContainText("Today");
  await expect(stats).toContainText("3");
  await expect(stats).toContainText("This week");
  await expect(stats).toContainText("14");

  await page.getByRole("button", { name: "View stats" }).click();
  await expect(page.getByRole("heading", { name: "Stats" })).toBeVisible();
});
