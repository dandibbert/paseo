import { expect } from "@playwright/test";

export async function runSettingsScrollRegression(page, resizeWindow) {
  // The dev runner's pending open-project request navigates after the bridge is ready.
  // Let it land before opening Settings so it cannot interrupt the scroll assertions.
  await page.waitForURL(/\/h\/[^/]+\/workspace\//, { timeout: 60_000 });
  // Device-metrics emulation also pins later webview guests. Resize the real
  // window so the following browser regression starts without an override.
  const original = await resizeWindow({ width: 1000, height: 500 });
  const sidebar = () => page.locator('[data-testid="settings-sidebar-scroll-body"]:visible');
  const offset = () => sidebar().evaluate((node) => node.scrollTop);
  const observations = [];
  try {
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 1000, height: 500 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await sidebar().hover();
    await page.mouse.wheel(0, 2000);
    // Wheel delivery is asynchronous; do not save an intermediate offset while it is moving.
    await expect
      .poll(() =>
        sidebar().evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
      )
      .toBe(0);
    const saved = await offset();
    expect(saved).toBeGreaterThan(0);
    for (const title of ["Providers", "Terminals", "Providers", "Terminals"]) {
      const button = page
        .locator('[data-testid="settings-sidebar"]:visible')
        .getByRole("button", { name: title, exact: true });
      await expect(button).toBeInViewport();
      await button.click();
      await expect(page.locator('[data-testid="settings-detail-header-title"]:visible')).toHaveText(
        title,
      );
      await expect.poll(offset).toBe(saved);
      observations.push({ title, offset: await offset() });
    }
    const detail = page.locator('[data-testid="settings-detail-scroll-body"]:visible');
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    await detail.hover();
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => detail.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect.poll(offset).toBe(saved);
    observations.push({
      independentDetailOffset: await detail.evaluate((node) => node.scrollTop),
      sidebarOffset: await offset(),
    });
    await sidebar().hover();
    await page.mouse.wheel(0, -2000);
    await expect.poll(offset).toBe(0);
    await page.mouse.wheel(0, 60);
    await expect.poll(offset).toBe(60);
    for (const title of ["Sidebar", "Appearance", "Sidebar"]) {
      const button = page
        .getByRole("navigation", { name: "Settings" })
        .getByRole("button", { name: title, exact: true });
      await expect(button).toBeInViewport();
      await button.click();
      await expect(page.getByTestId("settings-detail-header-title")).toHaveText(title);
      await expect.poll(offset).toBe(60);
      observations.push({ title, offset: await offset() });
    }
    await page.locator('[data-testid="settings-back-to-workspace"]:visible').click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect.poll(offset).toBe(0);
    observations.push({ reentryOffset: await offset() });
    await page.locator('[data-testid="settings-back-to-workspace"]:visible').click();
    return observations;
  } finally {
    await resizeWindow(original);
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual(original);
  }
}
