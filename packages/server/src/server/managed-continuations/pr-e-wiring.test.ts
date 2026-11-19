import { describe, expect, it } from "vitest";
import {
  buildManagedToolCallerContext,
  resolveBootstrapManagedContinuationPolicy,
} from "./index.js";

describe("Managed Continuations PR E — Bootstrap Wiring & Default-Deny Policy Resolver", () => {
  it("defaults to fail-closed Host Shell deny and coldSessionResume=false when no env opt-in is set", () => {
    const bundle = resolveBootstrapManagedContinuationPolicy("codex", {});
    expect(bundle.shellPolicy.hostEnabled).toBe(false);
    expect(bundle.shellPolicy.workspaceEnabled).toBe(false);
    expect(bundle.shellPolicy.profileMode).toBe("read-only");
    expect(bundle.providerCapabilities.coldSessionResume).toBe(false);
  });

  it("enables Host Shell and verified coldSessionResume only for explicitly opted-in providers", () => {
    const env = {
      PASEO_EXPERIMENTAL_MANAGED_CONTINUATIONS_ALLOW_SHELL: "1",
      PASEO_EXPERIMENTAL_COLD_RESUME_PROVIDERS: "codex, claude",
    };
    const codex = resolveBootstrapManagedContinuationPolicy("codex", env);
    expect(codex.shellPolicy.hostEnabled).toBe(true);
    expect(codex.shellPolicy.workspaceEnabled).toBe(true);
    expect(codex.providerCapabilities.coldSessionResume).toBe(true);

    const unknown = resolveBootstrapManagedContinuationPolicy("other-provider", env);
    expect(unknown.providerCapabilities.coldSessionResume).toBe(false);
  });

  it("rejects missing callerAgentId when building tool caller context", () => {
    expect(() =>
      buildManagedToolCallerContext({
        callerAgentId: undefined,
        callerAgent: null,
        agentManager: { getDaemonInstanceId: () => "daemon-1" },
      }),
    ).toThrow(/authenticated callerAgentId/);
  });
});
