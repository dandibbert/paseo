import type {
  ProviderConfigChanges,
  ProviderEvent,
  ProviderInput,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_RUNTIME_MODE,
  buildCatalog,
  catalogModes,
  catalogModels,
  findModel,
  modelId,
  modelSelection,
  optionControls,
  parseModelId,
  type ModelRef,
} from "./catalog.js";
import { CREATION_SOURCE, type T3Environment, type T3Instance } from "./environment.js";
import { mapTurnItem, readTurnItem, type T3TurnItem } from "./timeline.js";
import { usageFromProviderTurn } from "./turn-usage.js";

const PERSISTENCE_VERSION = 1;
const persistenceSchema = z.object({ threadId: z.string().min(1) });

const ACTIVE_RUN = new Set(["starting", "running", "waiting"]);
const TERMINAL_RUN: Record<string, "completed" | "failed" | "canceled"> = {
  completed: "completed",
  failed: "failed",
  interrupted: "canceled",
  cancelled: "canceled",
  rolled_back: "canceled",
};

export class T3SessionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "T3SessionError";
  }
}

interface RunState {
  id: string;
  status: string;
  userMessageId?: string;
  started: boolean;
  ended: boolean;
}

interface RuntimeRequest {
  id: string;
  kind: string;
  status: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Paseo's prompt content as the plain text T3 sends Antigravity. */
export function promptText(prompt: ProviderPrompt): string {
  if (prompt.input.type === "command") {
    return `/${prompt.input.name}${prompt.input.arguments ? ` ${prompt.input.arguments}` : ""}`;
  }
  return prompt.input.content
    .flatMap((content) => {
      switch (content.type) {
        case "text":
          return [content.text];
        case "image":
          return [];
        default: {
          const attachment = content as Record<string, unknown>;
          if (typeof attachment.text === "string") return [attachment.text];
          if (typeof attachment.url === "string") {
            const title = typeof attachment.title === "string" ? `${attachment.title}\n` : "";
            const body = typeof attachment.body === "string" ? `\n${attachment.body}` : "";
            return [`${title}${attachment.url}${body}`];
          }
          if (typeof attachment.path === "string") return [`Attached file: ${attachment.path}`];
          return [];
        }
      }
    })
    .join("\n\n");
}

/** An image from Paseo's prompt, as T3's web app uploads one. */
export interface T3ImageUpload {
  type: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The prompt's images. Paseo sends base64, with or without the `data:` prefix. */
export function promptImages(prompt: ProviderPrompt): T3ImageUpload[] {
  if (prompt.input.type !== "message") return [];
  return prompt.input.content.flatMap((content, index) => {
    if (content.type !== "image") return [];
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(content.data);
    // T3 checks the data URL's type against `mimeType` in lower case.
    const mimeType = (match?.[1] ?? content.mimeType).toLowerCase();
    const base64 = match?.[2] ?? content.data;
    const extension = IMAGE_EXTENSIONS[mimeType] ?? mimeType.split("/")[1] ?? "img";
    return [
      {
        type: "image" as const,
        name: `image-${index + 1}.${extension}`,
        mimeType,
        sizeBytes: Buffer.from(base64, "base64").byteLength,
        dataUrl: `data:${mimeType};base64,${base64}`,
      },
    ];
  });
}

export interface T3SessionOptions {
  id: string;
  environment: T3Environment;
  emit: (event: ProviderEvent) => void;
  capabilities: readonly string[];
}

/** One Paseo agent backed by one T3 thread that runs Antigravity. */
export class T3Session {
  private config: ProviderSessionConfig;
  private instances: T3Instance[] = [];
  private ref: ModelRef | undefined;
  private runtimeMode = DEFAULT_RUNTIME_MODE;
  private thinkingOption: string | undefined;
  private providerOptions: Record<string, unknown> = {};
  private threadId: string | undefined;
  private subscription: { cancel(): void } | undefined;
  private lastSequence: number | undefined;
  private readonly items = new Map<string, T3TurnItem>();
  private readonly published = new Map<string, string>();
  private readonly runs = new Map<string, RunState>();
  private readonly requests = new Map<string, RuntimeRequest>();
  private readonly permissions = new Map<string, ProviderPermissionRequest>();
  /** T3 message id → Paseo client message id, for messages sent from Paseo. */
  private readonly clientMessageIds = new Map<string, string>();
  /** Messages sent as steering: their effect lands in the run already going. */
  private readonly steerMessageIds = new Set<string>();
  /** Run attempt id → run id: T3 hangs a provider turn's usage on the attempt. */
  private readonly attemptRuns = new Map<string, string>();
  /** Provider turns whose attempt has not arrived yet, by attempt id. */
  private readonly orphanTurns = new Map<string, Record<string, unknown>>();
  /** Each run's latest usage, and the figure last sent to Paseo for it. */
  private readonly runUsage = new Map<string, { usage: ProviderUsage; sent?: string }>();
  private replaying = false;
  private closed = false;
  private readonly stopReconnect: () => void;

