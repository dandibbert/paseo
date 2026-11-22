import { z } from "zod";

export const RunIdentitySchema = z.object({
  daemonInstanceId: z.string().min(1),
  runToken: z.string().min(1),
});
export type RunIdentity = z.infer<typeof RunIdentitySchema>;

export const FenceStateSchema = z.enum(["pending", "settled", "aborted_by_restart"]);
export type FenceState = z.infer<typeof FenceStateSchema>;

export const OriginTurnFenceSchema = z.object({
  fenceId: z.string().regex(/^[a-f0-9]{64}$/),
  origin: RunIdentitySchema,
  state: FenceStateSchema,
  createdAt: z.string().min(1),
  settledAt: z.string().optional(),
  abortedAt: z.string().optional(),
});
export type OriginTurnFence = z.infer<typeof OriginTurnFenceSchema>;

export const LeaseStateSchema = z.enum([
  "waiting_trigger",
  "pending_delivery",
  "dispatch_reserved",
  "resumed_running",
  "settled",
  "covered",
  "canceled",
  "blocked",
]);
export type LeaseState = z.infer<typeof LeaseStateSchema>;

export const LeaseBlockedReasonSchema = z.enum([
  "wake_turn_aborted_by_daemon_restart",
  "interrupted_by_user_stop",
  "human_takeover_required",
  "dispatch_uncertain",
  "provider_unrecoverable",
  "autonomous_budget_exceeded",
  "authorization_revoked",
  "task_unknown",
  "internal_error",
]);
export type LeaseBlockedReason = z.infer<typeof LeaseBlockedReasonSchema>;

/**
 * Reasons that MUST NEVER trigger automatic fallback reactivation (Spec v0.4.1 guardrail #1).
 */
export const NON_REACTIVATABLE_BLOCK_REASONS: ReadonlySet<LeaseBlockedReason> = new Set([
  "interrupted_by_user_stop",
  "autonomous_budget_exceeded",
  "authorization_revoked",
]);

/**
 * ContinuationLease stores ONLY an immutable `creatorFenceId` reference.
 * Mutable FenceState is strictly forbidden here (Spec v0.4.1 guardrail #2).
 */
