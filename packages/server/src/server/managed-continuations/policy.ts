/**
 * Runtime policy, authorization, and provider cold-resume capability gates (Spec v0.4.1 §4.6 & §7.1).
 *
 * - `managedBackgroundCommands` is DENIED by default unless BOTH Host and Workspace explicitly enable it.
 * - Read-only / restricted / workspace-write profiles are DENIED host shell escape unless explicitly granted.
 * - Subagents do NOT inherit elevated host shell privileges automatically.
 * - `coldSessionResume` defaults to `false` (fail closed for `notifyOnExit: true` and `send_later`).
 */

export type ProviderProfileSandboxMode = "full" | "workspace-write" | "restricted" | "read-only";

export interface ManagedShellAuthorizationPolicy {
  hostEnabled: boolean;
  workspaceEnabled: boolean;
  profileMode: ProviderProfileSandboxMode;
  allowHostShellEscape?: boolean;
  isSubagent?: boolean;
  explicitSubagentGrant?: boolean;
}

export interface ProviderContinuationCapabilities {
  /** Conservative default: false. Only set true after real Daemon restart E2E passes. */
  coldSessionResume: boolean;
}

export type PolicyRejectionCode =
  | "HOST_SHELL_DISABLED"
  | "HOST_SHELL_ESCAPE_DENIED"
  | "SUBAGENT_SHELL_NOT_INHERITED"
  | "PROVIDER_COLD_RESUME_UNSUPPORTED";

export class ManagedContinuationPolicyError extends Error {
  constructor(
    readonly code: PolicyRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagedContinuationPolicyError";
  }
}

export const DEFAULT_MANAGED_SHELL_POLICY: ManagedShellAuthorizationPolicy = {
  hostEnabled: false,
  workspaceEnabled: false,
  profileMode: "read-only",
  allowHostShellEscape: false,
};

export const DEFAULT_PROVIDER_CONTINUATION_CAPABILITIES: ProviderContinuationCapabilities = {
  coldSessionResume: false,
};

export function assertHostShellAuthorized(policy: ManagedShellAuthorizationPolicy): void {
  if (!policy.hostEnabled || !policy.workspaceEnabled) {
    throw new ManagedContinuationPolicyError(
      "HOST_SHELL_DISABLED",
      "Managed background commands require explicit Host and Workspace authorization (default deny)",
    );
  }
  if (policy.isSubagent && !policy.explicitSubagentGrant) {
    throw new ManagedContinuationPolicyError(
      "SUBAGENT_SHELL_NOT_INHERITED",
      "Subagents do not automatically inherit elevated Host Shell permissions",
    );
  }
  if (policy.profileMode !== "full" && policy.allowHostShellEscape !== true) {
    throw new ManagedContinuationPolicyError(
      "HOST_SHELL_ESCAPE_DENIED",
      `Provider profile '${policy.profileMode}' blocks Host Shell escape without explicit allowHostShellEscape: true`,
    );
  }
}

export function assertColdResumeSupported(
  capabilities: ProviderContinuationCapabilities | undefined,
  featureName: string,
): void {
  if (capabilities?.coldSessionResume !== true) {
    throw new ManagedContinuationPolicyError(
      "PROVIDER_COLD_RESUME_UNSUPPORTED",
      `${featureName} requires a provider with verified coldSessionResume capability`,
    );
  }
}
