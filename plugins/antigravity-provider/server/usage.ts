import { tmpdir } from "node:os";
import { probe } from "./internal/process.js";
import { z } from "zod";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

/**
 * Reuse the account and CLI already configured for the built-in Antigravity provider.
 * Paseo's Usage page automatically renders registered sources; this plugin adds no UI.
 *
 * The print-mode /usage command is read-only on agy >= 1.1.11. We require
 * >= 1.1.15 (the provider's existing minimum), and check the version again
 * before every quota read. Never pass --disable-slash-commands: on older CLIs
 * an unsupported /usage can become a paid model prompt.
 */
const inputSchema = z.object({ account: z.literal("default") }).strict();
const VERSION_MIN = [1, 1, 15] as const;
const VERSION_TIMEOUT_MS = 3_000;
const QUOTA_TIMEOUT_MS = 15_000; // Version and quota together fit Paseo's 20s deadline.

export type AgyQuotaRunner = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string; stderr?: string }>;

async function defaultRunner(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ stdout: string; stderr?: string }> {
  const stdout = await probe({
    launch: { command, args: [], env: options.env as Record<string, string> },
    args: [...args],
    cwd: tmpdir(),
    timeoutMs: options.timeoutMs,
  });
  return { stdout };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readEnvelope(output: string): Record<string, unknown> | null {
  // Some CLI versions print a warning/banner before the JSON object.
  const lines = [output.trim(), ...output.split(/\r?\n/).map((line) => line.trim())];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = object(JSON.parse(line));
      if (parsed) return parsed;
    } catch {
      // Try the next line, never interpret a plain-text model answer as quota.
    }
  }
  return null;
}

