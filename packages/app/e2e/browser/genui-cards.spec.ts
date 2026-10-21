import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// The mock provider plays every render_ui component (plus one rejected call) with text
// between them; see packages/server/src/server/agent/providers/mock-genui-scenario.ts.
const GENUI_PROMPT = "emit synthetic genui cards";
const CARD_COUNT = 10;
const VIEWPORTS = [
  { name: "wide", width: 1280, height: 900 },
  { name: "narrow", width: 390, height: 844 },
] as const;

for (const theme of ["light", "dark"] as const) {
  for (const viewport of VIEWPORTS) {
    test(`renders GenUI cards inline (${theme}, ${viewport.name})`, async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript((value) => {
        localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: value }));
      }, theme);
      const agent = await seedMockAgentWorkspace({
        repoPrefix: `genui-${theme}-${viewport.name}-`,
        title: "GenUI cards",
        initialPrompt: GENUI_PROMPT,
      });
      try {
        await openAgentRoute(page, agent);
        const cards = page.getByTestId("genui-card");
        await expect(cards).toHaveCount(CARD_COUNT, { timeout: 60_000 });
        await expect(page.getByTestId("genui-card-generating")).toHaveCount(0);
        await expect(page.getByText("Card 1 of 10.")).toBeVisible();
        await expect(page.getByTestId("genui-change-percent")).toHaveText("-85.7%");

        for (let index = 0; index < CARD_COUNT; index += 1) {
          const card = cards.nth(index);
          await card.scrollIntoViewIfNeeded();
          await card.screenshot({
            path: testInfo.outputPath(`genui-${theme}-${viewport.name}-${index + 1}.png`),
          });
        }
      } finally {
        await agent.cleanup();
      }
    });
  }
}

test("keeps GenUI cards after reload and out of overview tool groups", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ theme: "light", toolCallDetailLevel: "overview" }),
    );
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "genui-history-",
    title: "GenUI history",
    initialPrompt: GENUI_PROMPT,
  });
  try {
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("genui-card")).toHaveCount(CARD_COUNT, { timeout: 60_000 });

    await page.reload();

    await expect(page.getByTestId("genui-card")).toHaveCount(CARD_COUNT, { timeout: 60_000 });
    await expect(page.getByText("That covers it.")).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});

test("shows the data behind a card and copies it as text", async ({ page }) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "genui-actions-",
    title: "GenUI actions",
    initialPrompt: "emit synthetic genui card table",
  });
  try {
    await openAgentRoute(page, agent);
    const card = page.getByTestId("genui-card");
    await expect(card).toHaveCount(1, { timeout: 60_000 });
    const closedHeight = (await card.boundingBox())?.height;
    await card.getByTestId("genui-view-data").click();
    await expect(card.getByTestId("genui-data-text")).toContainText("方案\t价格（元）");
    // Closing the data panel gives its space back instead of leaving a gap.
    await card.getByTestId("genui-view-data").click();
    await expect(card.getByTestId("genui-data-text")).toHaveCount(0);
    await expect.poll(async () => (await card.boundingBox())?.height).toBe(closedHeight);
    await card.getByTestId("genui-copy").click();
    await expect(card.getByTestId("genui-copy")).toHaveText("Copied");
  } finally {
    await agent.cleanup();
  }
});
