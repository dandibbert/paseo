import { z } from "zod";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import { outputFileFromToolResult } from "../child-session.js";
import {
  GOTGENES_CHILD_SESSION_MARKER,
  GOTGENES_LIFECYCLE_MARKER,
  GOTGENES_RECORD_ENTRY,
  gotgenesRuntimeBridge,
} from "./runtime-bridge.js";
import type { ProviderSubagentStatus } from "../../../../provider-subagents/store.js";
import type { PiExtension, PiExtensionCustomMapping, PiExtensionToolCall } from "../contract.js";

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
/** One run's state change, from the runtime bridge live or a `subagents:record` entry on replay. */
const RunEvent = z.object({
  agentId: z.string().trim().min(1),
  status: z.string(),
  startedAt: z.number(),
});
const RecordEntry = z
  .object({ id: z.string().trim().min(1), status: z.string(), startedAt: z.number() })
  .passthrough();
const status = (value: string): ProviderSubagentStatus => {
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

type RunEvent = z.infer<typeof RunEvent>;

interface Run {
  status: ProviderSubagentStatus;
  /** The gotgenes record's startedAt for this run, once a lifecycle event has reported it. */
  startedAt?: number;
  /** startedAt of the run a resume replaced. Events at or before it are late. */
  floor?: number;
  /** The run a resume replaced, restored if gotgenes refuses the resume. */
  resumedFrom?: Run;
}

/** A bridge marker's JSON payload (null when malformed), or undefined for any other message. */
function readMarker(message: string, marker: string): { payload: unknown } | undefined {
  const prefix = `${marker} `;
  if (!message.startsWith(prefix)) return undefined;
  try {
    return { payload: JSON.parse(message.slice(prefix.length)) };
  } catch {
    return { payload: null };
  }
}

export const gotgenesPiSubagents: PiExtension = {
  id: "@gotgenes/pi-subagents",
  runtimeBridge: gotgenesRuntimeBridge,
  historyEntries: { [GOTGENES_RECORD_ENTRY]: ["id", "status", "startedAt"] },
  createSession: () => {
    const callsByAgent = new Map<string, string>();
    const readSessions = new Set<string>();
    const pendingFilesByAgent = new Map<string, string>();
    const pendingRunsByAgent = new Map<string, RunEvent>();
    const runs = new Map<string, Run>();
    /**
     * The one place a card's status changes. Returns the status to publish, or undefined when the
     * update is stale and the stored status must stand.
     */
    const transition = (id: string, next: ProviderSubagentStatus, startedAt?: number) => {
      const run = runs.get(id);
      if (run && startedAt !== undefined) {
        // gotgenes resets startedAt on resume, so an older value belongs to an earlier run.
        if (run.floor !== undefined && startedAt <= run.floor) return undefined;
        if (run.startedAt !== undefined && startedAt < run.startedAt) return undefined;
      }
      // A finished run only reopens through a resume, or a run proven newer by its startedAt.
      const newer =
        startedAt !== undefined && run?.startedAt !== undefined && startedAt > run.startedAt;
      if (run && run.status !== "running" && next === "running" && !newer) return undefined;
      runs.set(id, {
        status: next,
        startedAt: startedAt ?? run?.startedAt,
        floor: run?.floor,
        resumedFrom: next === "running" ? run?.resumedFrom : undefined,
      });
      return next;
    };
    const applyRun = (event: RunEvent): PiExtensionCustomMapping => {
      const id = callsByAgent.get(event.agentId);
      if (!id) {
        const pending = pendingRunsByAgent.get(event.agentId);
        if (!pending || pending.startedAt <= event.startedAt)
          pendingRunsByAgent.set(event.agentId, event);
        return { subagents: [] };
      }
      const next = transition(id, status(event.status), event.startedAt);
      return { subagents: next ? [{ type: "upsert", id, status: next }] : [] };
    };
    const childSession = (id: string, file: string | undefined) => {
      if (!file || readSessions.has(file)) return [];
      readSessions.add(file);
      return [{ id, file }];
    };
    /** A resume continues an agent that already has a card, so it reopens that card. */
    const mapResume = (
      id: string,
      call: PiExtensionToolCall,
      details: z.infer<typeof Details> | undefined,
    ) => {
      const run = runs.get(id);
      if (call.status === "running") {
        // A resume opens a new run. Anything stamped with an earlier startedAt is now stale.
        if (run && run.status !== "running")
          runs.set(id, { status: "running", floor: run.startedAt ?? run.floor, resumedFrom: run });
        return { subagents: [{ type: "upsert" as const, id, status: "running" as const }] };
      }
      let next: ProviderSubagentStatus | undefined;
      if (details) next = transition(id, status(details.status));
      else if (call.status === "failed") next = transition(id, "failed");
      else if (run?.resumedFrom && run.startedAt === undefined) {
        // gotgenes refused the resume (unknown or released agent), so the prior run stands.
        runs.set(id, run.resumedFrom);
        next = run.resumedFrom.status;
      }
      return next ? { subagents: [{ type: "upsert" as const, id, status: next }] } : {};
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
        // COMPAT(subagent-log): remove after 2027-04-30.
        log: "",
      };
      // A resume continues the same agent, so it updates that agent's card instead of opening one
      // keyed by its own call ID. Remapping the agent would strand the original card at running.
      const resumedId = args.data.resume ? callsByAgent.get(args.data.resume) : undefined;
      if (resumedId) return { detail, ...mapResume(resumedId, call, details.data) };
      if (call.status === "running") {
        runs.set(call.callId, { status: "running" });
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
      }
      if (!details.success) {
        if (call.status === "failed") {
          const failed = transition(call.callId, "failed");
          return failed
            ? { detail, subagents: [{ type: "upsert" as const, id: call.callId, status: failed }] }
            : { detail };
        }
        // gotgenes refused the spawn, so no agent started: drop the running row.
        runs.delete(call.callId);
        return { detail, subagents: [{ type: "remove" as const, id: call.callId }] };
      }
      callsByAgent.set(details.data.agentId, call.callId);
      transition(call.callId, status(details.data.status));
      // A foreground run, or a bridge event that beat the result, settles before the card is keyed.
      const pendingRun = pendingRunsByAgent.get(details.data.agentId);
      pendingRunsByAgent.delete(details.data.agentId);
      if (pendingRun) transition(call.callId, status(pendingRun.status), pendingRun.startedAt);
      const file =
        outputFileFromToolResult(call.result) ?? pendingFilesByAgent.get(details.data.agentId);
      pendingFilesByAgent.delete(details.data.agentId);
      const childSessions = childSession(call.callId, file);
      const childStatus = runs.get(call.callId)!.status;
      // Without a session file, as on replay, the child's answer is the tool result.
      const answer =
        !file && childStatus !== "running" ? extractTextFromToolResult(call.result)?.trim() : "";
      return {
        detail,
        subagents: [
          {
            type: "upsert" as const,
            id: call.callId,
            title,
            description,
            toolCallId: call.callId,
            status: childStatus,
          },
          ...(answer
            ? [
                {
                  type: "timeline" as const,
                  id: call.callId,
                  item: { type: "assistant_message" as const, text: answer },
                },
              ]
            : []),
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
        // COMPAT(subagent-log): remove after 2027-04-30.
        log: "",
      };
      if (call.status === "running") return { detail };
      let report: { agentId: string; status: string; transcriptPath?: string } | undefined;
      if (details.success) report = details.data;
      else if (call.toolName === "get_subagent_result") report = parseAgentReport(log);
      if (!report || report.agentId !== args.data.agent_id) return { detail };
      const childSessions = childSession(id, report.transcriptPath);
      // A follow-up reads a snapshot, which a completion may already have overtaken.
      const next = transition(id, status(report.status));
      return {
        detail,
        subagents: next ? [{ type: "upsert" as const, id, status: next }] : [],
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
        // An update without a status is a progress note from a running child, not a state change.
        const next = details.data.status ? transition(id, status(details.data.status)) : undefined;
        return {
          subagents: [
            {
              type: "upsert",
              id,
              description: details.data.description,
              ...(next ? { status: next } : {}),
            },
          ],
          childSessions,
        };
      },
      mapRuntimeNotification(message) {
        const lifecycle = readMarker(message, GOTGENES_LIFECYCLE_MARKER);
        if (lifecycle) {
          const run = RunEvent.safeParse(lifecycle.payload);
          return run.success ? applyRun(run.data) : { subagents: [] };
        }
        const marker = readMarker(message, GOTGENES_CHILD_SESSION_MARKER);
        if (!marker) return undefined;
        const live = LiveSession.safeParse(marker.payload);
        if (!live.success) return { subagents: [] };
        const { agentId, file } = live.data;
        const id = callsByAgent.get(agentId);
        if (!id) {
          pendingFilesByAgent.set(agentId, file);
          return { subagents: [] };
        }
        // The child's file says where to read, not whether the run is still going.
        return { subagents: [], childSessions: childSession(id, file) };
      },
      mapCustomEntry(entry) {
        if (entry.customType !== GOTGENES_RECORD_ENTRY) return undefined;
        const record = RecordEntry.safeParse(entry.data);
        if (!record.success) return { subagents: [] };
        return applyRun({
          agentId: record.data.id,
          status: record.data.status,
          startedAt: record.data.startedAt,
        });
      },
    };
  },
};
