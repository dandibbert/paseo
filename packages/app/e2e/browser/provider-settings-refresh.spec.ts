import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

// Config validation treats the dev-only provider as custom; dev registry lookup
// still uses its built-in mock client, so no real Claude process is involved.
test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: { providers: { mock: { extends: "claude", label: "Mock Load Test" } } },
  },
});

async function openMockAgentAtMobileBreakpoint(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-sheet-stack-",
    title: "Provider sheet stack e2e",
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByRole("button", { name: /Select model/ })).toBeVisible({
    timeout: 30_000,
  });
  return session;
}

async function openProviderSettingsFromModelSelector(page: Page) {
  await page.getByRole("button", { name: /Select model/ }).click();
  const configuration = page.getByTestId("agent-controls-model-sheet");
  await expect(configuration).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("agent-controls-model").click();

  const modelBrowser = page.getByTestId("agent-controls-model-browser-sheet");
  await expect(modelBrowser).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /Open .* settings/ }).click();
  await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
}

async function expectModelBrowserVisible(page: Page) {
  await expect(page.getByTestId("agent-controls-model-browser-sheet")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: /Open .* settings/ })).toBeVisible();
}

async function closeTopSheet(page: Page) {
  const closeTarget = page.getByLabel("Close", { exact: true }).last();
  if (await closeTarget.isVisible().catch(() => false)) {
    await closeTarget.click({ force: true });
    return;
  }

  const handle = page.getByRole("slider", { name: "Bottom sheet handle" }).last();
  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error("Bottom sheet handle was not measurable");
  }
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 400, { steps: 8 });
  await page.mouse.up();
}

async function closeSheetByHeaderButton(page: Page, testId: string) {
  const sheet = page.getByTestId(testId);
  await sheet.getByLabel("Close", { exact: true }).click();
  await expect(sheet).not.toBeVisible({ timeout: 10_000 });
}

async function expectOverlayAbove(page: Page, frontTestId: string, backTestId: string) {
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
      await openAgentRoute(page, session);
      await expectComposerVisible(page);

      await page.getByRole("button", { name: /Select model/ }).click();
      const selector = page.getByTestId("combobox-desktop-container");
      await expect(selector).toBeVisible({ timeout: 10_000 });
      const searchInput = page.getByRole("textbox", { name: /search models/i });
      await expect(searchInput).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect.poll(() => hasFocusWithin(selector)).toBe(true);

      await page.keyboard.press("Shift+?");
      const shortcuts = page.getByTestId("keyboard-shortcuts-dialog");
      await expect(shortcuts).toBeVisible({ timeout: 10_000 });
      await expect(page.getByPlaceholder("Search shortcuts")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(shortcuts).not.toBeVisible({ timeout: 10_000 });
      await expect(selector).toBeVisible();

      await page.keyboard.press("ControlOrMeta+K");
      const commandCenter = page.getByTestId("command-center-panel");
      await expect(commandCenter).toBeVisible({ timeout: 10_000 });
      await expect(commandCenter.getByTestId("command-center-input")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(commandCenter).not.toBeVisible({ timeout: 10_000 });
      await expect(selector).toBeVisible();

      await page.keyboard.press("ControlOrMeta+K");
      await expect(commandCenter).toBeVisible({ timeout: 10_000 });
      await commandCenter.getByTestId("command-center-input").fill("add project");
      await commandCenter.getByText("Add project", { exact: true }).click();
      const addProject = page.getByTestId("add-project-flow");
      await expect(addProject).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(addProject).not.toBeVisible({ timeout: 10_000 });
      await expect(selector).toBeVisible();

      const settingsButton = page.getByTestId("selector-header-settings-mock");
      await settingsButton.click();

      const settings = page.getByTestId("provider-settings-sheet");
      await expect(settings).toBeVisible({ timeout: 10_000 });
      await expectOverlayAbove(page, "provider-settings-sheet", "combobox-desktop-container");

      await page.keyboard.press("Escape");
      await expect(settings).not.toBeVisible({ timeout: 10_000 });
      await expect(selector).toBeVisible();
      await expect(settingsButton).toBeFocused();
    } finally {
      await session.cleanup();
    }
  });

  test("provider settings and children close back through the model browser to configuration", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const session = await openMockAgentAtMobileBreakpoint(page);

    try {
      await openProviderSettingsFromModelSelector(page);
      await exerciseProviderSettingsStack(page);
      await closeSheetByHeaderButton(page, "provider-settings-sheet");

      await expectModelBrowserVisible(page);
      await page.getByRole("button", { name: /Open .* settings/ }).click();
      await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
      await exerciseProviderSettingsStack(page);
      await closeSheetByHeaderButton(page, "provider-settings-sheet");

      await expectModelBrowserVisible(page);
      await closeTopSheet(page);
      await expect(page.getByTestId("agent-controls-model-browser-sheet")).not.toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId("agent-controls-settings-list")).toBeVisible();
      await closeTopSheet(page);
    } finally {
      await session.cleanup();
    }
  });
});

