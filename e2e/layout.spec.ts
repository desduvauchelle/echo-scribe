import { expect, test } from "@playwright/test";
import { installTauriMock, recordedCalls } from "./mock";

test("dashboard scroll never moves the app shell", async ({ page }) => {
  await page.setViewportSize({ width: 1094, height: 600 });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    // Healthy install: no "AI features are off" sidebar card, so the shell
    // fits without scrolling — this spec guards shell geometry, not banners.
    llmReady: true,
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

test("settings navigation and content scroll independently", async ({ page }) => {
  await page.setViewportSize({ width: 1094, height: 600 });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const navigation = page.locator(".echo-settings-nav");
  const content = page.locator(".echo-settings-content");
  await expect(navigation).toBeVisible();
  await expect(content).toBeVisible();

  const layout = await page.evaluate(() => {
    const pageScroller = document.scrollingElement!;
    const shell = document.querySelector<HTMLElement>(
      ".echo-settings-shell",
    )!;
    const toolbar = shell.querySelector<HTMLElement>("header")!;
    const navigation = document.querySelector<HTMLElement>(
      ".echo-settings-nav",
    )!;
    const content = document.querySelector<HTMLElement>(
      ".echo-settings-content",
    )!;

    return {
      pageClientHeight: pageScroller.clientHeight,
      pageScrollHeight: pageScroller.scrollHeight,
      rootOverflowY: getComputedStyle(document.documentElement).overflowY,
      rootOverscrollY: getComputedStyle(document.documentElement)
        .overscrollBehaviorY,
      navigationOverflowY: getComputedStyle(navigation).overflowY,
      navigationOverscrollY: getComputedStyle(navigation).overscrollBehaviorY,
      contentOverflowY: getComputedStyle(content).overflowY,
      contentOverscrollY: getComputedStyle(content).overscrollBehaviorY,
      shellTop: shell.getBoundingClientRect().top,
      shellBottom: shell.getBoundingClientRect().bottom,
      toolbarBottom: toolbar.getBoundingClientRect().bottom,
      navigationLeft: navigation.getBoundingClientRect().left,
      navigationWidth: navigation.getBoundingClientRect().width,
      navigationTop: navigation.getBoundingClientRect().top,
      navigationBottom: navigation.getBoundingClientRect().bottom,
      navigationRadius: getComputedStyle(navigation).borderRadius,
      contentLeft: content.getBoundingClientRect().left,
      contentRight: content.getBoundingClientRect().right,
      contentTop: content.getBoundingClientRect().top,
      contentBottom: content.getBoundingClientRect().bottom,
      contentRadius: getComputedStyle(content).borderRadius,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });

  expect(layout.pageScrollHeight).toBe(layout.pageClientHeight);
  expect(layout.rootOverflowY).toBe("hidden");
  expect(layout.rootOverscrollY).toBe("none");
  expect(layout.navigationOverflowY).toBe("auto");
  expect(layout.navigationOverscrollY).toBe("contain");
  expect(layout.contentOverflowY).toBe("auto");
  expect(layout.contentOverscrollY).toBe("contain");
  expect(layout.shellTop).toBe(0);
  expect(layout.shellBottom).toBe(layout.viewportHeight);
  expect(layout.navigationLeft).toBe(0);
  expect(layout.navigationWidth).toBe(232);
  expect(layout.navigationTop).toBe(layout.toolbarBottom);
  expect(layout.navigationTop).toBe(layout.contentTop);
  expect(layout.navigationBottom).toBe(layout.contentBottom);
  expect(layout.navigationBottom).toBe(layout.viewportHeight);
  expect(layout.navigationRadius).toBe("0px");
  expect(layout.contentLeft).toBe(232);
  expect(layout.contentRight).toBe(layout.viewportWidth);
  expect(layout.contentRadius).toBe("0px");

  // Force deterministic overflow in both real scroll regions without coupling
  // this shell regression to the current number of settings or form fields.
  await navigation.evaluate((element) => {
    const spacer = document.createElement("div");
    spacer.style.height = "800px";
    element.append(spacer);
  });
  await content.evaluate((element) => {
    const spacer = document.createElement("div");
    spacer.style.height = "800px";
    element.append(spacer);
  });

  const navigationBox = await navigation.boundingBox();
  expect(navigationBox).not.toBeNull();
  await page.mouse.move(
    navigationBox!.x + navigationBox!.width / 2,
    navigationBox!.y + navigationBox!.height / 2,
  );
  await page.mouse.wheel(0, 500);
  await expect
    .poll(() => navigation.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await content.evaluate((element) => element.scrollTop)).toBe(0);

  const navigationScrollTop = await navigation.evaluate(
    (element) => element.scrollTop,
  );
  const contentBox = await content.boundingBox();
  expect(contentBox).not.toBeNull();
  await page.mouse.move(
    contentBox!.x + contentBox!.width / 2,
    contentBox!.y + contentBox!.height / 2,
  );
  await page.mouse.wheel(0, 500);
  await expect
    .poll(() => content.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await navigation.evaluate((element) => element.scrollTop)).toBe(
    navigationScrollTop,
  );
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(
    0,
  );
});

for (const choice of [
  { name: "Delete project only", deleteRelated: false },
  { name: "Delete project and related content", deleteRelated: true },
] as const) {
  test(`project deletion supports: ${choice.name}`, async ({ page }) => {
    await installTauriMock(page, {
      onboardingCompleted: true,
      permissions: { microphone: true, accessibility: true },
      speechModelReady: true,
      projectCount: 1,
    });
    await page.goto("/");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("button", { name: "Delete Project 1" }).click();

    const dialog = page.getByRole("alertdialog", {
      name: "Delete “Project 1”?",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("1 meeting");
    await expect(dialog).toContainText("1 recording");
    await expect(dialog).toContainText("1 chat");
    await expect(
      dialog.getByRole("button", { name: "Delete project only" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", {
        name: "Delete project and related content",
      }),
    ).toBeEnabled();

    await dialog.getByRole("button", { name: choice.name }).click();
    await expect(dialog).toBeHidden();

    const calls = await recordedCalls(page);
    expect(calls.filter((call) => call.cmd === "delete_project")).toEqual([
      {
        cmd: "delete_project",
        args: {
          id: "project-1",
          reassignTo: null,
          deleteRelated: choice.deleteRelated,
        },
      },
    ]);
  });
}

test("action cheatsheet wraps long email examples without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 981, height: 552 });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Actions", exact: true }).click();

  const emailCard = page.locator('[data-action-category="Emails"]');
  const phrases = emailCard.locator("code");
  await expect(emailCard).toBeVisible();
  await expect(phrases).toHaveCount(2);

  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".echo-settings-content")!;
    const card = document.querySelector<HTMLElement>('[data-action-category="Emails"]')!;
    const phrases = Array.from(card.querySelectorAll<HTMLElement>("code"));
    return {
      content: content.scrollWidth - content.clientWidth,
      card: card.scrollWidth - card.clientWidth,
      phrases: phrases.map((phrase) => phrase.scrollWidth - phrase.clientWidth),
    };
  });

  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.card).toBeLessThanOrEqual(1);
  expect(overflow.phrases.every((amount) => amount <= 1)).toBe(true);
});

test("dashboard stats follow the active filter and expose the stats page", async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
  });
  await page.goto("/");

  const stats = page.getByRole("region", { name: "Activity statistics" });
  await expect(stats).toContainText("Dictations");
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
