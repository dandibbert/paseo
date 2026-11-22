import type { RunIdentity } from "./types.js";

export type ManagedWakeRejectionStatus =
  | "busy"
  | "starting"
  | "compacting"
  | "permission_pending"
  | "archived"
  | "unavailable"
  | "restart_recovery_pending";

export type ManagedWakeAdmissionResult =
  | { status: "reserved"; reservationId: string; run: RunIdentity }
  | { status: ManagedWakeRejectionStatus; detail?: string };

export interface ManagedWakeReserveInput {
  agentId: string;
  batchId: string;
  batchMessageId: string;
  creatorFenceId: string | null;
}
