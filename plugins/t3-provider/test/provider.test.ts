import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { parsePairOutput } from "../server/auth.js";
import { createT3Provider } from "../server/provider.js";
import { reportFromT3 } from "../server/usage.js";
import { FakeT3, projection, run, turnItem } from "./fake-t3.js";

// Each test runs a real HTTP and WebSocket server; CI runs every plugin suite at once.
vi.setConfig({ testTimeout: 30_000 });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function harness(options: ConstructorParameters<typeof FakeT3>[0] = {}) {
  const t3 = await new FakeT3(options).start();
  const root = await mkdtemp(path.join(os.tmpdir(), "t3-provider-test-"));
  const credentialsFile = path.join(root, "credentials.json");
  const cwd = path.join(root, "project");
  const provider = createT3Provider({ environment: { credentialsFile } });
  const launch = {
    command: "t3",
    args: [],
    env: { T3_PAIRING_URL: t3.pairingUrl },
  };
  const connection = await provider.connect({
    launch,
    versions: [1],
    capabilities: [...PROVIDER_CAPABILITIES],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  cleanups.push(async () => {
    await connection.close();
    await t3.stop();
    await rm(root, { recursive: true, force: true });
  });
  let request = 0;
  const send = (input: ProviderInput) => connection.send(input);
  async function waitFor<T extends ProviderEvent>(
    predicate: (event: ProviderEvent) => event is T,
    after = 0,
  ): Promise<T>;
  async function waitFor(
    predicate: (event: ProviderEvent) => boolean,
    after?: number,
  ): Promise<ProviderEvent>;
  async function waitFor(predicate: (event: ProviderEvent) => boolean, after = 0) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const found = events.slice(after).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`Timed out. Events:\n${events.map((e) => JSON.stringify(e)).join("\n")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async function open(input: Partial<Extract<ProviderInput, { type: "session.open" }>> = {}) {
    const requestId = `open-${++request}`;
    await send({
      type: "session.open",
      requestId,
      sessionId: "s1",
      history: "replay",
      config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true },
      ...input,
    } as ProviderInput);
    const outcome = await waitFor(
      (event) =>
        (event.type === "session.ready" || event.type === "request.failed") &&
        event.requestId === requestId,
    );
    if (outcome.type === "request.failed") throw new Error(outcome.error.message);
  }
  async function prompt(text: string, delivery: "auto" | "steer" = "auto") {
    const clientMessageId = `client-${++request}`;
    await send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId,
        delivery,
        input: { type: "message", content: [{ type: "text", text }] },
      },
    });
    return clientMessageId;
  }
  return {
    t3,
    connection: connection as ProviderConnection,
    events,
    send,
    waitFor,
    open,
    prompt,
    cwd,
    credentialsFile,
  };
}

test("reads the origin and one-time token from `t3 pair` output", () => {
  const output = [
    "Pairing with my-mac (http://127.0.0.1:3773).",
    "",
    "▄▄▄ (QR code)",
    "",
    "Pairing URL: http://192.168.1.5:3773/pair#token=abc123",
    "App link: t3code://pair?url=...",
    "Token: abc123",
    "Expires: 2026-11-22T00:05:00.000Z",
  ].join("\n");
  expect(parsePairOutput(output)).toEqual({ baseUrl: "http://127.0.0.1:3773", token: "abc123" });
});

test("pairs as the Paseo client with only orchestration scopes and keeps the session private", async () => {
  const h = await harness();
  await h.send({ type: "catalog", requestId: "c1" });
  await h.waitFor((event) => event.type === "catalog");
  const [form] = h.t3.tokenRequests;
  expect(form.get("client_label")).toBe("Paseo");
  expect(form.get("client_device_type")).toBe("desktop");
  expect(form.get("scope")).toBe("orchestration:read orchestration:operate");
  expect(form.get("subject_token")).toBe(h.t3.pairingToken);
  const saved = JSON.parse(await readFile(h.credentialsFile, "utf8"));
  expect(saved).toMatchObject({ baseUrl: h.t3.baseUrl, accessToken: h.t3.accessToken });
  if (process.platform !== "win32") {
    expect((await stat(h.credentialsFile)).mode & 0o777).toBe(0o600);
  }
});

test("offers only T3's Antigravity accounts, each model under its account", async () => {
  const h = await harness();
  await h.send({ type: "catalog", requestId: "c1" });
  const event = await h.waitFor(
    (candidate): candidate is Extract<ProviderEvent, { type: "catalog" }> =>
      candidate.type === "catalog",
  );
  expect(event.catalog.models.map((model) => [model.id, model.label])).toEqual([
    ["antigravity::gemini-4-pro", "Gemini 4 Pro · Antigravity"],
    ["antigravity-work::gemini-4-pro", "Gemini 4 Pro · Work account"],
  ]);
  expect(event.catalog.models[0].thinkingOptions?.map((option) => option.id)).toEqual([
    "low",
    "high",
  ]);
  expect(event.catalog.defaultModel).toBe("antigravity::gemini-4-pro");
  expect(event.catalog.defaultThinkingOption).toBe("high");
  expect(event.catalog.defaultMode).toBe("full-access");
  expect(event.catalog.modes.map((mode) => mode.id)).toEqual([
    "approval-required",
    "auto-accept-edits",
    "full-access",
  ]);
});

test("starts a T3 thread the way T3's apps do and streams its run into Paseo", async () => {
  const h = await harness();
  await h.open();
  const clientMessageId = await h.prompt("Fix the bug");

  const result = await h.waitFor(
    (event) => event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
  );
  expect(result).toMatchObject({ result: { type: "turn", turnId: "run-1" } });

  const project = h.t3.requests.find((request) => request.tag === "projects.mutate");
  expect(project?.payload).toMatchObject({ type: "project.create", workspaceRoot: h.cwd });
  const launch = h.t3.requests.find((request) => request.tag === "orchestration.launchThread");
  expect(launch?.payload).toMatchObject({
    projectId: project?.payload.projectId,
    modelSelection: {
      instanceId: "antigravity",
      model: "gemini-4-pro",
      options: [{ id: "thinking", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text: "Fix the bug", attachments: [] },
  });
  // T3 records the source itself, as for its own apps' launches.
  expect(launch?.payload).not.toHaveProperty("creationSource");
  await h.waitFor((event) => event.type === "session.persistence");

  if (!launch) throw new Error("No launch request");
  const messageId = (launch.payload.initialMessage as { messageId: string }).messageId;
  h.t3.emit("run.updated", run({ userMessageId: messageId, status: "running" }));
  h.t3.emit(
    "turn-item.updated",
    turnItem({ id: "u1", type: "user_message", messageId, text: "Fix the bug", ordinal: 1 }),
  );
  h.t3.emit(
    "turn-item.updated",
    turnItem({
      id: "a1",
      type: "assistant_message",
      messageId: "m2",
      text: "Done.",
      streaming: false,
      ordinal: 2,
    }),
  );
  h.t3.emit(
    "turn-item.updated",
    turnItem({
      id: "c1",
      type: "command_execution",
      input: "npm test",
      output: "ok",
      exitCode: 0,
      ordinal: 3,
    }),
  );
  h.t3.emit("run.updated", run({ userMessageId: messageId, status: "completed" }));

  await h.waitFor((event) => event.type === "session.turn" && event.state === "completed");
  const turnStates = h.events.flatMap((event) =>
    event.type === "session.turn" ? [`${event.turnId}:${event.state}`] : [],
  );
  expect(turnStates).toEqual(["run-1:started", "run-1:completed"]);
  const items = h.events.flatMap((event) => (event.type === "timeline.item" ? [event.item] : []));
  expect(items).toEqual([
    { type: "user_message", id: "u1", text: "Fix the bug", messageId, clientMessageId },
    { type: "assistant_message", id: "a1", text: "Done.", messageId: "m2" },
    expect.objectContaining({
      type: "tool_call",
      id: "c1",
      status: "completed",
      detail: { type: "shell", command: "npm test", output: "ok", exitCode: 0 },
    }),
  ]);
});

test("follow-up messages go through message.dispatch as a person's message", async () => {
  const h = await harness({ projects: [{ id: "p1", workspaceRoot: "" }] });
  await h.open();
  await h.prompt("first");
  await h.waitFor((event) => event.type === "session.persistence");
  h.t3.emit("run.updated", run({ status: "completed" }));
  await h.prompt("second");
  await h.waitFor(() => h.t3.commands("message.dispatch").length === 1);
  expect(h.t3.commands("message.dispatch")[0]).toMatchObject({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    threadId: "thread-1",
    text: "second",
    attachments: [],
    deliveryIntent: "auto",
    dispatchMode: { type: "start_immediately" },
  });
});

test("uploads prompt images to T3 and sends them with the message", async () => {
  const h = await harness();
  await h.open();
  const png = Buffer.from("fake png bytes").toString("base64");
  await h.send({
    type: "session.prompt",
    sessionId: "s1",
    prompt: {
      clientMessageId: "client-image-1",
      delivery: "auto",
      input: {
        type: "message",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", data: png, mimeType: "image/PNG" },
        ],
      },
    },
  });
  await h.waitFor((event) => event.type === "session.persistence");
  const upload = h.t3.requests.find((r) => r.tag === "assets.persistChatAttachments");
  const launch = h.t3.requests.find((r) => r.tag === "orchestration.launchThread");
  expect(upload?.payload).toMatchObject({
    threadId: launch?.payload.threadId,
    attachments: [
      {
        type: "image",
        name: "image-2.png",
        mimeType: "image/png",
        sizeBytes: 14,
        dataUrl: `data:image/png;base64,${png}`,
      },
    ],
  });
  const initialMessage = launch?.payload.initialMessage as Record<string, unknown>;
  expect(initialMessage.text).toBe("what is this?");
  expect(initialMessage.attachments).toEqual([
    {
      type: "image",
      id: `${String(launch?.payload.threadId)}-0`,
      name: "image-2.png",
      mimeType: "image/png",
      sizeBytes: 14,
    },
  ]);

  // An image-only follow-up, sent as a data URL.
  await h.send({
    type: "session.prompt",
    sessionId: "s1",
    prompt: {
      clientMessageId: "client-image-2",
      delivery: "auto",
      input: {
        type: "message",
        content: [{ type: "image", data: `data:image/jpeg;base64,${png}`, mimeType: "image/jpeg" }],
      },
    },
  });
  await h.waitFor(() => h.t3.commands("message.dispatch").length === 1);
  expect(h.t3.commands("message.dispatch")[0]).toMatchObject({
    threadId: "thread-1",
    text: "",
    attachments: [{ type: "image", id: "thread-1-0", name: "image-1.jpg", mimeType: "image/jpeg" }],
  });
});

function providerTurn(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "pt-1",
    providerThreadId: "ptt-1",
    nodeId: "n1",
    runAttemptId: "attempt-1",
    nativeTurnRef: null,
    ordinal: 1,
    status: "completed",
    startedAt: "2026-11-22T00:00:00.000Z",
    completedAt: "2026-11-22T00:00:01.000Z",
    ...fields,
  };
}

test("reports each run's tokens, cache reads and context to Paseo before the turn ends", async () => {
  const h = await harness();
  await h.open();
  await h.prompt("Fix the bug");
  await h.waitFor((event) => event.type === "session.persistence");
  h.t3.emit("run.updated", run({ status: "running", activeAttemptId: "attempt-1" }));
  // The context figure arrives while the run works.
  h.t3.emit(
    "provider-turn.updated",
    providerTurn({
      status: "running",
      tokenUsage: { usedTokens: 50_000, maxTokens: 1_000_000, updatedAt: "2026-11-22T00:00:00Z" },
    }),
  );
  await h.waitFor((event) => event.type === "session.usage");
  h.t3.emit(
    "provider-turn.updated",
    providerTurn({
      tokenUsage: { usedTokens: 52_000, maxTokens: 1_000_000, updatedAt: "2026-11-22T00:00:01Z" },
      // T3 counts cached reads inside inputTokens; Paseo reports them apart.
      turnTokenUsage: {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 40_000,
        cachedInputTokens: 30_000,
        outputTokens: 1_200,
      },
    }),
  );
  h.t3.emit("run.updated", run({ status: "completed", activeAttemptId: "attempt-1" }));
  await h.waitFor((event) => event.type === "session.turn" && event.state === "completed");

  const sequence = h.events.flatMap((event) => {
    if (event.type === "session.usage") return [{ usage: event.usage, turnId: event.turnId }];
    return event.type === "session.turn" ? [event.state] : [];
  });
  expect(sequence).toEqual([
    "started",
    {
      turnId: "run-1",
      usage: { contextWindowUsedTokens: 50_000, contextWindowMaxTokens: 1_000_000 },
    },
    {
      turnId: "run-1",
      usage: {
        inputTokens: 10_000,
        cachedInputTokens: 30_000,
        outputTokens: 1_200,
        contextWindowUsedTokens: 52_000,
        contextWindowMaxTokens: 1_000_000,
      },
    },
    "completed",
  ]);
});

test("a reopened thread restores the latest run's usage", async () => {
  const h = await harness();
  h.t3.setProjection(
    projection({
      runs: [run({ status: "completed" })],
      attempts: [{ id: "attempt-1", runId: "run-1" }],
      providerTurns: [
        providerTurn({
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 5,
            cachedInputTokens: 2,
            outputTokens: 1,
          },
        }),
      ],
    }),
  );
  await h.open({ persistence: { version: 1, data: { threadId: "thread-1" } } });
  expect(h.events.filter((event) => event.type === "session.usage")).toEqual([
    {
      type: "session.usage",
      sessionId: "s1",
      turnId: "run-1",
      usage: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 1 },
    },
  ]);
});

test("reuses the T3 project already rooted at the working directory", async () => {
  const h = await harness();
  // The harness cwd is fixed per run; point the fake's project list at it.
  (h.t3 as unknown as { options: { projects: unknown[] } }).options.projects = [
    { id: "existing", workspaceRoot: h.cwd },
  ];
  await h.open();
  await h.prompt("hello");
  await h.waitFor((event) => event.type === "session.persistence");
  expect(h.t3.requests.some((request) => request.tag === "projects.mutate")).toBe(false);
  const launch = h.t3.requests.find((request) => request.tag === "orchestration.launchThread");
  expect(launch?.payload.projectId).toBe("existing");
});

test("asks in Paseo for T3's approvals and answers with T3's decision", async () => {
  const h = await harness();
  await h.open();
  await h.prompt("run it");
  await h.waitFor((event) => event.type === "session.persistence");
  h.t3.emit("run.updated", run({ status: "running" }));
  h.t3.emit("runtime-request.updated", {
    id: "req-1",
    nodeId: "n1",
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "ps1" },
    createdAt: "2026-11-22T00:00:00.000Z",
    resolvedAt: null,
  });
  h.t3.emit(
    "turn-item.updated",
    turnItem({
      id: "ap1",
      type: "approval_request",
      requestId: "req-1",
      requestKind: "command",
      prompt: "rm -rf build",
      status: "waiting",
    }),
  );
  const permission = await h.waitFor(
    (event): event is Extract<ProviderEvent, { type: "session.permission" }> =>
      event.type === "session.permission",
  );
  expect(permission.request).toMatchObject({
    id: "req-1",
    kind: "tool",
    detail: { type: "shell", command: "rm -rf build" },
  });
  await h.send({
    type: "session.permission",
    sessionId: "s1",
    permissionId: "req-1",
    response: { behavior: "allow", selectedActionId: "acceptForSession" },
  });
  await h.waitFor(() => h.t3.commands("runtime-request.respond").length === 1);
  expect(h.t3.commands("runtime-request.respond")[0]).toMatchObject({
    threadId: "thread-1",
    requestId: "req-1",
    decision: "acceptForSession",
  });
  h.t3.emit("runtime-request.updated", {
    id: "req-1",
    kind: "command",
    status: "resolved",
  });
  await h.waitFor(
    (event) => event.type === "session.permission_resolved" && event.permissionId === "req-1",
  );
});

test("answers T3's questions by question id", async () => {
  const h = await harness();
  await h.open();
  await h.prompt("ask me");
  await h.waitFor((event) => event.type === "session.persistence");
  h.t3.emit("runtime-request.updated", { id: "req-2", kind: "user_input", status: "pending" });
  h.t3.emit(
    "turn-item.updated",
    turnItem({
      id: "q1",
      type: "user_input_request",
      requestId: "req-2",
      status: "waiting",
      questions: [
        {
          id: "db",
          header: "Database",
          question: "Which database?",
          options: [
            { label: "Postgres", description: "Relational" },
            { label: "SQLite", description: "File" },
          ],
        },
      ],
    }),
  );
  await h.waitFor((event) => event.type === "session.permission");
  await h.send({
    type: "session.permission",
    sessionId: "s1",
    permissionId: "req-2",
    response: { behavior: "allow", updatedInput: { answers: { Database: "SQLite" } } },
  });
  await h.waitFor(() => h.t3.commands("runtime-request.respond").length === 1);
  expect(h.t3.commands("runtime-request.respond")[0]).toMatchObject({
    requestId: "req-2",
    answers: { db: "SQLite" },
  });
});

test("answers a secret request in Paseo instead of sending you to T3", async () => {
  const h = await harness();
  await h.open();
  await h.prompt("deploy");
  await h.waitFor((event) => event.type === "session.persistence");
  h.t3.emit(
    "turn-item.updated",
    turnItem({
      id: "sec1",
      type: "secret_request",
      label: "API key",
      reason: "To deploy",
      secretStatus: "pending",
      status: "waiting",
    }),
  );
  await h.waitFor((event) => event.type === "session.permission");
  await h.send({
    type: "session.permission",
    sessionId: "s1",
    permissionId: "secret:sec1",
    response: { behavior: "allow", updatedInput: { answers: { secret: "sk-123" } } },
  });
  await h.waitFor(() => h.t3.requests.some((request) => request.tag === "secrets.answerRequest"));
  expect(h.t3.requests.find((request) => request.tag === "secrets.answerRequest")?.payload).toEqual(
    {
      threadId: "thread-1",
      turnItemId: "sec1",
      answer: { type: "save", secret: "sk-123" },
    },
  );
});

test("interrupts the running T3 run", async () => {
  const h = await harness();
  await h.open();
  await h.prompt("long task");
  await h.waitFor((event) => event.type === "session.persistence");
  h.t3.emit("run.updated", run({ status: "running" }));
  await h.waitFor((event) => event.type === "session.turn" && event.state === "started");
  await h.send({ type: "session.interrupt", requestId: "i1", sessionId: "s1" });
  await h.waitFor((event) => event.type === "request.completed" && event.requestId === "i1");
  expect(h.t3.commands("run.interrupt")[0]).toMatchObject({
    threadId: "thread-1",
    runId: "run-1",
    holdQueue: true,
  });
  h.t3.emit("run.updated", run({ status: "interrupted" }));
  await h.waitFor((event) => event.type === "session.turn" && event.state === "canceled");
});

test("reopens a saved thread with its history and no live turns", async () => {
  const h = await harness();
  h.t3.setProjection(
    projection({
      runs: [run({ status: "completed" })],
      turnItems: [
        turnItem({
          id: "u1",
          type: "user_message",
          messageId: "message-1",
          text: "hi",
          ordinal: 1,
        }),
        turnItem({
          id: "a1",
          type: "assistant_message",
          messageId: "m2",
          text: "hello",
          streaming: false,
          ordinal: 2,
        }),
      ],
    }),
  );
  await h.open({ persistence: { version: 1, data: { threadId: "thread-1" } } });
  expect(h.events.filter((event) => event.type === "session.turn")).toEqual([]);
  expect(
    h.events.flatMap((event) => (event.type === "timeline.item" ? [event.item.id] : [])),
  ).toEqual(["u1", "a1"]);
  const opened = h.events.find((event) => event.type === "session.opened");
  expect(opened).toMatchObject({ persistence: { version: 1, data: { threadId: "thread-1" } } });
});

test("switches the model and permission mode on the T3 thread", async () => {
  const h = await harness();
  await h.open({ persistence: { version: 1, data: { threadId: "thread-1" } } });
  await h.send({
    type: "session.configure",
    requestId: "cfg",
    sessionId: "s1",
    changes: { model: "antigravity-work::gemini-4-pro", mode: "approval-required" },
  });
  await h.waitFor((event) => event.type === "request.completed" && event.requestId === "cfg");
  expect(h.t3.commands("thread.runtime-mode.set")[0]).toMatchObject({
    runtimeMode: "approval-required",
  });
  expect(h.t3.commands("thread.model-selection.set")[0]).toMatchObject({
    modelSelection: { instanceId: "antigravity-work", model: "gemini-4-pro" },
  });
});

test("never runs or asks for agy: every request goes to T3", async () => {
  const h = await harness();
  await h.open();
  await h.prompt("hello");
  await h.waitFor((event) => event.type === "session.persistence");
  const tags = new Set(h.t3.requests.map((request) => request.tag));
  expect([...tags].sort()).toEqual([
    "orchestration.launchThread",
    "orchestration.subscribeShell",
    "orchestration.subscribeThread",
    "projects.mutate",
    "server.getConfig",
  ]);
});

test("resumes the thread stream after T3 drops the connection", async () => {
  const h = await harness();
  await h.open();
  await h.prompt("hello");
  await h.waitFor((event) => event.type === "session.persistence");
  const subscriptions = () =>
    h.t3.requests.filter((request) => request.tag === "orchestration.subscribeThread").length;
  expect(subscriptions()).toBe(1);
  h.t3.dropConnections();
  await h.waitFor(() => subscriptions() === 2);
  const resumed = h.t3.requests.filter(
    (request) => request.tag === "orchestration.subscribeThread",
  )[1];
  expect(resumed.payload).toHaveProperty("afterSequence");
  h.t3.emit("run.updated", run({ status: "completed" }));
  await h.waitFor((event) => event.type === "session.turn" && event.state === "completed");
});

test("shows each account's quota as T3 measured it, without running agy", () => {
  expect(
    reportFromT3({
      checkedAt: "2026-11-22T00:00:00.000Z",
      windows: [
        {
          id: "5h",
          kind: "session",
          label: "5-hour",
          usedPercent: 40,
          resetsAt: "2026-11-22T05:00:00.000Z",
        },
        { id: "wk", kind: "weekly", label: "Weekly", usedPercent: 90 },
      ],
    }),
  ).toMatchObject({
    status: "available",
    observedAt: "2026-11-22T00:00:00.000Z",
    windows: [
      { id: "5h", shortLabel: "5h", usedPct: 40, remainingPct: 60, durationSeconds: 18000 },
      { id: "wk", shortLabel: "wk", usedPct: 90, remainingPct: 10, tone: "warning" },
    ],
  });
  expect(
    reportFromT3({ checkedAt: "x", windows: [], unavailable: { reason: "probeFailed" } }),
  ).toMatchObject({
    status: "unavailable",
  });
});

test("says T3 needs a different protocol instead of failing to connect", async () => {
  const h = await harness({ orchestrationProtocol: 3 });
  await h.send({ type: "catalog", requestId: "c1" });
  const failed = await h.waitFor(
    (event): event is Extract<ProviderEvent, { type: "request.failed" }> =>
      event.type === "request.failed",
  );
  expect(failed.error.message).toContain("orchestration protocol 3");
});
