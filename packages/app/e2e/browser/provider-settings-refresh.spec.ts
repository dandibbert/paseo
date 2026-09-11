import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedMockAgentWorkspace } from "./fixtures/mock-agent-workspace";
import { openProviderSettingsFromModelBrowser } from "./fixtures/provider-settings";

async function closeSheetByHeaderButton(page: Page, testId: string) {
  const sheet = page.getByTestId(testId);
  await sheet.getByRole("button").first().click();
  await expect(sheet).not.toBeVisible({ timeout: 10_000 });
}

async function expectFrontCoversBack(
  page: Page,
  frontTestId: string,
  backTestId: string,
): Promise<void> {
  const frontCoversBack = await page.evaluate(
    ({ frontTestId: frontId, backTestId: backId }) => {
      const front = document.querySelector(`[data-testid="${frontId}"]`);
      const back = document.querySelector(`[data-testid="${backId}"]`);
      if (!(front instanceof HTMLElement) || !(back instanceof HTMLElement)) return false;

      const frontRect = front.getBoundingClientRect();
      const backRect = back.getBoundingClientRect();
      const left = Math.max(frontRect.left, backRect.left);
      const right = Math.min(frontRect.right, backRect.right);
      const top = Math.max(frontRect.top, backRect.top);
      const bottom = Math.min(frontRect.bottom, backRect.bottom);
      if (left >= right || top >= bottom) return false;

      const topElement = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return topElement != null && front.contains(topElement);
    },
    { frontTestId, backTestId },
  );
  expect(frontCoversBack).toBe(true);
}

async function hasFocusWithin(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.contains(document.activeElement));
}

async function expectProviderSettingsVisible(page: Page) {
  await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Add model" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Diagnostic", exact: true })).toBeVisible();
}

async function exerciseProviderSettingsStack(page: Page) {
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Add model" }).click();
  await expect(page.getByTestId("provider-model-editor-sheet")).toBeVisible({ timeout: 10_000 });
  await closeSheetByHeaderButton(page, "provider-model-editor-sheet");
  await expect(page.getByPlaceholder("e.g. openai/gpt-5")).not.toBeVisible({ timeout: 10_000 });
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Diagnostic", exact: true }).click();
  await expect(page.getByTestId("provider-diagnostic-sheet")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Refresh diagnostic/ }).click();
  await expect(page.getByTestId("provider-diagnostic-sheet")).toBeVisible({ timeout: 10_000 });
  await closeSheetByHeaderButton(page, "provider-diagnostic-sheet");
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expectProviderSettingsVisible(page);
}

test.describe("provider settings overlay stack", () => {
  test("provider settings covers the desktop model selector without closing it", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "provider-modal-layer-",
      title: "Provider modal layer e2e",
    });

    try {
      await page.goto(session.workspaceUrl);
      await openProviderSettingsFromModelBrowser(page);
      await expectFrontCoversBack(page, "provider-settings-sheet", "model-selector-sheet");
    } finally {
      await session.cleanup();
    }
  });

  test("provider settings and children close back through the model browser to configuration", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "provider-settings-stack-",
      title: "Provider settings stack e2e",
    });

    try {
      await page.goto(session.workspaceUrl);
      await openProviderSettingsFromModelBrowser(page);
      await exerciseProviderSettingsStack(page);

      await closeSheetByHeaderButton(page, "provider-settings-sheet");
      await expect(page.getByTestId("model-selector-sheet")).toBeVisible({ timeout: 10_000 });
      await closeSheetByHeaderButton(page, "model-selector-sheet");
      await expect(page.getByTestId("configuration-sheet")).toBeVisible({ timeout: 10_000 });
    } finally {
      await session.cleanup();
    }
  });

  test("provider settings retains focus when model selector is covered", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "provider-settings-focus-",
      title: "Provider settings focus e2e",
    });

    try {
      await page.goto(session.workspaceUrl);
      await openProviderSettingsFromModelBrowser(page);
      const providerSettings = page.getByTestId("provider-settings-sheet");
      await expect(providerSettings).toBeVisible({ timeout: 10_000 });
      expect(await hasFocusWithin(providerSettings)).toBe(true);
    } finally {
      await session.cleanup();
    }
  });
});
