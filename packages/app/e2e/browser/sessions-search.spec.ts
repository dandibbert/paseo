import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import {
  connectSeedClient,
  seedWorkspace,
  type SeededWorkspace,
} from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { getServerId } from "../support/helpers/server-id";
import { seedParentWithSubagent, type SeededSubagentPair } from "../support/helpers/subagents";
import {
  createMockIdleAgent,
  openSessions,
  resetSeededPageState,
} from "../support/helpers/archive-tab";

/**
 * Every seeded title opens with the same nonce, so a query of "<nonce> term"
 * can only reach this spec's sessions. The daemon is shared with the rest of
 * the browser suite and its history is whatever those specs left behind.
 */
const NONCE = `hsq${randomUUID().replaceAll("-", "").slice(0, 8)}`;

const TITLES = {
  billing: `${NONCE} main Add Stripe billing`,
  unbilled: `${NONCE} main Unbilled usage report`,
  terminal: `${NONCE} main Terminal resize fix`,
} as const;

async function search(page: Page, query: string): Promise<void> {
  await page.getByTestId("sessions-search-input").fill(query);
}

function rowTitles(page: Page) {
  return page.getByTestId(new RegExp(`^agent-row-${getServerId()}-`));
}

async function expectVisibleTitles(page: Page, titles: string[]): Promise<void> {
  const rows = rowTitles(page).filter({ hasText: NONCE });
  await expect(rows).toHaveCount(titles.length, { timeout: 30_000 });
  for (const [index, title] of titles.entries()) {
    await expect(rows.nth(index)).toContainText(title, { timeout: 30_000 });
  }
}

async function verifyChronologicalFiltering(page: Page): Promise<void> {
  await test.step("narrows history while preserving chronological grouping", async () => {
    await expectVisibleTitles(page, [TITLES.unbilled, TITLES.billing, TITLES.terminal]);
    await expect(page.getByText("Today", { exact: true })).toHaveCount(1, {
      timeout: 30_000,
    });

    await search(page, `${NONCE} billing`);
    await expectVisibleTitles(page, [TITLES.billing]);
    await expect(page.getByText("Today", { exact: true })).toHaveCount(1, {
      timeout: 30_000,
    });

    await page.getByTestId("sessions-search-clear").click();
    await expect(page.getByTestId("sessions-search-input")).toHaveValue("");
    await expectVisibleTitles(page, [TITLES.unbilled, TITLES.billing, TITLES.terminal]);
    await expect(page.getByText("Today", { exact: true })).toHaveCount(1, {
      timeout: 30_000,
    });
  });
}

async function verifyRecencyBeforeMatchStrength(page: Page): Promise<void> {
  await test.step("keeps newer partial matches before older stronger matches", async () => {
    await search(page, `${NONCE} bill`);
    await expectVisibleTitles(page, [TITLES.unbilled, TITLES.billing]);
  });
}