  constructor(private readonly options: T3SessionOptions) {
    this.config = {} as ProviderSessionConfig;
    this.stopReconnect = options.environment.onReconnect(() => this.resubscribe());
  }

  async open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    this.config = input.config;
    this.instances = await this.options.environment.instances();
    const catalog = buildCatalog(this.instances);
    const requested = input.config.model ?? catalog.defaultModel;
    const ref = requested ? parseModelId(requested) : undefined;
    if (!ref || !findModel(this.instances, ref)) {
      throw new T3SessionError(
        catalog.models.length === 0
          ? "T3 has no Antigravity account ready. Sign in to Antigravity in T3 first."
          : `T3 has no Antigravity model ${requested}.`,
        "modelUnavailable",
      );
    }
    this.ref = ref;
    this.runtimeMode = input.config.mode ?? catalog.defaultMode ?? DEFAULT_RUNTIME_MODE;
    this.thinkingOption =
      input.config.thinkingOption ??
      catalog.models.find((model) => model.id === modelId(ref))?.defaultThinkingOptionId;
    this.providerOptions = { ...input.config.providerOptions };

    if (input.persistence) {
      if (input.persistence.version !== PERSISTENCE_VERSION) {
        throw new T3SessionError("Unsupported T3 session record.", "invalidPersistence");
      }
      this.threadId = persistenceSchema.parse(input.persistence.data).threadId;
    }

    this.options.emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: this.options.id,
      cwd: input.config.cwd,
      restoration: "core",
      capabilities: this.options.capabilities,
      ...(this.persistence() ? { persistence: this.persistence() } : {}),
    });
    if (this.threadId) await this.subscribe(input.history === "replay");
    this.publishConfig();
    this.options.emit({
      type: "session.ready",
      requestId: input.requestId,
      sessionId: this.options.id,
    });
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    const body = promptText(prompt);
    const images = promptImages(prompt);
    if (!body.trim() && images.length === 0) {
      throw new T3SessionError("The message is empty.", "emptyPrompt");
    }
    const messageId = randomUUID();
    this.clientMessageIds.set(messageId, prompt.clientMessageId);
    const active = this.activeRun();