type ProviderConfigClient = Pick<
  import("@getpaseo/client/internal/daemon-client").DaemonClient,
  "connect" | "close" | "getDaemonConfig" | "patchDaemonConfig"
>;

async function openDesktopProviderSettings(page: Page) {
  await page.getByRole("button", { name: /Select model/ }).click();
  await page.getByTestId("selector-header-settings-mock").click();
  await expectProviderSettingsVisible(page);
}

async function readManualModels(client: ProviderConfigClient) {
  return (await client.getDaemonConfig()).config.providers.mock?.additionalModels ?? [];
}

async function interruptNextConfigWrite(page: Page) {
  let interrupt = true;
  let reconnected = false;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const text = typeof message === "string" ? message : message.toString("utf8");
      const envelope = JSON.parse(text) as { message?: { type?: string } };
      if (interrupt && envelope.message?.type === "set_daemon_config_request") {
        interrupt = false;
        void Promise.all([
          browser.close({ code: 1013, reason: "Provider config disconnect regression" }),
          server.close({ code: 1013, reason: "Provider config disconnect regression" }),
        ]);
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      browser.send(message);
      const text = typeof message === "string" ? message : message.toString("utf8");
      const envelope = JSON.parse(text) as {
        message?: { type?: string; payload?: { status?: string } };
      };
      if (
        !interrupt &&
        envelope.message?.type === "status" &&
        envelope.message.payload?.status === "server_info"
      ) {
        reconnected = true;
      }
    });
  });
  return {
    waitForReconnect: () => expect.poll(() => reconnected, { timeout: 30_000 }).toBe(true),
  };
}