export const ContinuationLeaseSchema = z
  .object({
    leaseId: z.string().min(1),
    continuationId: z.string().min(1),
    kind: z.enum(["managed-command", "one-shot"]),
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    creatorFenceId: z.string().regex(/^[a-f0-9]{64}$/),
    state: LeaseStateSchema,
    eventId: z.string().optional(),
    dispatchBatchId: z.string().optional(),
    wakeRun: RunIdentitySchema.optional(),
    blockedReason: LeaseBlockedReasonSchema.optional(),
    takeoverByHuman: z.boolean().optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type ContinuationLease = z.infer<typeof ContinuationLeaseSchema>;

export const WakeOriginSchema = z.enum(["managed-command", "one-shot", "recovery-diagnostic"]);
export type WakeOrigin = z.infer<typeof WakeOriginSchema>;

export const WakeEventStateSchema = z.enum([
  "pending",
  "batched",
  "dispatching",
  "accepted",
  "uncertain",
  "blocked",
  "canceled",
]);
export type WakeEventState = z.infer<typeof WakeEventStateSchema>;

export const WakeEventSchema = z.object({
  eventId: z.string().min(1),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  origin: WakeOriginSchema,
  payloadRef: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  state: WakeEventStateSchema,
  batchId: z.string().optional(),
  attempts: z.number().int().min(0),
  lastError: z.string().optional(),
  readOnlyDiagnostic: z.boolean().optional(),
  sourceTaskId: z.string().optional(),
  sourceWakeId: z.string().optional(),
});
export type WakeEvent = z.infer<typeof WakeEventSchema>;

export const DispatchBatchStateSchema = z.enum([
  "frozen",
  "dispatching",
  "accepted",
  "uncertain",
  "blocked",
]);
export type DispatchBatchState = z.infer<typeof DispatchBatchStateSchema>;

export const DispatchBatchSchema = z.object({
  batchId: z.string().min(1),
  batchMessageId: z.string().min(1),
  agentId: z.string().min(1),
  eventIds: z.array(z.string().min(1)).min(1),
  promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  state: DispatchBatchStateSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  dispatchDaemonInstanceId: z.string().optional(),
  dispatchAttemptId: z.string().optional(),
  providerReceiptId: z.string().optional(),
});
export type DispatchBatch = z.infer<typeof DispatchBatchSchema>;

export const FallbackCoverageStateSchema = z.enum([
  "armed",
  "suspended_by_primary",
  "covered",
  "reactivated",
  "canceled",
  "blocked",
]);
export type FallbackCoverageState = z.infer<typeof FallbackCoverageStateSchema>;

export const OneShotWakeupStateSchema = z.enum([
  "scheduled",
  "due",
  "outbox",
  "covered",
  "canceled",
  "blocked",
]);
export type OneShotWakeupState = z.infer<typeof OneShotWakeupStateSchema>;

export const OneShotWakeupSchema = z.object({
  wakeId: z.string().min(1),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().optional(),
  prompt: z.string().min(1),
  scheduledAt: z.string().min(1),
  dueAt: z.string().min(1),
  state: OneShotWakeupStateSchema,
  fallbackForTaskId: z.string().optional(),
  primaryEventId: z.string().optional(),
  coverageState: FallbackCoverageStateSchema.optional(),
  terminalReason: z.string().optional(),
  leaseId: z.string().optional(),
  eventId: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OneShotWakeup = z.infer<typeof OneShotWakeupSchema>;

export type SendLaterResult =
  | {
      status: "scheduled";
      wakeId: string;
      scheduledAt: string;
      dueAt: string;
      clamped?: boolean;
    }
  | {
      status: "skipped_covered_by_task_event";
      coveredByEventId: string;
    };

export type CancelWakeupReason =
  | "not_found"
  | "already_covered"
  | "already_settled"
  | "already_accepted"
  | "dispatch_uncertain";

export type CancelWakeupResult =
  | { canceled: true; wakeId: string }
  | { canceled: false; wakeId: string; reason: CancelWakeupReason };

export const AuditEntrySchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  kind: z.enum([
    "blocked",
    "user_stop",
    "takeover_started",
    "takeover_settled",
    "needs_attention_cleared",
    "budget_exceeded",
    "authorization_revoked",
    "restart_aborted",
  ]),
  reason: z.string().optional(),
  leaseId: z.string().optional(),
  batchId: z.string().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AgentAccountingSchema = z.object({
  agentId: z.string().min(1),
  consecutiveAutonomousTurns: z.number().int().min(0),
  autonomousTurnBudget: z.number().int().min(1),
  lastHumanResetAt: z.string().optional(),
  lastResetCredential: z.string().optional(),
  continuationRevision: z.number().int().min(0),
  auditHistory: z.array(AuditEntrySchema),
  updatedAt: z.string().min(1),
});
export type AgentAccounting = z.infer<typeof AgentAccountingSchema>;

export type ContinuationProjectionState = "none" | "waiting" | "processing" | "needs_attention";

export interface AgentContinuationSummary {
  pendingContinuationsCount: number;
  continuationState: ContinuationProjectionState;
  continuationBlockedError: string | null;
  continuationRevision: number;
}

export interface ContinuationCheckpointEvent {
  type: "continuation_checkpoint";
  agentId: string;
  revision: number;
  summary: AgentContinuationSummary;
  reason: string;
  emittedAt: string;
}

export type ManagedTaskStatus =
  | "accepted"
  | "starting"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "canceled"
  | "spawn_failed"
  | "unknown";

export type DerivedTaskWakeState =
  | "not_required"
  | "waiting"
  | "pending"
  | "batched"
  | "dispatching"
  | "accepted"
  | "uncertain"
  | "blocked"
  | "canceled";

export type DispatchReceiptOutcome =
  | { status: "not_submitted" }
  | { status: "accepted"; providerReceiptId?: string }
  | { status: "uncertain"; detail?: string };

export const TombstoneRecordSchema = z.object({
  kind: z.enum(["lease", "batch", "event", "wakeup"]),
  recordId: z.string().min(1),
  agentId: z.string().min(1),
  state: z.string().min(1),
  blockedReason: LeaseBlockedReasonSchema.optional(),
  retainedReason: z.enum(["unresolved_blocked", "unresolved_uncertain"]),
  originalUpdatedAt: z.string().min(1),
  recordedAt: z.string().min(1),
});
export type TombstoneRecord = z.infer<typeof TombstoneRecordSchema>;

export interface CorruptRecordReport {
  filePath: string;
  error: string;
}

export interface StartupReconcileReport {
  daemonInstanceId: string;
  abortedFenceIds: string[];
  blockedLeaseIds: string[];
  retriedBatchIds: string[];
  acceptedBatchIds: string[];
  uncertainBatchIds: string[];
  checkpointAgents: string[];
  corruptRecords: CorruptRecordReport[];
}

export interface GcReport {
  deletedFences: string[];
  deletedLeases: string[];
  deletedEvents: string[];
  deletedBatches: string[];
  deletedWakeups: string[];
  retainedUnresolvedIds: string[];
  tombstonesWritten: string[];
  corruptRecords: CorruptRecordReport[];
}
