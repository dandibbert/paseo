import { randomUUID } from "node:crypto";
import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import { test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient, type SeedDaemonClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import {
  archiveAgentFromDaemon,
  archiveAgentFromSessions,
  clickSessionRow,
  createMockIdleAgent,
  expectArchivedAgentFocused,
  expectSessionRowArchived,
  expectSessionRowNotArchived,
  expectSessionRowVisible,
  expectWorkspaceArchiveOutcome,
  expectWorkspaceTabHidden,
  fetchAgentArchivedAt,
  openSessions,
  openWorkspaceWithAgents,
  primeAdditionalPage,
  resetSeededPageState,
  reloadWorkspace,
} from "../support/helpers/archive-tab";
import { expectAgentTabActive } from "../support/helpers/launcher";
import { renameModalError, renameModalInput, renameModalSubmit } from "../support/helpers/rename";
import { seedParentWithSubagent } from "../support/helpers/subagents";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

function historyRow(page: Page, agentId: string) {
  return page.getByTestId(`agent-row-${getServerId()}-${agentId}`);
}

function historyAction(page: Page, agentId: string, action: string) {
  return page.getByTestId(`agent-history-${action}-${getServerId()}-${agentId}`);
}

async function openHistoryActions(page: Page, agentId: string): Promise<void> {
  await page.getByTestId(`agent-row-actions-${getServerId()}-${agentId}`).click();
  await expect(historyAction(page, agentId, "open")).toBeVisible();
}

async function fetchActiveAgent(client: SeedDaemonClient, agentId: string) {
  const result = await client.fetchAgents({ scope: "active" });
  return result.entries.find((entry) => entry.agent.id === agentId)?.agent;
}

async function expectArchivePersisted(client: SeedDaemonClient, agentId: string): Promise<void> {
  await expect.poll(() => fetchAgentArchivedAt(client, agentId)).not.toBeNull();
}

async function expectUnarchivePersisted(client: SeedDaemonClient, agentId: string): Promise<void> {
  await expect.poll(() => fetchAgentArchivedAt(client, agentId)).toBeNull();
}

async function expectCopiedAgentId(page: Page, agentId: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(agentId);
}

async function holdHistoryRow(page: Page, agentId: string): Promise<void> {
  const box = await historyRow(page, agentId).boundingBox();
  if (!box) throw new Error(`Missing history row for ${agentId}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    // This is a deliberate press duration, not a wait for asynchronous state.
    // A browser hold must never perform the old immediate-archive action.
    await page.waitForTimeout(900);
  } finally {
    await page.mouse.up();
  }
}

/** Close real browser/daemon sockets without synthesizing any daemon messages. */
async function interruptibleDaemonConnection(page: Page) {
  let offline = false;
  let receivedServerInfo = false;
  const sockets = new Set<WebSocketRoute>();
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    if (offline) {
      void socket.close({ code: 1013, reason: "History disconnect regression" });
      return;
    }
    const server = socket.connectToServer();
    sockets.add(socket);
    sockets.add(server);
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      socket.send(message);
      const text = typeof message === "string" ? message : message.toString("utf8");
      const envelope = JSON.parse(text) as {
        type?: string;
        message?: { type?: string; payload?: { status?: string } };
      };
      if (
        envelope.type === "session" &&
        envelope.message?.type === "status" &&
        envelope.message.payload?.status === "server_info"
      ) {
        receivedServerInfo = true;
      }
    });
  });
  return {
    async disconnect() {
      offline = true;
      receivedServerInfo = false;
      await Promise.all(
        Array.from(sockets, (socket) =>
          socket.close({ code: 1013, reason: "History disconnect regression" }),
        ),
      );
      sockets.clear();
    },
    async reconnect() {
      offline = false;
      await expect
        .poll(() => receivedServerInfo, {
          timeout: 30_000,
          message: "The real daemon sends its server_info status after reconnecting",
        })
        .toBe(true);
    },
  };
}

async function respondToArchiveConfirmation(
  page: Page,
  agentId: string,
  response: "accept" | "dismiss",
): Promise<void> {
  const confirmation = page.waitForEvent("dialog");
  const archive = historyAction(page, agentId, "archive").click();
  const dialog = await confirmation;
  expect(dialog.type()).toBe("confirm");
  expect(dialog.message()).toContain("Archive");
  await dialog[response]();
  await archive;
}

test.describe("Archive tab reconciliation", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  let projectId: string;
  let workspaceId: string;

  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("archive-tab-");
    client = await connectSeedClient();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${tempRepo.path}`);
    }
    projectId = created.workspace.projectId;
    workspaceId = created.workspace.id;
  });

  test.afterAll(async () => {
    await client?.removeProject(projectId).catch(() => undefined);
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup();
  });

  test("non-UI archive prunes the archived tab across open pages and reload", async ({ page }) => {
    const archived = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `cli-archive-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `cli-control-${randomUUID().slice(0, 8)}`,
    });
    const passivePage = await page.context().newPage();

    try {
      await primeAdditionalPage(passivePage);
      await resetSeededPageState(page);
      await resetSeededPageState(passivePage);
      await openSessions(page);
      await expectSessionRowVisible(page, archived.title);
      await expectSessionRowVisible(page, surviving.title);
      await openSessions(passivePage);
      await expectSessionRowVisible(passivePage, archived.title);
      await expectSessionRowVisible(passivePage, surviving.title);
      await openWorkspaceWithAgents(page, [archived, surviving]);
      await openWorkspaceWithAgents(passivePage, [archived, surviving]);
      await archiveAgentFromDaemon(client, archived.id);
      await expectWorkspaceArchiveOutcome(page, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
      await expectWorkspaceArchiveOutcome(passivePage, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
      await reloadWorkspace(passivePage, surviving.workspaceId);
      await expectWorkspaceTabHidden(passivePage, archived.id);
    } finally {
      await passivePage.close();
    }
  });

  test("Sessions archive prunes the archived tab across open pages", async ({ page }) => {
    const archived = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `ui-archive-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `ui-control-${randomUUID().slice(0, 8)}`,
    });
    const passivePage = await page.context().newPage();

    try {
      await primeAdditionalPage(passivePage);
      await resetSeededPageState(page);
      await resetSeededPageState(passivePage);
      await openWorkspaceWithAgents(page, [archived, surviving]);
      await openWorkspaceWithAgents(passivePage, [archived, surviving]);
      await openSessions(page);
      await archiveAgentFromSessions(page, { agentId: archived.id, title: archived.title });
      await reloadWorkspace(page, surviving.workspaceId);
      await expectWorkspaceTabHidden(page, archived.id);
      await expectWorkspaceArchiveOutcome(passivePage, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
    } finally {
      await passivePage.close();
    }
  });

  test("clicking an archived session navigates without unarchiving it", async ({ page }) => {
    const archived = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `unarchive-archived-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `unarchive-control-${randomUUID().slice(0, 8)}`,
    });

    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [archived, surviving]);
    await archiveAgentFromDaemon(client, archived.id);
    const archivedAt = await fetchAgentArchivedAt(client, archived.id);
    expect(archivedAt).not.toBeNull();
    await openSessions(page);
    await expectSessionRowArchived(page, archived.title);

    await clickSessionRow(page, archived.title);

    await expectArchivedAgentFocused(page, archived.id);
    await expectAgentTabActive(page, archived.id);
    expect(await fetchAgentArchivedAt(client, archived.id)).toBe(archivedAt);

    await expect(page).toHaveURL(buildHostWorkspaceRoute(getServerId(), archived.workspaceId), {
      timeout: 30_000,
    });
  });

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    test(`history management supports dismissal, rename, archive and unarchive at ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      const agent = await createMockIdleAgent(client, {
        cwd: tempRepo.path,
        workspaceId,
        title: `history-management-${viewport.width}`,
      });
      await resetSeededPageState(page);
      await openSessions(page);
      await page.setViewportSize(viewport);
      const initialUrl = page.url();
      const row = historyRow(page, agent.id);

      await test.step("right-click and the explicit button expose the same actions without navigating", async () => {
        await row.click({ button: "right" });
        for (const action of ["open", "rename", "archive", "copy-id"]) {
          await expect(historyAction(page, agent.id, action)).toBeVisible();
        }
        await expect(historyAction(page, agent.id, "stop")).toHaveCount(0);
        await expect(historyAction(page, agent.id, "unarchive")).toHaveCount(0);
        const screenshotPath = testInfo.outputPath(`history-actions-${viewport.width}.png`);
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach(`History actions at ${viewport.width}px`, {
          path: screenshotPath,
          contentType: "image/png",
        });
        await page.keyboard.press("Escape");
        await expect(historyAction(page, agent.id, "open")).toHaveCount(0);
        await expect(page).toHaveURL(initialUrl);
        await expectSessionRowNotArchived(page, agent.title);

        await holdHistoryRow(page, agent.id);
        await expectSessionRowNotArchived(page, agent.title);
        expect(await fetchAgentArchivedAt(client, agent.id)).toBeNull();
        await expect(page).toHaveURL(initialUrl);
        await expect(historyAction(page, agent.id, "archive")).toHaveCount(0);
        await openHistoryActions(page, agent.id);
        for (const action of ["open", "rename", "archive", "copy-id"]) {
          await expect(historyAction(page, agent.id, action)).toBeVisible();
        }
        await page.keyboard.press("Escape");
        await openHistoryActions(page, agent.id);
        await expect(page).toHaveURL(initialUrl);
      });

      await test.step("copy uses the same menu and acknowledges the copied agent ID", async () => {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await historyAction(page, agent.id, "copy-id").click();
        await expect(historyAction(page, agent.id, "copy-id")).toContainText("Agent ID copied");
        await expectCopiedAgentId(page, agent.id);
      });

      const modalPrefix = `agent-history-rename-${getServerId()}-${agent.id}`;
      const input = renameModalInput(page, modalPrefix);
      await test.step("cancel discards a rename and the reopened form uses the persisted title", async () => {
        await historyAction(page, agent.id, "rename").click();
        await expect(input).toHaveValue(agent.title);
        await input.fill("Do not save this title");
        await page.getByTestId(`${modalPrefix}-cancel`).click();
        await expect(input).toHaveCount(0);
        await expect(row).toContainText(agent.title);
        await openHistoryActions(page, agent.id);
        await historyAction(page, agent.id, "rename").click();
        await expect(input).toHaveValue(agent.title);
      });

      const renamedTitle = `履歴から名前を変更したエージェント ${viewport.width}`;
      await input.fill(renamedTitle);
      await renameModalSubmit(page, modalPrefix).click();
      await expect(input).toHaveCount(0);
      await expect(row).toContainText(renamedTitle);
      await expect
        .poll(async () => (await fetchActiveAgent(client, agent.id))?.title)
        .toBe(renamedTitle);

      await test.step("cancelling archive leaves history unchanged and another attempt succeeds", async () => {
        await openHistoryActions(page, agent.id);
        await respondToArchiveConfirmation(page, agent.id, "dismiss");
        await expectSessionRowNotArchived(page, renamedTitle);
        expect(await fetchAgentArchivedAt(client, agent.id)).toBeNull();
        await openHistoryActions(page, agent.id);
        await respondToArchiveConfirmation(page, agent.id, "accept");
        await expectSessionRowArchived(page, renamedTitle);
        await expectArchivePersisted(client, agent.id);
        await expect(page).toHaveURL(initialUrl);
      });

      await test.step("unarchive updates the badge and repeated menus show the current state", async () => {
        await openHistoryActions(page, agent.id);
        await expect(historyAction(page, agent.id, "archive")).toHaveCount(0);
        await expect(historyAction(page, agent.id, "stop")).toHaveCount(0);
        await historyAction(page, agent.id, "unarchive").click();
        await expectSessionRowNotArchived(page, renamedTitle);
        await expectUnarchivePersisted(client, agent.id);
        await openHistoryActions(page, agent.id);
        await expect(historyAction(page, agent.id, "archive")).toBeVisible();
        await expect(historyAction(page, agent.id, "unarchive")).toHaveCount(0);
        await historyAction(page, agent.id, "open").click();
        await expectAgentTabActive(page, agent.id);
        await expect(page).toHaveURL(buildHostWorkspaceRoute(getServerId(), workspaceId));
      });
    });
  }

  test("history management retains a failed rename and retries after reconnecting", async ({
    page,
  }, testInfo) => {
    const agent = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: "History rename before disconnect",
    });
    const connection = await interruptibleDaemonConnection(page);
    await resetSeededPageState(page);
    await openSessions(page);
    await openHistoryActions(page, agent.id);
    await historyAction(page, agent.id, "rename").click();
    const modalPrefix = `agent-history-rename-${getServerId()}-${agent.id}`;
    const input = renameModalInput(page, modalPrefix);
    const draft = "保留された名前を再接続して保存する";
    await input.fill(draft);
    await connection.disconnect();
    await renameModalSubmit(page, modalPrefix).click();
    await expect(renameModalError(page, modalPrefix)).toContainText("Connect to this host");
    await expect(input).toHaveValue(draft);
    await expect(renameModalSubmit(page, modalPrefix)).toBeEnabled();
    expect((await fetchActiveAgent(client, agent.id))?.title).toBe(agent.title);
    const screenshotPath = testInfo.outputPath("history-rename-disconnected.png");
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("History rename preserves a failed draft", {
      path: screenshotPath,
      contentType: "image/png",
    });

    await connection.reconnect();
    await expect(input).toHaveValue(draft);
    await renameModalSubmit(page, modalPrefix).click();
    await expect(input).toHaveCount(0);
    await expect(historyRow(page, agent.id)).toContainText(draft);
    await expect.poll(async () => (await fetchActiveAgent(client, agent.id))?.title).toBe(draft);
    await expect(page.getByTestId(`agent-history-error-${getServerId()}-${agent.id}`)).toHaveCount(
      0,
    );
  });

  test("history management opens a child's parent and stops a running agent", async ({ page }) => {
    const agents = await seedParentWithSubagent(
      { client, repoPath: tempRepo.path, workspaceId },
      { parentTitle: "History parent navigation", childTitle: "History managed child" },
    );
    const running = await client.createAgent({
      provider: "mock",
      model: "five-minute-stream",
      modeId: "load-test",
      cwd: tempRepo.path,
      workspaceId,
      title: "History stop running agent",
      initialPrompt: "Keep running until stopped from history",
    });
    await client.waitForAgentUpsert(
      running.id,
      (snapshot) => snapshot.status === "running",
      15_000,
    );
    await resetSeededPageState(page);
    await openSessions(page);

    await openHistoryActions(page, agents.child.id);
    await historyAction(page, agents.child.id, "open-parent").click();
    await expectAgentTabActive(page, agents.parent.id);
    await openSessions(page);

    await openHistoryActions(page, running.id);
    const confirmation = page.waitForEvent("dialog");
    const stop = historyAction(page, running.id, "stop").click();
    const dialog = await confirmation;
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("Stop");
    await dialog.accept();
    await stop;
    await expect
      .poll(async () => (await fetchActiveAgent(client, running.id))?.status)
      .toBe("idle");
    await expectSessionRowNotArchived(page, "History stop running agent");
    await openHistoryActions(page, running.id);
    await expect(historyAction(page, running.id, "stop")).toHaveCount(0);
    await expect(historyAction(page, running.id, "archive")).toBeVisible();
    await page.keyboard.press("Escape");
  });
});