    if (!this.threadId) {
      await this.launch(messageId, body, images);
      return;
    }
    const attachments = await this.uploadImages(this.threadId, messageId, images);
    const steer = prompt.delivery === "steer" && active !== undefined;
    if (steer) this.steerMessageIds.add(messageId);
    await this.options.environment.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: CREATION_SOURCE,
      threadId: this.threadId,
      messageId,
      text: body,
      attachments,
      modelSelection: this.selection(),
      deliveryIntent: steer ? "steer" : "auto",
      dispatchMode: { type: "start_immediately" },
    });
    if (steer && active) {
      this.options.emit({
        type: "session.prompt_result",
        sessionId: this.options.id,
        clientMessageId: prompt.clientMessageId,
        result: { type: "steer", turnId: active.id },
      });
    }
  }

  async interrupt(): Promise<void> {
    const active = this.activeRun() ?? this.queuedRun();
    if (!active || !this.threadId) return;
    await this.options.environment.dispatch({
      type: "run.interrupt",
      threadId: this.threadId,
      runId: active.id,
      holdQueue: true,
    });
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    let selectionChanged = false;
    if (changes.model !== undefined) {
      const ref = changes.model ? parseModelId(changes.model) : undefined;
      // An account added in T3 after this session started is missing from its copy.
      if (ref && !findModel(this.instances, ref)) {
        this.instances = await this.options.environment.instances();
      }
      if (!ref || !findModel(this.instances, ref)) {
        throw new T3SessionError(
          `T3 has no Antigravity model ${changes.model}.`,
          "modelUnavailable",
        );
      }
      this.ref = ref;
      this.thinkingOption = catalogModels(this.instances).find(
        (model) => model.id === modelId(ref),
      )?.defaultThinkingOptionId;
      selectionChanged = true;
    }
    if (changes.thinkingOption !== undefined) {
      this.thinkingOption = changes.thinkingOption ?? undefined;
      selectionChanged = true;
    }
    if (changes.providerOptions) {
      for (const [key, value] of Object.entries(changes.providerOptions)) {
        if (value === null) delete this.providerOptions[key];
        else this.providerOptions[key] = value;
      }
      selectionChanged = true;
    }
    if (changes.mode !== undefined) {
      const mode = changes.mode ?? DEFAULT_RUNTIME_MODE;
      if (!catalogModes(this.instances).some((candidate) => candidate.id === mode)) {
        throw new T3SessionError(`T3 has no permission mode ${mode}.`, "modeUnavailable");
      }
      this.runtimeMode = mode;
      if (this.threadId) {
        await this.options.environment.dispatch({
          type: "thread.runtime-mode.set",
          threadId: this.threadId,
          runtimeMode: mode,
        });
      }
    }
    if (selectionChanged && this.threadId) {
      await this.options.environment.dispatch({
        type: "thread.model-selection.set",
        threadId: this.threadId,
        modelSelection: this.selection(),
      });
    }
    this.publishConfig();
  }

  async answer(permissionId: string, response: ProviderPermissionResponse): Promise<void> {
    const request = this.permissions.get(permissionId);
    if (!request || !this.threadId) {
      throw new T3SessionError("This request is no longer waiting.", "unknownPermission");
    }
    const metadata = record(request.metadata);
    if (metadata.t3Kind === "secret") {
      await this.answerSecret(permissionId, request, response);
      return;
    }
    if (metadata.t3Kind === "question") {
      if (response.behavior === "deny") {
        await this.options.environment.dispatch({
          type: "thread.user-input.dismiss",
          threadId: this.threadId,
          requestId: permissionId,
        });
        return;
      }
      await this.options.environment.dispatch({
        type: "runtime-request.respond",
        threadId: this.threadId,
        requestId: permissionId,
        answers: this.questionAnswers(request, response.updatedInput),
      });
      return;
    }
    let decision = "accept";
    if (response.behavior === "deny") decision = "decline";
    else if (response.selectedActionId === "acceptForSession") decision = "acceptForSession";
    await this.options.environment.dispatch({
      type: "runtime-request.respond",
      threadId: this.threadId,
      requestId: permissionId,
      decision,
      ...(response.behavior === "deny" && response.message ? { feedback: response.message } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopReconnect();
    this.subscription?.cancel();
    this.subscription = undefined;
  }

  /** T3 owns the thread and its work; releasing Paseo's view of it stops nothing. */
  canStopRuntime(): boolean {
    return this.activeRun() === undefined && this.queuedRun() === undefined;
  }

  /**
   * Stores the images on the T3 server, as its web app does before sending, and returns the
   * attachments the message refers to. T3 accepts this before the thread exists.
   */
  private async uploadImages(
    threadId: string,
    messageId: string,
    images: T3ImageUpload[],
  ): Promise<unknown[]> {
    if (images.length === 0) return [];
    const result = record(
      await this.options.environment.request("assets.persistChatAttachments", {
        threadId,
        messageId,
        attachments: images,
      }),
    );
    return Array.isArray(result.attachments) ? result.attachments : [];
  }

  private async launch(messageId: string, body: string, images: T3ImageUpload[]): Promise<void> {
    if (!this.ref) throw new T3SessionError("No model is selected.", "modelUnavailable");
    const projectId = await this.options.environment.projectFor(this.config.cwd);
    const threadId = randomUUID();
    const attachments = await this.uploadImages(threadId, messageId, images);
    // Leaving `creationSource` out lets T3 record it the way its own apps do.
    const result = record(
      await this.options.environment.request("orchestration.launchThread", {
        commandId: randomUUID(),
        threadId,
        projectId,
        title: this.config.title?.trim() || body.trim().split("\n")[0].slice(0, 80) || "Image",
        generateTitle: !this.config.title,
        modelSelection: this.selection(),
        runtimeMode: this.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId, text: body, attachments },
      }),
    );
    this.threadId = text(result.threadId) ?? threadId;
    this.publishPersistence();
    // The launch result already holds the first run; the subscription carries it from there.
    this.applyProjection(result.projection, false);
    await this.subscribe(false);
  }

  private selection(): Record<string, unknown> {
    if (!this.ref) throw new T3SessionError("No model is selected.", "modelUnavailable");
    return modelSelection({
      ref: this.ref,
      model: findModel(this.instances, this.ref)?.model,
      thinkingOption: this.thinkingOption,
      providerOptions: this.providerOptions,
    });
  }

  private persistence(): ProviderPersistence | undefined {
    return this.threadId
      ? { version: PERSISTENCE_VERSION, data: { threadId: this.threadId } }
      : undefined;
  }

  private publishPersistence(): void {
    const persistence = this.persistence();
    if (persistence) {
      this.options.emit({ type: "session.persistence", sessionId: this.options.id, persistence });
    }
  }

  private publishConfig(): void {
    const model = this.ref ? findModel(this.instances, this.ref)?.model : undefined;
    const controls = optionControls(model);
    const providerOptions = Object.fromEntries(
      controls.flatMap((control) =>
        this.providerOptions[control.key] !== undefined
          ? [[control.key, this.providerOptions[control.key] as string | boolean]]
          : [],
      ),
    );
    const models = catalogModels(this.instances);
    this.options.emit({
      type: "session.config",
      sessionId: this.options.id,
      config: {
        ...(this.ref ? { model: modelId(this.ref) } : {}),
        mode: this.runtimeMode,
        ...(this.thinkingOption ? { thinkingOption: this.thinkingOption } : {}),
        models,
        modes: catalogModes(this.instances),
        thinkingOptions:
          models.find((entry) => this.ref && entry.id === modelId(this.ref))?.thinkingOptions ?? [],
        controls,
        providerOptions,
      },
    });
  }

  private async subscribe(replay: boolean): Promise<void> {
    const threadId = this.threadId;
    if (!threadId || this.closed) return;
    this.subscription?.cancel();
    const connection = await this.options.environment.connect();
    let synced!: () => void;
    const firstSnapshot = new Promise<void>((resolve) => {
      synced = resolve;
    });
    this.replaying = replay;
    const subscription = connection.stream(
      "orchestration.subscribeThread",
      {
        threadId,
        ...(this.lastSequence !== undefined ? { afterSequence: this.lastSequence } : {}),
      },
      (value) => {
        const item = record(value);
        if (item.kind === "snapshot") {
          if (typeof item.snapshotSequence === "number") this.lastSequence = item.snapshotSequence;
          this.applyProjection(item.projection, this.replaying);
          this.replaying = false;
          synced();
        } else if (item.kind === "event") {
          if (typeof item.sequence === "number") this.lastSequence = item.sequence;
          this.applyEvent(record(item.event));
        } else if (item.kind === "synchronized") {
          synced();
        }
      },
    );
    this.subscription = subscription;
    subscription.done.then(synced, (error: unknown) => {
      synced();
      if (!this.closed && this.subscription === subscription) {
        this.options.emit({
          type: "session.notice",
          sessionId: this.options.id,
          notice: {
            id: "t3-connection",
            severity: "warning",
            title: "Lost the connection to T3",
            description: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
    await firstSnapshot;
  }

  private resubscribe(): void {
    if (this.closed || !this.threadId) return;
    void this.subscribe(false).catch(() => {
      // The notice from the failed subscription already told the user.
    });
  }

  private applyProjection(value: unknown, replay: boolean): void {
    const projection = record(value);
    const runs = Array.isArray(projection.runs) ? projection.runs : [];
    const items = (Array.isArray(projection.turnItems) ? projection.turnItems : [])
      .flatMap((entry) => readTurnItem(entry) ?? [])
      .filter((item) => item.threadId === undefined || item.threadId === this.threadId)
      .sort((left, right) => Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0));
    const requests = Array.isArray(projection.runtimeRequests) ? projection.runtimeRequests : [];
    const attempts = Array.isArray(projection.attempts) ? projection.attempts : [];
    const providerTurns = Array.isArray(projection.providerTurns) ? projection.providerTurns : [];
    for (const attempt of attempts) this.onAttempt(record(attempt));
    for (const run of runs) this.noteActiveAttempt(record(run));
    // Usage goes in before the runs, so a run that ends here ends with its figure.
    for (const turn of providerTurns) this.onProviderTurn(record(turn), true);
    for (const run of runs) this.onRun(record(run), replay);
    for (const request of requests) this.onRequest(record(request));
    for (const item of items) this.onItem(item);
    // History only restores the latest figure, as a resumed agent's current usage.
    const latest = runs
      .map((run) => text(record(run).id))
      .findLast((id) => id && this.runUsage.has(id));
    if (latest) this.sendUsage(latest);
  }

  private applyEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case "run.created":
      case "run.updated":
        this.onRun(record(event.payload), false);
        return;
      case "turn-item.updated": {
        const item = readTurnItem(event.payload);
        if (item && (item.threadId === undefined || item.threadId === this.threadId))
          this.onItem(item);
        return;
      }
      case "runtime-request.updated":
        this.onRequest(record(event.payload));
        return;
      case "run-attempt.created":
      case "run-attempt.updated":
        this.onAttempt(record(event.payload));
        return;
      case "provider-turn.updated":
        this.onProviderTurn(record(event.payload), false);
        return;
      default:
        return;
    }
  }

  private onAttempt(attempt: Record<string, unknown>): void {
    const id = text(attempt.id);
    const runId = text(attempt.runId);
    if (!id || !runId) return;
    this.attemptRuns.set(id, runId);
    const orphan = this.orphanTurns.get(id);
    if (orphan) {
      this.orphanTurns.delete(id);
      this.onProviderTurn(orphan, false);
    }
  }

  private noteActiveAttempt(run: Record<string, unknown>): void {
    const id = text(run.id);
    const attemptId = text(run.activeAttemptId);
    if (id && attemptId && !this.attemptRuns.has(attemptId))
      this.onAttempt({ id: attemptId, runId: id });
  }

  /** `quiet` records the figure without sending it, as history does. */
  private onProviderTurn(turn: Record<string, unknown>, quiet: boolean): void {
    const attemptId = text(turn.runAttemptId);
    if (!attemptId) return;
    const runId = this.attemptRuns.get(attemptId);
    if (!runId) {
      this.orphanTurns.set(attemptId, turn);
      return;
    }
    const usage = usageFromProviderTurn(turn);
    if (!usage) return;
    const entry = this.runUsage.get(runId);
    // A retried or restarted attempt adds a provider turn; the run's figure is the latest one.
    this.runUsage.set(runId, { usage: { ...entry?.usage, ...usage }, sent: entry?.sent });
    if (!quiet) this.sendUsage(runId);
  }

  private sendUsage(runId: string): void {
    const entry = this.runUsage.get(runId);
    if (!entry) return;
    const key = JSON.stringify(entry.usage);
    if (entry.sent === key) return;
    entry.sent = key;
    this.options.emit({
      type: "session.usage",
      sessionId: this.options.id,
      turnId: runId,
      usage: entry.usage,
    });
  }

  private onRun(run: Record<string, unknown>, replay: boolean): void {
    const id = text(run.id);
    const status = text(run.status);
    if (!id || !status) return;
    if (run.threadId !== undefined && run.threadId !== this.threadId) return;
    this.noteActiveAttempt(run);
    let state = this.runs.get(id);
    if (!state) {
      state = { id, status, userMessageId: text(run.userMessageId), started: false, ended: false };
      this.runs.set(id, state);
      const clientMessageId = state.userMessageId
        ? this.clientMessageIds.get(state.userMessageId)
        : undefined;
      if (clientMessageId && !this.steerMessageIds.has(state.userMessageId ?? "")) {
        this.options.emit({
          type: "session.prompt_result",
          sessionId: this.options.id,
          clientMessageId,
          result: { type: "turn", turnId: id },
        });
      }
    }
    state.status = status;
    // History is history: replayed runs do not start or end turns now.
    if (replay) {
      state.started = true;
      state.ended = status in TERMINAL_RUN;
      return;
    }
    const terminal = TERMINAL_RUN[status];
    if ((ACTIVE_RUN.has(status) || terminal) && !state.started) {
      state.started = true;
      this.options.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: id,
        state: "started",
      });
    }
    if (terminal && !state.ended) {
      state.ended = true;
      // Paseo reads the agent's usage when the turn ends, so the figure goes first.
      this.sendUsage(id);
      this.options.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: id,
        state: terminal,
        ...(terminal === "failed"
          ? { error: { message: this.failureFor(id) ?? "Antigravity stopped with an error." } }
          : {}),
      });
    }
  }

  private failureFor(runId: string): string | undefined {
    for (const item of [...this.items.values()].toReversed()) {
      if (item.type === "error" && item.runId === runId) {
        return text(record(item.failure).message);
      }
    }
    return undefined;
  }

  private onRequest(value: Record<string, unknown>): void {
    const id = text(value.id);
    const kind = text(value.kind);
    const status = text(value.status);
    if (!id || !kind || !status) return;
    this.requests.set(id, { id, kind, status });
    if (status !== "pending") {
      this.resolvePermission(id);
      return;
    }
    for (const item of this.items.values()) {
      if (item.requestId === id) this.maybePermission(item);
    }
  }

  private onItem(item: T3TurnItem): void {
    this.items.set(item.id, item);
    if (
      item.type === "approval_request" ||
      item.type === "user_input_request" ||
      item.type === "secret_request"
    ) {
      this.maybePermission(item);
      return;
    }
    const mapped = mapTurnItem(item, this.clientMessageIds);
    if (!mapped) return;
    const serialized = JSON.stringify(mapped);
    if (this.published.get(item.id) === serialized) return;
    this.published.set(item.id, serialized);
    this.options.emit({
      type: "timeline.item",
      sessionId: this.options.id,
      item: mapped,
      ...(text(item.updatedAt) ? { timestamp: text(item.updatedAt) } : {}),
    });
  }

  private maybePermission(item: T3TurnItem): void {
    if (item.type === "secret_request") {
      const id = `secret:${item.id}`;
      if (item.secretStatus === "pending") this.publishPermission(id, secretPermission(id, item));
      else this.resolvePermission(id);
      return;
    }
    const requestId = text(item.requestId);
    if (!requestId) return;
    const request = this.requests.get(requestId);
    if (request && request.status !== "pending") return;
    if (item.status === "completed" || item.status === "cancelled") {
      this.resolvePermission(requestId);
      return;
    }
    this.publishPermission(
      requestId,
      item.type === "user_input_request"
        ? questionPermission(requestId, item)
        : approvalPermission(requestId, item),
    );
  }

  private publishPermission(id: string, request: ProviderPermissionRequest): void {
    const previous = this.permissions.get(id);
    if (previous && JSON.stringify(previous) === JSON.stringify(request)) return;
    this.permissions.set(id, request);
    this.options.emit({ type: "session.permission", sessionId: this.options.id, request });
  }

  private resolvePermission(id: string): void {
    if (!this.permissions.delete(id)) return;
    this.options.emit({
      type: "session.permission_resolved",
      sessionId: this.options.id,
      permissionId: id,
    });
  }

  private questionAnswers(
    request: ProviderPermissionRequest,
    updatedInput: Record<string, unknown> | undefined,
  ): Record<string, string | string[]> {
    const supplied = record(record(updatedInput).answers);
    const questions = Array.isArray(record(request.input).questions)
      ? (record(request.input).questions as Array<Record<string, unknown>>)
      : [];
    const answers: Record<string, string | string[]> = {};
    for (const question of questions) {
      const id = text(question.id);
      const header = text(question.header);
      const value = (header && supplied[header]) ?? (id && supplied[id]);
      if (!id || typeof value !== "string") continue;
      answers[id] =
        question.multiSelect === true
          ? value
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean)
          : value;
    }
    return answers;
  }

  private async answerSecret(
    permissionId: string,
    request: ProviderPermissionRequest,
    response: ProviderPermissionResponse,
  ): Promise<void> {
    const itemId = text(record(request.metadata).t3ItemId);
    if (!itemId || !this.threadId) return;
    if (response.behavior === "deny") {
      await this.options.environment.request("secrets.answerRequest", {
        threadId: this.threadId,
        turnItemId: itemId,
        answer: { type: "decline" },
      });
      return;
    }
    const answers = this.questionAnswers(request, response.updatedInput);
    const fields = (record(request.metadata).t3Fields as string[] | undefined) ?? [];
    const answer =
      fields.length > 0
        ? {
            type: "save",
            values: Object.fromEntries(
              fields.map((field) => [field, String(answers[field] ?? "")]),
            ),
          }
        : { type: "save", secret: String(answers.secret ?? "") };
    await this.options.environment.request("secrets.answerRequest", {
      threadId: this.threadId,
      turnItemId: itemId,
      answer,
    });
    this.resolvePermission(permissionId);
  }

  private activeRun(): RunState | undefined {
    return [...this.runs.values()].find((run) => ACTIVE_RUN.has(run.status));
  }

  private queuedRun(): RunState | undefined {
    return [...this.runs.values()].find(
      (run) => run.status === "queued" || run.status === "preparing",
    );
  }
}