async function verifyExactAndTypoHighlights(page: Page): Promise<void> {
  await test.step("highlights exact and typo-resolved matches", async () => {
    await search(page, `${NONCE} billing`);
    const row = rowTitles(page).filter({ hasText: NONCE }).first();
    await expect(row.getByText("billing", { exact: true })).toBeVisible({ timeout: 30_000 });

    await search(page, `${NONCE} bulling`);
    await expectVisibleTitles(page, [TITLES.billing]);
    const typoRow = rowTitles(page).filter({ hasText: NONCE }).first();
    await expect(typoRow.getByText("billing", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });
}

async function verifyAllSearchFieldHighlights(page: Page): Promise<void> {
  await test.step("highlights workspace, agent, project and branch independently", async () => {
    await search(page, `${NONCE} main`);
    await expectVisibleTitles(page, [TITLES.unbilled, TITLES.billing, TITLES.terminal]);
    const row = rowTitles(page).filter({ hasText: NONCE }).first();
    for (const field of ["workspace", "title", "project", "branch"]) {
      await expect(
        row.getByTestId(new RegExp(`^agent-row-${field}-`)).getByText(/^main$/i),
      ).toBeVisible();
    }
    await expect(page.getByText("Yesterday", { exact: true })).toHaveCount(0);
  });
}

async function verifyEmptySearchAndRecovery(page: Page): Promise<void> {
  await test.step("distinguishes no matches from empty history", async () => {
    await search(page, `${NONCE} kubernetes`);
    await expect(page.getByTestId("sessions-empty")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("No sessions match")).toBeVisible({ timeout: 30_000 });

    await page.getByText("Clear search").click();
    await expectVisibleTitles(page, [TITLES.unbilled, TITLES.billing, TITLES.terminal]);
  });
}

test.describe("History search", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  let projectId: string;

  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("main-sessions-search-");
    client = await connectSeedClient();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
      title: "Main history",
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${tempRepo.path}`);
    }
    projectId = created.workspace.projectId;
    const workspaceId = created.workspace.id;

    for (const title of [TITLES.terminal, TITLES.billing, TITLES.unbilled]) {
      await createMockIdleAgent(client, { cwd: tempRepo.path, workspaceId, title });
    }
  });

  test.afterAll(async () => {
    await client?.removeProject(projectId).catch(() => undefined);
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup();
  });

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    test(`filters chronological history and highlights matches at ${viewport.width}px`, async ({
      page,
    }) => {
      await resetSeededPageState(page);
      await openSessions(page);
      await page.setViewportSize(viewport);

      await verifyChronologicalFiltering(page);

      await verifyRecencyBeforeMatchStrength(page);

      await verifyExactAndTypoHighlights(page);

      await verifyAllSearchFieldHighlights(page);

      await verifyEmptySearchAndRecovery(page);
    });
  }
});

const LONG_HISTORY_LABELS = {
  workspace: "修复工作空间历史记录中的代理管理与国际化界面布局".repeat(3),
  project: "長いプロジェクト名とエージェント管理の表示確認".repeat(3),
  branch: `feature/${"历史布局与代理管理修复".repeat(4)}`,
  parent: "親エージェントの長いタイトルが履歴一覧の列と重ならないことを確認する".repeat(4),
  child: "子エージェントの長いタイトルと親の識別情報を狭い画面でも読み取れるようにする".repeat(4),
} as const;

async function visibleBox(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Missing visible bounding box for ${locator}`);
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  return box;
}

async function expectReadableHistoryRow(page: Page, agentId: string): Promise<void> {
  const suffix = `${getServerId()}-${agentId}`;
  const row = page.getByTestId(`agent-row-${suffix}`);
  const title = page.getByTestId(`agent-row-title-${suffix}`);
  const metadata = page.getByTestId(`agent-row-metadata-${suffix}`);
  const trailing = page.getByTestId(`agent-row-trailing-${suffix}`);
  const rowBox = await visibleBox(row);
  const titleBox = await visibleBox(title);
  const metadataBox = await visibleBox(metadata);
  const trailingBox = await visibleBox(trailing);

  // The agent has a readable primary line, rather than sharing its width with
  // an unbounded workspace label and the old fixed project/branch columns.
  expect(titleBox.width).toBeGreaterThan(rowBox.width / 2);
  expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(metadataBox.y + 1);
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(trailingBox.x + 1);
  expect(metadataBox.x + metadataBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  expect(trailingBox.x + trailingBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  await expect(page.getByTestId(`agent-row-actions-${suffix}`)).toBeVisible();

  const fields = await Promise.all(
    ["role", "workspace", "project", "branch"].map((field) =>
      visibleBox(page.getByTestId(`agent-row-${field}-${suffix}`)),
    ),
  );
  for (const box of fields) {
    expect(box.x).toBeGreaterThanOrEqual(metadataBox.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(metadataBox.x + metadataBox.width + 1);
    expect(box.y).toBeGreaterThanOrEqual(metadataBox.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(metadataBox.y + metadataBox.height + 1);
  }
  for (let index = 0; index < fields.length; index += 1) {
    for (const other of fields.slice(index + 1)) {
      const box = fields[index];
      const overlapWidth =
        Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x);
      const overlapHeight =
        Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y);
      expect(Math.min(overlapWidth, overlapHeight)).toBeLessThanOrEqual(1);
    }
  }
  const titleOverflow = await title.evaluate((element) => ({
    overflow: getComputedStyle(element).overflow,
    textOverflow: getComputedStyle(element).textOverflow,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(titleOverflow.overflow).toBe("hidden");
  expect(titleOverflow.textOverflow).toBe("ellipsis");
  expect(titleOverflow.scrollWidth).toBeGreaterThan(titleOverflow.clientWidth);
}

test.describe("History multilingual layout", () => {
  let workspace: SeededWorkspace;
  let agents: SeededSubagentPair;

  test.beforeAll(async () => {
    workspace = await seedWorkspace({
      repoPrefix: "history-layout-",
      title: LONG_HISTORY_LABELS.workspace,
    });
    execFileSync("git", ["branch", "-m", LONG_HISTORY_LABELS.branch], {
      cwd: workspace.repoPath,
    });
    await workspace.client.renameProject(workspace.projectId, LONG_HISTORY_LABELS.project);
    await workspace.client.checkoutRefresh(workspace.repoPath);
    agents = await seedParentWithSubagent(workspace, {
      parentTitle: LONG_HISTORY_LABELS.parent,
      childTitle: LONG_HISTORY_LABELS.child,
    });
  });

  test.afterAll(async () => {
    await workspace?.cleanup();
  });

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 820, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    test(`keeps long CJK titles, role badges and metadata separate at ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      await resetSeededPageState(page);
      await openSessions(page);
      await page.setViewportSize(viewport);
      for (const agent of [agents.parent, agents.child]) {
        const suffix = `${getServerId()}-${agent.id}`;
        await expect(page.getByTestId(`agent-row-title-${suffix}`)).toHaveText(agent.title);
        await expect(page.getByTestId(`agent-row-workspace-${suffix}`)).toHaveText(
          LONG_HISTORY_LABELS.workspace,
        );
        await expect(page.getByTestId(`agent-row-project-${suffix}`)).toHaveText(
          LONG_HISTORY_LABELS.project,
        );
        await expect(page.getByTestId(`agent-row-branch-${suffix}`)).toHaveText(
          LONG_HISTORY_LABELS.branch,
        );
        await expectReadableHistoryRow(page, agent.id);
      }
      await expect(
        page.getByTestId(`agent-row-role-${getServerId()}-${agents.parent.id}`),
      ).toContainText("Root");
      await expect(
        page.getByTestId(`agent-row-role-${getServerId()}-${agents.child.id}`),
      ).toContainText(agents.parent.id.slice(0, 7));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      const screenshotPath = testInfo.outputPath(`history-cjk-${viewport.width}.png`);
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach(`History CJK layout at ${viewport.width}px`, {
        path: screenshotPath,
        contentType: "image/png",
      });
    });
  }
});
