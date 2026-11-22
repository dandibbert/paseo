import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageReport,
  type UsageSourceRegistration,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { T3Environment, type T3EnvironmentOptions } from "./environment.js";

const input = z.object({ instanceId: z.string().min(1) }).strict();

const DURATION_SECONDS: Record<string, number> = {
  session: 5 * 3600,
  weekly: 7 * 24 * 3600,
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** T3's per-account quota windows, as T3 itself measured them. */
export function reportFromT3(usageLimits: unknown): UsageReport {
  const limits = record(usageLimits);
  if (Object.keys(limits).length === 0) {
    return unavailable({ kind: "no_quota", detail: "T3 has not read this account's quota yet." });
  }
  if (record(limits.unavailable).reason) {
    return unavailable({ kind: "no_quota", detail: "T3 could not read this account's quota." });
  }
  const windows: UsageWindow[] = (Array.isArray(limits.windows) ? limits.windows : []).flatMap(
    (value) => {
      const window = record(value);
      const id = typeof window.id === "string" ? window.id : undefined;
      const label = typeof window.label === "string" ? window.label : undefined;
      if (!id || !label || typeof window.usedPercent !== "number") return [];
      const kind = typeof window.kind === "string" ? window.kind : "other";
      const minutes = typeof window.windowDurationMins === "number" ? window.windowDurationMins : 0;
      const durationSeconds = minutes > 0 ? minutes * 60 : DURATION_SECONDS[kind];
      return [
        windowFromUsedPct({
          id,
          label,
          ...(kind === "session" ? { shortLabel: "5h" } : {}),
          ...(kind === "weekly" ? { shortLabel: "wk" } : {}),
          summary: kind === "session" || kind === "weekly",
          utilizationPct: window.usedPercent,
          tone: toneFromUsedPct(window.usedPercent),
          ...(durationSeconds ? { durationSeconds } : {}),
          resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : null,
        }),
      ];
    },
  );
  return {
    status: "available",
    ...(typeof limits.checkedAt === "string" ? { observedAt: limits.checkedAt } : {}),
    windows,
  };
}

export function createT3UsageSource(
  options: Omit<T3EnvironmentOptions, "launch"> = {},
): UsageSourceRegistration {
  return {
    id: "antigravity-t3",
    label: "Antigravity (via T3)",
    icon: "icon.svg",
    provider: "antigravity-t3",
    input,
    async discover(scope) {
      if (scope.kind === "session" && scope.provider !== "antigravity-t3") return [];
      if (!scope.launch) return [];
      const environment = new T3Environment({ ...options, launch: scope.launch });
      try {
        // Quota polling must not pair Paseo with T3 by itself; the provider does that on use.
        if (!(await environment.isPaired())) return [];
        const instances = await environment.instances();
        return instances
          .filter((instance) => instance.enabled)
          .map((instance) => ({
            key: hashAccountKey(`t3:${instance.instanceId}`),
            label: instance.displayName,
            harness: "T3 Code",
            input: { instanceId: instance.instanceId },
          }));
      } finally {
        environment.close();
      }
    },
    async fetch(value) {
      const { instanceId } = input.parse(value);
      const environment = new T3Environment(options);
      try {
        const instance = (await environment.instances()).find(
          (candidate) => candidate.instanceId === instanceId,
        );
        if (!instance) return { status: "error", error: "T3 no longer has this account." };
        return reportFromT3(instance.usageLimits);
      } finally {
        environment.close();
      }
    },
  };
}