function approvalPermission(id: string, item: T3TurnItem): ProviderPermissionRequest {
  const kind = text(item.requestKind) ?? "tool";
  const prompt = text(item.prompt);
  const reason = text(item.reason);
  return {
    id,
    name: kind,
    kind: "tool",
    title: text(item.title) ?? prompt ?? `Antigravity asks to run a ${kind} action`,
    ...(reason || prompt ? { description: [prompt, reason].filter(Boolean).join("\n\n") } : {}),
    ...(prompt && kind === "command" ? { detail: { type: "shell", command: prompt } } : {}),
    actions: [
      { id: "accept", label: "Allow once", behavior: "allow", variant: "primary" },
      {
        id: "acceptForSession",
        label: "Allow for this chat",
        behavior: "allow",
        variant: "secondary",
      },
      { id: "decline", label: "Deny", behavior: "deny", variant: "danger" },
    ],
    metadata: { t3Kind: "approval", t3ItemId: item.id },
  };
}

function questionPermission(id: string, item: T3TurnItem): ProviderPermissionRequest {
  const questions = (Array.isArray(item.questions) ? item.questions : []).map((value) => {
    const question = record(value);
    const options = (Array.isArray(question.options) ? question.options : []).map((option) => ({
      label: text(record(option).label) ?? "",
      description: text(record(option).description) ?? "",
    }));
    return {
      id: text(question.id) ?? "",
      header: text(question.header) ?? text(question.id) ?? "",
      question: text(question.question) ?? "",
      options,
      multiSelect: question.multiSelect === true,
      allowOther: question.allowCustomAnswer !== false,
      allowEmpty: question.required === false,
    };
  });
  return {
    id,
    name: "user_input",
    kind: "question",
    title: text(item.title) ?? "Antigravity has a question",
    input: { questions },
    metadata: { t3Kind: "question", t3ItemId: item.id },
  };
}

function secretPermission(id: string, item: T3TurnItem): ProviderPermissionRequest {
  const fields = (Array.isArray(item.fields) ? item.fields : []).map(record);
  const label = text(item.label) ?? "Secret";
  const questions =
    fields.length > 0
      ? fields.map((field) => ({
          id: text(field.name) ?? "",
          header: text(field.name) ?? "",
          question: text(field.label) ?? text(field.name) ?? "",
          options: [],
          multiSelect: false,
          allowOther: true,
          allowEmpty: false,
        }))
      : [
          {
            id: "secret",
            header: "secret",
            question: label,
            options: [],
            multiSelect: false,
            allowOther: true,
            allowEmpty: false,
          },
        ];
  return {
    id,
    name: "secret_request",
    kind: "question",
    title: `Antigravity asks for ${label}`,
    description: [text(item.reason), text(item.url)].filter(Boolean).join("\n\n"),
    input: { questions },
    metadata: {
      t3Kind: "secret",
      t3ItemId: item.id,
      t3Fields: fields.flatMap((field) => text(field.name) ?? []),
    },
  };
}