function versionIsSafe(output: string): boolean {
  const match = /^(?:agy\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/i.exec(output.trim());
  if (!match) return false;
  const [major = 0, minor = 0, patch = 0] = match.slice(1, 4).map(Number);
  const [minMajor, minMinor, minPatch] = VERSION_MIN;
  return major > minMajor ||
    (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
}

function windowName(value: string): { label: string; short: string } {
  switch (value.toLowerCase()) {
    case "5h": return { label: "5-hour", short: "5h" };
    case "weekly": return { label: "Weekly", short: "wk" };
    default: return { label: value || "Current window", short: value };
  }
}

function groupShortName(name: string): string {
  if (/gemini/i.test(name)) return "Gemini";
  if (/claude.*gpt/i.test(name)) return "Claude/GPT";
  return name;
}

function resetTimestamp(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const SIGNED_OUT = /please sign in|not logged in|not logged into|authentication required/i;

/**
 * Parse only an authenticated CLI command result with zero model turns.
 * Reject malformed or missing shares rather than painting an invented 0%.
 */
export function parseAgyQuota(stdout: string, stderr = ""): UsageReport {
  if (SIGNED_OUT.test(`${stdout}\n${stderr}`))
    return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
  const payload = readEnvelope(stdout);
  if (!payload) return { status: "error", error: "agy /usage returned no valid JSON" };
  if (payload.status === "ERROR") {
    const reason = stringValue(payload.error) ?? stringValue(payload.response) ?? "No quota summary reported";
    return unavailable({ kind: "no_quota", detail: reason });
  }
  if (payload.status !== "SUCCESS" || payload.num_turns !== 0)
    return { status: "error", error: "agy /usage did not return a zero-turn command result" };
  const command = object(payload.command);
  if (!["usage", "quota"].includes(stringValue(command?.name)?.toLowerCase() ?? ""))
    return { status: "error", error: "agy returned a different command instead of /usage" };
  const data = object(command?.data);
  const rawGroups = data?.groups;
  if (!Array.isArray(rawGroups))
    return unavailable({ kind: "no_quota", detail: "agy /usage returned no quota groups" });

  const groups = quotaGroups(rawGroups);
  if (!groups.length)
    return unavailable({ kind: "no_quota", detail: "agy /usage returned no usable quota windows" });
  // Both limits of the first model family appear in the compact summary.
  return {
    status: "available",
    windows: groups.flatMap((windows, index) =>
      windows.map((window) => ({ ...window, summary: index === 0 }))),
  };
}

function quotaBucket(raw: unknown, groupName: string): UsageWindow | null {
  const bucket = object(raw);
  if (!bucket) return null;
  const remaining = bucket.remaining_fraction;
  if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1)
    return null;
  const id = stringValue(bucket.id) ?? stringValue(bucket.name);
  if (!id) return null;
  const window = windowName(stringValue(bucket.window) ?? stringValue(bucket.name) ?? "");
  const usedPct = Math.round((1 - remaining) * 1_000) / 10;
  return windowFromUsedPct({
    id: groupName + "/" + id,
    label: groupName + " · " + window.label,
    shortLabel: (groupShortName(groupName) + " " + window.short).trim(),
    utilizationPct: usedPct,
    resetsAt: resetTimestamp(bucket.reset_time),
    tone: toneFromUsedPct(usedPct),
  });
}

function quotaGroups(rawGroups: unknown[]): UsageWindow[][] {
  const groups: UsageWindow[][] = [];
  for (const raw of rawGroups) {
    const group = object(raw);
    const name = stringValue(group?.name);
    if (!name || !Array.isArray(group?.buckets)) continue;
    const windows: UsageWindow[] = [];
    const ids = new Set<string>();
    for (const rawBucket of group.buckets) {
      const window = quotaBucket(rawBucket, name);
      if (!window || ids.has(window.id)) continue;
      ids.add(window.id);
      windows.push(window);
    }
    if (windows.length) groups.push(windows);
  }
  return groups;
}
/**
 * The built-in AGY CLI provider may use a configured command/argv/environment.
 * Remember that launch so quota queries use the same installation and login;
 * before the first provider connection, fall back to agy on the daemon PATH.
 */
export function createAntigravityUsageSource(run: AgyQuotaRunner = defaultRunner) {
  let launch: ProviderLaunch | null = null;
  const execute = async (args: readonly string[], timeoutMs: number) => {
    const command = launch?.command ?? process.env.PASEO_ANTIGRAVITY_BIN ?? "agy";
    const prefix = launch?.args ?? [];
    const env = { ...process.env, ...launch?.env };
    return run(command, [...prefix, ...args], { env, timeoutMs });
  };
  const safeVersion = async () => {
    const { stdout } = await execute(["--version"], VERSION_TIMEOUT_MS);
    return versionIsSafe(stdout);
  };
  const registration: UsageSourceRegistration = {
    // Unique to the built-in provider, avoiding collisions with optional external usage plugins.
    id: "antigravity-provider",
    label: "Antigravity",
    icon: "icon.svg",
    input: inputSchema,
    async discover(scope: UsageScope) {
      if (scope.kind === "session" && scope.provider !== "antigravity") return [];
      try {
        if (!(await safeVersion())) return [];
      } catch {
        // An AGY-less daemon should not show an empty, broken Usage card.
        return [];
      }
      return [{ key: "default", label: "Antigravity CLI", harness: "Antigravity", input: { account: "default" } }];
    },
    async fetch(input: unknown): Promise<UsageReport> {
      inputSchema.parse(input);
      try {
        if (!(await safeVersion()))
          return unavailable({ kind: "no_quota", detail: "Upgrade agy to 1.1.15 or newer to read quota safely" });
        // Exactly four arguments: no conversation, model, input-format or --disable-slash-commands.
        const { stdout, stderr } = await execute(["-p", "/usage", "--output-format", "json"], QUOTA_TIMEOUT_MS);
        return parseAgyQuota(stdout, stderr);
      } catch (error) {
        const failure = object(error);
        const message = [failure?.stdout, failure?.stderr, error instanceof Error ? error.message : ""]
          .filter((value): value is string => typeof value === "string").join("\n");
        if (SIGNED_OUT.test(message))
          return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
        return { status: "error", error: "Unable to read agy /usage; check that agy is signed in and reachable on the daemon host" };
      }
    },
  };
  return {
    registration: () => registration,
    rememberLaunch(next: ProviderLaunch) { launch = next; },
  };
}
