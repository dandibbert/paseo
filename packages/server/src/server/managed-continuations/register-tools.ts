import { z } from "zod";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import {
  MANAGED_CONTINUATION_TOOL_DESCRIPTIONS,
  type ManagedContinuationToolsService,
  type ManagedToolCallerContext,
} from "./tools-service.js";

export type ManagedToolRegistrar = (
  name: string,
  config: PaseoToolConfig,
  handler: (
    input: Record<string, unknown>,
    context: PaseoToolExecutionContext,
  ) => Promise<PaseoToolResult>,
) => void;

export interface RegisterManagedContinuationToolsOptions {
  registerTool: ManagedToolRegistrar;
  toolsService: ManagedContinuationToolsService;
  resolveCallerContext: () => Promise<ManagedToolCallerContext>;
}

function jsonResult(value: unknown): PaseoToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(error: unknown): PaseoToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "MANAGED_CONTINUATION_ERROR";
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { code, message },
  };
}

async function runToolSafely<T>(
  resolveCallerContext: () => Promise<ManagedToolCallerContext>,
  action: (caller: ManagedToolCallerContext) => Promise<T>,
): Promise<PaseoToolResult> {
  try {
    const caller = await resolveCallerContext();
    return jsonResult(await action(caller));
  } catch (error) {
    return errorResult(error);
  }
}

const RunBackgroundCommandSchema = z.object({
  command: z.string().min(1),
  name: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  timeoutSeconds: z.number().int().optional(),
  notifyOnExit: z.boolean().optional(),
  completionContext: z.string().optional(),
});

const TaskIdOnlySchema = z.object({
  taskId: z.string().min(1),
});

const ReadBackgroundOutputSchema = z.object({
  taskId: z.string().min(1),
  stream: z.enum(["stdout", "stderr"]),
  cursor: z.string().optional(),
  tailBytes: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().optional(),
});

const SendLaterSchema = z.object({
  prompt: z.string().min(1),
  afterSeconds: z.number().int().optional(),
  afterMinutes: z.number().int().optional(),
  at: z.string().optional(),
  name: z.string().min(1).optional(),
  fallbackForTaskId: z.string().min(1).optional(),
});

const WakeIdOnlySchema = z.object({
  wakeId: z.string().min(1),
});

const EmptyInputSchema = z.object({});

/**
 * Registers all 8 Paseo Managed Continuations Agent Tools into a `PaseoToolCatalog` registrar.
 */
export function registerManagedContinuationTools(
  options: RegisterManagedContinuationToolsOptions,
): void {
  const { registerTool, toolsService, resolveCallerContext } = options;

  registerTool(
    "run_background_command",
    {
      description: MANAGED_CONTINUATION_TOOL_DESCRIPTIONS.run_background_command,
      inputSchema: RunBackgroundCommandSchema,
    },
    (raw) => {
      const input = RunBackgroundCommandSchema.parse(raw);
      return runToolSafely(resolveCallerContext, (caller) =>
        toolsService.runBackgroundCommand(caller, input),
      );
    },
  );

  registerTool(
    "get_background_command",
    {
      description: MANAGED_CONTINUATION_TOOL_DESCRIPTIONS.get_background_command,
      inputSchema: TaskIdOnlySchema,
    },
    (raw) => {
      const { taskId } = TaskIdOnlySchema.parse(raw);
      return runToolSafely(resolveCallerContext, (caller) =>
        toolsService.getBackgroundCommand(caller, taskId),
      );
    },
  );

  registerTool(
    "list_background_commands",
    {
      description: MANAGED_CONTINUATION_TOOL_DESCRIPTIONS.list_background_commands,
      inputSchema: EmptyInputSchema,
    },
    () =>
      runToolSafely(resolveCallerContext, (caller) => toolsService.listBackgroundCommands(caller)),
  );

  registerTool(
    "read_background_command_output",
    {
      description: MANAGED_CONTINUATION_TOOL_DESCRIPTIONS.read_background_command_output,
      inputSchema: ReadBackgroundOutputSchema,
    },
    (raw) => {
      const input = ReadBackgroundOutputSchema.parse(raw);
      return runToolSafely(resolveCallerContext, (caller) =>
        toolsService.readBackgroundCommandOutput(caller, input),
      );
    },
  );

  registerTool(
    "cancel_background_command",
    {
      description: MANAGED_CONTINUATION_TOOL_DESCRIPTIONS.cancel_background_command,
      inputSchema: TaskIdOnlySchema,
    },
    (raw) => {
      const { taskId } = TaskIdOnlySchema.parse(raw);
      return runToolSafely(resolveCallerContext, (caller) =>
        toolsService.cancelBackgroundCommand(caller, taskId),
      );
    },
  );

  registerTool(
    "send_later",
    {
      description: MANAGED_CONTINUATION_TOOL_DESCRIPTIONS.send_later,
      inputSchema: SendLaterSchema,
    },
    (raw) => {
      const input = SendLaterSchema.parse(raw);
      return runToolSafely(resolveCallerContext, (caller) => toolsService.sendLater(caller, input));
    },
  );

  registerTool(
    "list_scheduled_wakeups",
    {
      description: MANAGED_CONTINUATION_TOOL_DESCRIPTIONS.list_scheduled_wakeups,
      inputSchema: EmptyInputSchema,
    },
    () =>
      runToolSafely(resolveCallerContext, (caller) => toolsService.listScheduledWakeups(caller)),
  );

  registerTool(
    "cancel_scheduled_wakeup",
    {
      description: MANAGED_CONTINUATION_TOOL_DESCRIPTIONS.cancel_scheduled_wakeup,
      inputSchema: WakeIdOnlySchema,
    },
    (raw) => {
      const { wakeId } = WakeIdOnlySchema.parse(raw);
      return runToolSafely(resolveCallerContext, (caller) =>
        toolsService.cancelScheduledWakeup(caller, wakeId),
      );
    },
  );
}
