import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import {
  DEFAULT_MANAGED_SHELL_POLICY,
  DEFAULT_PROVIDER_CONTINUATION_CAPABILITIES,
  type ManagedShellAuthorizationPolicy,
  type ProviderContinuationCapabilities,
} from "./policy.js";
import type { ManagedToolCallerContext } from "./tools-service.js";

export interface ManagedContinuationPolicyBundle {
  shellPolicy: ManagedShellAuthorizationPolicy;
  providerCapabilities: ProviderContinuationCapabilities;
}

/**
 * Default-deny policy resolver for Daemon bootstrap.
 *
 * Keeps `managedBackgroundCommands` and `coldSessionResume` strictly OFF by default until
 * explicit Host+Workspace+Provider authorization is granted (or local QA opt-in env flags
 * `PASEO_EXPERIMENTAL_MANAGED_CONTINUATIONS_ALLOW_SHELL=1` and
 * `PASEO_EXPERIMENTAL_COLD_RESUME_PROVIDERS=codex,claude` are explicitly set).
 */
export function resolveBootstrapManagedContinuationPolicy(
  provider: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ManagedContinuationPolicyBundle {
  const allowShell = env.PASEO_EXPERIMENTAL_MANAGED_CONTINUATIONS_ALLOW_SHELL === "1";
  const rawProviders = env.PASEO_EXPERIMENTAL_COLD_RESUME_PROVIDERS ?? "";
  const allowedColdResume = new Set(
    rawProviders
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );

  const shellPolicy: ManagedShellAuthorizationPolicy = allowShell
    ? {
        hostEnabled: true,
        workspaceEnabled: true,
        profileMode: "full",
        allowHostShellEscape: true,
      }
    : DEFAULT_MANAGED_SHELL_POLICY;

  const normalizedProvider = provider ? provider.toLowerCase() : "";
  const coldSessionResume =
    normalizedProvider.length > 0 && allowedColdResume.has(normalizedProvider);

  const providerCapabilities: ProviderContinuationCapabilities = coldSessionResume
    ? { coldSessionResume: true }
    : DEFAULT_PROVIDER_CONTINUATION_CAPABILITIES;

  return { shellPolicy, providerCapabilities };
}

export function buildManagedToolCallerContext(input: {
  callerAgentId: string | undefined;
  callerAgent: ManagedAgent | null;
  agentManager: Pick<AgentManager, "getDaemonInstanceId">;
  resolvePolicy?: (
    agentId: string,
    provider: string | undefined,
  ) => ManagedContinuationPolicyBundle;
}): ManagedToolCallerContext {
  if (!input.callerAgentId || !input.callerAgent) {
    throw new Error("Managed continuation tools require an authenticated callerAgentId");
  }
  const policyBundle = input.resolvePolicy
    ? input.resolvePolicy(input.callerAgentId, input.callerAgent.provider)
    : {
        shellPolicy: DEFAULT_MANAGED_SHELL_POLICY,
        providerCapabilities: DEFAULT_PROVIDER_CONTINUATION_CAPABILITIES,
      };
  const workspaceId = input.callerAgent.workspaceId ?? input.callerAgent.cwd;
  const runToken = input.callerAgent.activeTurnId ?? `turn-less-${input.callerAgentId}`;
  return {
    agentId: input.callerAgentId,
    workspaceId,
    defaultCwd: input.callerAgent.cwd,
    allowedWorkspaceRoots: [input.callerAgent.cwd],
    originRun: {
      daemonInstanceId: input.agentManager.getDaemonInstanceId(),
      runToken,
    },
    shellPolicy: policyBundle.shellPolicy,
    providerCapabilities: policyBundle.providerCapabilities,
  };
}