test.describe("provider model management", () => {
  test("hides a discovered model with a removable override and restores it on deletion", async ({
    page,
  }, testInfo) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "provider-model-hide-",
      title: "Provider model hide e2e",
    });
    const client = await connectDaemonClient<ProviderConfigClient>({
      clientIdPrefix: "provider-model-hide",
    });
    try {
      await client.patchDaemonConfig({ providers: { mock: { additionalModels: [] } } });
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await openDesktopProviderSettings(page);
      const settings = page.getByTestId("provider-settings-sheet");
      await settings.getByRole("button", { name: "Hide one-minute-stream", exact: true }).click();
      await expect
        .poll(() => readManualModels(client))
        .toEqual([{ id: "one-minute-stream", label: "One minute stream", isSelectable: false }]);
      await expect(
        settings.getByRole("button", { name: "Hide one-minute-stream", exact: true }),
      ).toHaveCount(0);
      await expect(
        settings.getByRole("button", { name: "Edit model one-minute-stream", exact: true }),
      ).toHaveCount(1);
      await expect(settings.getByText("Disabled", { exact: true })).toBeVisible();
      await expect(
        settings.getByRole("button", { name: "Remove one-minute-stream", exact: true }),
      ).toBeEnabled();
      await testInfo.attach("hidden-model-override", {
        body: await settings.screenshot(),
        contentType: "image/png",
      });

      await closeSheetByHeaderButton(page, "provider-settings-sheet");
      await page.getByTestId("selector-header-settings-mock").click();
      await settings.getByRole("button", { name: "Remove one-minute-stream", exact: true }).click();
      await expect.poll(() => readManualModels(client)).toEqual([]);
      await expect(
        settings.getByRole("button", { name: "Hide one-minute-stream", exact: true }),
      ).toBeEnabled();
      await expect(
        settings.getByRole("button", { name: "Remove one-minute-stream", exact: true }),
      ).toHaveCount(0);
    } finally {
      await client.patchDaemonConfig({ providers: { mock: { additionalModels: [] } } });
      await client.close();
      await session.cleanup();
    }
  });

  test("adds, edits, and really deletes a manual model without duplicating discovered rows", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "provider-model-manual-",
      title: "Provider manual model e2e",
    });
    const client = await connectDaemonClient<ProviderConfigClient>({
      clientIdPrefix: "provider-model-manual",
    });
    try {
      await client.patchDaemonConfig({ providers: { mock: { additionalModels: [] } } });
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await openDesktopProviderSettings(page);
      const settings = page.getByTestId("provider-settings-sheet");
      await settings.getByRole("button", { name: "Add model", exact: true }).click();
      const editor = page.getByTestId("provider-model-editor-sheet");
      await editor.getByPlaceholder("e.g. openai/gpt-5").fill("manual-test-model");
      await editor.getByPlaceholder("Defaults to model ID").fill("Manual test model");
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await expect(editor).not.toBeVisible();
      await expect
        .poll(() => readManualModels(client))
        .toEqual([{ id: "manual-test-model", label: "Manual test model" }]);
      await expect(settings.getByText("Manual test model", { exact: true })).toHaveCount(1);
      await expect(
        settings.getByRole("button", { name: "Hide manual-test-model", exact: true }),
      ).toHaveCount(0);

      await settings
        .getByRole("button", { name: "Edit model manual-test-model", exact: true })
        .click();
      await editor.getByPlaceholder("e.g. openai/gpt-5").fill("manual-corrected-model");
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await expect(editor).not.toBeVisible();
      await expect
        .poll(() => readManualModels(client))
        .toEqual([{ id: "manual-corrected-model", label: "Manual test model" }]);
      await settings.getByRole("button", { name: "Add model", exact: true }).click();
      await expect(editor.getByPlaceholder("e.g. openai/gpt-5")).toHaveValue("");
      await expect(editor.getByPlaceholder("Defaults to model ID")).toHaveValue("");
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await settings
        .getByRole("button", { name: "Remove manual-corrected-model", exact: true })
        .click();
      await expect.poll(() => readManualModels(client)).toEqual([]);
      await expect(settings.getByText("Manual test model", { exact: true })).toHaveCount(0);
    } finally {
      await client.patchDaemonConfig({ providers: { mock: { additionalModels: [] } } });
      await client.close();
      await session.cleanup();
    }
  });

  test("shows a failed deletion in the sheet and allows retry after reconnection", async ({
    page,
  }, testInfo) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "provider-model-failure-",
      title: "Provider deletion failure e2e",
    });
    const client = await connectDaemonClient<ProviderConfigClient>({
      clientIdPrefix: "provider-model-failure",
    });
    const manualModel = { id: "manual-retry-model", label: "Manual retry model" };
    try {
      await client.patchDaemonConfig({ providers: { mock: { additionalModels: [manualModel] } } });
      const connection = await interruptNextConfigWrite(page);
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await openDesktopProviderSettings(page);
      const settings = page.getByTestId("provider-settings-sheet");
      const remove = settings.getByRole("button", {
        name: "Remove manual-retry-model",
        exact: true,
      });
      await remove.click();
      await expect(settings.getByRole("alert")).toBeVisible();
      await expect(settings.getByRole("alert")).toContainText(/disconnect|connection|closed/i);
      await expect.poll(() => readManualModels(client)).toEqual([manualModel]);
      await expect(remove).toBeEnabled();
      await testInfo.attach("model-deletion-error", {
        body: await settings.screenshot(),
        contentType: "image/png",
      });
      await connection.waitForReconnect();
      await expect(settings.getByRole("alert")).toContainText(/disconnect|connection|closed/i);
      await remove.click();
      await expect.poll(() => readManualModels(client)).toEqual([]);
      await expect(settings.getByRole("alert")).toHaveCount(0);
      await expect(remove).toHaveCount(0);
    } finally {
      await client.patchDaemonConfig({ providers: { mock: { additionalModels: [] } } });
      await client.close();
      await session.cleanup();
    }
  });
});

