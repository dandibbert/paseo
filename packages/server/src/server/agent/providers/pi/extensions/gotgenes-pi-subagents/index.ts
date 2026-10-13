import { z } from "zod";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import { outputFileFromToolResult } from "../child-session.js";
import { GOTGENES_CHILD_SESSION_MARKER, gotgenesRuntimeBridge } from "./runtime-bridge.js";
import type { PiExtension, PiExtensionToolCall } from "../contract.js";

const SpawnArgs = z
  .object({
    subagent_type: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    description: z.string().optional(),
    resume: z.string().trim().min(1).optional(),
  })
  .passthrough();
const FollowupArgs = z.object({ agent_id: z.string().trim().min(1) }).passthrough();
const Details = z
  .object({
    agentId: z.string().trim().min(1),
    status: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    transcriptPath: z.string().trim().min(1).optional(),
  })
  .passthrough();
const Notification = z
  .object({
    id: z.string().trim().min(1),
    status: z.string().optional(),
    description: z.string().optional(),
    outputFile: z.string().trim().min(1).optional(),
  })
  .passthrough();
const LiveSession = z.object({
  agentId: z.string().trim().min(1),
  file: z.string().trim().min(1),
});
const status = (value: string): "running" | "completed" | "failed" | "canceled" => {
  // `steered` is terminal: the agent wrapped up after reaching its turn limit.
  if (value === "completed" || value === "steered") return "completed";
  if (value === "error") return "failed";
  if (value === "aborted" || value === "stopped") return "canceled";
  return "running";
};

/**
 * get_subagent_result returns only `formatAgentReport` text, with no details:
 * `Agent: <id>\nType: <name> | Status: <status> ...`, ending with
 * `Full transcript available at: <path>` when the record has one.
 */
const parseAgentReport = (text: string | undefined) => {
  const match = text?.match(/^Agent: (\S+)\nType: .*?\| Status: (\w+)/);
  if (!match) return undefined;
  const transcriptPath = text?.match(/\n\nFull transcript available at: (.+)$/)?.[1]?.trim();
  return { agentId: match[1]!, status: match[2]!, transcriptPath: transcriptPath || undefined };
};

export const gotgenesPiSubagents: PiExtension = {
  id: "@gotgenes/pi-subagents",
  runtimeBridge: gotgenesRuntimeBridge,
  createSession: () => {
    const callsByAgent = new Map<string, string>();
    const readSessions = new Set<string>();
    const pendingFilesByAgent = new Map<string, string>();
    const childSession = (id: string, file: string | undefined) => {
      if (!file || readSessions.has(file)) return [];
      readSessions.add(file);
      return [{ id, file }];
    };
    const mapSpawn = (call: PiExtensionToolCall) => {
      const args = SpawnArgs.safeParse(call.args);
      if (!args.success) return undefined;
      const details = Details.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      const title = args.data.subagent_type;
      const description = args.data.description ?? args.data.prompt;
      const detail = {
        type: "sub_agent" as const,
        subAgentType: title,
        description,
        log: extractTextFromToolResult(call.result)?.trim() ?? "",
      };
      // A resume continues the same agent, so it updates that agent's card instead of opening one
      // keyed by its own call ID. Remapping the agent would strand the original card at running.
      const resumedId = args.data.resume ? callsByAgent.get(args.data.resume) : undefined;
      if (resumedId) {
        if (call.status === "running")
          return {
            detail,
            subagents: [{ type: "upsert" as const, id: resumedId, status: "running" as const }],
          };
        let resumedStatus: ReturnType<typeof status> | undefined;
        if (details.success) resumedStatus = status(details.data.status);
        else if (call.status === "failed") resumedStatus = "failed";
        return resumedStatus
          ? {
              detail,
              subagents: [{ type: "upsert" as const, id: resumedId, status: resumedStatus }],
            }
          : { detail };
      }
      if (call.status === "running")
        return {
          detail,
          subagents: [
            {
              type: "upsert" as const,
              id: call.callId,
              title,
              description,
              toolCallId: call.callId,
              status: "running" as const,
            },
          ],
        };
      if (!details.success)
        return call.status === "failed"
          ? {
              detail,
              subagents: [{ type: "upsert" as const, id: call.callId, status: "failed" as const }],
            }
          : { detail };
      callsByAgent.set(details.data.agentId, call.callId);
      const file =
        outputFileFromToolResult(call.result) ?? pendingFilesByAgent.get(details.data.agentId);
      pendingFilesByAgent.delete(details.data.agentId);
      const childSessions = childSession(call.callId, file);
      return {
        detail,
        subagents: [
          {
            type: "upsert" as const,
            id: call.callId,
            title,
            description,
            toolCallId: call.callId,
            status: status(details.data.status),
          },
        ],
        childSessions,
      };
    };
    const mapFollowup = (call: PiExtensionToolCall) => {
      const args = FollowupArgs.safeParse(call.args);
      if (!args.success) return undefined;
      const id = callsByAgent.get(args.data.agent_id);
      if (!id) return undefined;
      const details = Details.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      const log = extractTextFromToolResult(call.result)?.trim() ?? "";
      const detail = {
        type: "sub_agent" as const,
        description: details.success ? details.data.description : undefined,
        log,
      };
      if (call.status === "running") return { detail };
      let report: { agentId: string; status: string; transcriptPath?: string } | undefined;
      if (details.success) report = details.data;
      else if (call.toolName === "get_subagent_result") report = parseAgentReport(log);
      if (!report || report.agentId !== args.data.agent_id) return { detail };
      const childSessions = childSession(id, report.transcriptPath);
      return {
        detail,
        subagents: [{ type: "upsert" as const, id, status: status(report.status) }],
        childSessions,
      };
    };
    return {
      mapToolCall(call) {
        // This fork's result details resemble tintinweb's, but its spawn tool is `subagent` and its
        // follow-up result shape differs. Keep each parser at its own package boundary.
        if (call.toolName === "subagent") return mapSpawn(call);
        if (call.toolName === "get_subagent_result" || call.toolName === "steer_subagent")
          return mapFollowup(call);
        return undefined;
      },
      mapCustomMessage(message) {
        if (
          message.customType !== "subagent-notification" &&
          message.customType !== "subagent-update"
        )
          return undefined;
        const details = Notification.safeParse(message.details);
        if (!details.success) return undefined;
        const id = callsByAgent.get(details.data.id);
        if (!id) return undefined;
        const file = details.data.outputFile;
        const childSessions = childSession(id, file);
        return {
          subagents: [
            {
              type: "upsert",
              id,
              description: details.data.description,
              status: details.data.status ? status(details.data.status) : "running",
            },
          ],
          childSessions,
        };
      },
      mapRuntimeNotification(message) {
        const prefix = `${GOTGENES_CHILD_SESSION_MARKER} `;
        if (!message.startsWith(prefix)) return undefined;
        let raw: unknown;
        try {
          raw = JSON.parse(message.slice(prefix.length));
        } catch {
          return { subagents: [] };
        }
        const parsed = LiveSession.safeParse(raw);
        if (!parsed.success) return { subagents: [] };
        const { agentId, file } = parsed.data;
        const id = callsByAgent.get(agentId);
        if (!id) {
          pendingFilesByAgent.set(agentId, file);
          return { subagents: [] };
        }
        return {
          subagents: [{ type: "upsert", id, status: "running" }],
          childSessions: childSession(id, file),
        };
      },
    };
  },
};