for (const width of [320, 390, 800, 1280]) {
  test(`long model actions stay reachable at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    const session = await seedMockAgentWorkspace({
      repoPrefix: "provider-model-width-",
      title: "Provider model width e2e",
    });
    const client = await connectDaemonClient<ProviderConfigClient>({
      clientIdPrefix: "provider-model-width",
    });
    const originalProvider = (await client.getDaemonConfig()).config.providers.mock;
    const model = {
      id: "vendor/" + "very-long-unbroken-model-identifier-".repeat(8),
      label: "Very long model display name ".repeat(8),
      description: "A long provider description ".repeat(8),
      contextWindowMaxTokens: 1_000_000,
    };
    try {
      await client.patchDaemonConfig({
        providers: { mock: { models: [model], additionalModels: [] } },
      });
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await page.getByRole("button", { name: /Select model/ }).click();
      const configuration = page.getByTestId("agent-controls-model-sheet");
      const desktopSettings = page.getByTestId("selector-header-settings-mock");
      await expect(configuration.or(desktopSettings)).toBeVisible();
      if (await configuration.isVisible()) {
        await page.getByTestId("agent-controls-model").click();
        await expect(page.getByTestId("agent-controls-model-browser-sheet")).toBeVisible();
        await page.getByRole("button", { name: /Open .* settings/ }).click();
      } else {
        await desktopSettings.click();
      }
      await expectProviderSettingsVisible(page);

      const edit = page.getByRole("button", { name: `Edit model ${model.id}`, exact: true });
      const hide = page.getByRole("button", { name: `Hide ${model.id}`, exact: true });
      const assertContained = async (button: Locator) => {
        await expect(button).toBeVisible();
        await expect(async () => {
          const row = button.locator("..").locator("..");
          const bounds = await row.boundingBox();
          const box = await button.boundingBox();
          expect(bounds).not.toBeNull();
          expect(box).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true,
          );
          expect(box!.x).toBeGreaterThanOrEqual(Math.max(0, bounds!.x));
          expect(box!.x + box!.width).toBeLessThanOrEqual(
            Math.min(width, bounds!.x + bounds!.width),
          );
          expect(
            await button.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                if (getComputedStyle(parent).overflowX === "visible") continue;
                const clip = parent.getBoundingClientRect();
                if (rect.left < clip.left || rect.right > clip.right) return false;
              }
              return true;
            }),
          ).toBe(true);
        }).toPass({ timeout: 10_000 });
        await button.click({ trial: true });
      };
      await assertContained(edit);
      await assertContained(hide);
      await testInfo.attach(`long-model-discovered-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await edit.click();
      await expect(page.getByTestId("provider-model-editor-sheet")).toBeVisible();
      await expect(page.getByPlaceholder("e.g. openai/gpt-5")).toHaveValue(model.id);
      await expect(page.getByPlaceholder("Defaults to model ID")).toHaveValue(model.label);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await assertContained(hide);
      await hide.click();
      await expect.poll(async () => (await readManualModels(client))[0]?.isSelectable).toBe(false);
      const remove = page.getByRole("button", { name: `Remove ${model.id}`, exact: true });
      await assertContained(edit);
      await assertContained(remove);
      await testInfo.attach(`long-model-override-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await edit.click();
      await expect(page.getByPlaceholder("e.g. openai/gpt-5")).toHaveValue(model.id);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await remove.click();
      await expect.poll(() => readManualModels(client)).toEqual([]);
      await assertContained(hide);
    } finally {
      try {
        await client.patchDaemonConfig({ removeProviders: ["mock"] });
        if (originalProvider) {
          await client.patchDaemonConfig({ providers: { mock: originalProvider } });
        }
      } finally {
        try {
          await client.close();
        } finally {
          await session.cleanup();
        }
      }
    }
  });
}
