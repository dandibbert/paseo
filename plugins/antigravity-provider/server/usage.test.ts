import { describe, expect, it, vi } from "vitest";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import contribute from "../index.server.js";
import {
  createAntigravityUsageSource,
  parseAgyQuota,
  type AgyQuotaRunner,
} from "./usage.js";

const sample = {
  status: "SUCCESS",
  conversation_id: "",
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.44,
              reset_time: "2026-11-22T08:00:00Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "2026-11-17T12:00:00Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.125,
              reset_time: "2026-11-21T13:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              // A missing fraction is not an exhausted bucket.
              remaining_fraction: null,
            },
          ],
        },
      ],
    },
  },
};

describe("native Antigravity /usage quota conversion", () => {
  it("shows both Gemini limits and Claude/GPT limits as normal Paseo Usage windows", () => {
    const report = parseAgyQuota(JSON.stringify(sample));
    expect(report.status).toBe("available");
    if (report.status !== "available") throw new Error("Missing quota");
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "Gemini Models/gemini-weekly", label: "Gemini Models · Weekly",
        shortLabel: "Gemini wk", usedPct: 56, remainingPct: 44,
        resetsAt: "2026-11-22T08:00:00.000Z", summary: true,
      }),
      expect.objectContaining({
        id: "Gemini Models/gemini-5h", label: "Gemini Models · 5-hour",
        shortLabel: "Gemini 5h", usedPct: 0, remainingPct: 100,
        resetsAt: "2026-11-17T12:00:00.000Z", summary: true,
      }),
      expect.objectContaining({
        id: "Claude and GPT models/3p-weekly", label: "Claude and GPT models · Weekly",
        shortLabel: "Claude/GPT wk", usedPct: 87.5, remainingPct: 12.5,
        resetsAt: "2026-11-21T13:00:00.000Z", summary: false,
      }),
    ]);
  });

  it("never turns missing or invalid percentages into invented 0 or 100% bars", () => {
    const payload = structuredClone(sample) as unknown as { command: { data: { groups: Array<{ buckets: Array<Record<string, unknown>> }> } } };
    payload.command.data.groups[0]!.buckets = [
      { id: "absent", name: "Weekly", window: "weekly", remaining_fraction: null, reset_time: "" },
      { id: "spent", name: "Five Hour", window: "5h", remaining_fraction: 0, reset_time: "not-a-date" },
    ];
    const report = parseAgyQuota(JSON.stringify(payload));
    expect(report.status).toBe("available");
    if (report.status !== "available") throw new Error("No usage");
    expect(report.windows.find((window) => window.id.includes("absent"))).toBeUndefined();
    expect(report.windows[0]).toMatchObject({ id: "Gemini Models/spent", usedPct: 100, remainingPct: 0, resetsAt: null });
  });

  it("refuses model turns, unrelated slash commands, or malformed output", () => {
    expect(parseAgyQuota(JSON.stringify({ ...sample, num_turns: 1 }))).toMatchObject({ status: "error" });
    expect(parseAgyQuota(JSON.stringify({ ...sample, command: { name: "chat", data: sample.command.data } }))).toMatchObject({ status: "error" });
    expect(parseAgyQuota("This looks like a model answer")).toMatchObject({ status: "error" });
    expect(parseAgyQuota(JSON.stringify({ ...sample, command: { name: "usage", data: {} } }))).toMatchObject({ status: "unavailable" });
  });

  it("treats sign-out as an authentication error and accepts the /quota alias", () => {
    expect(parseAgyQuota("Please sign in to Antigravity")).toEqual({
      status: "unavailable", problem: { kind: "rejected", status: 401, refreshedBy: "agy" },
    });
    expect(parseAgyQuota(JSON.stringify({ ...sample, command: { ...sample.command, name: "quota" } }))).toMatchObject({ status: "available" });
  });
});

describe("built-in Antigravity Usage Source", () => {
  function harness(version = "1.2.13") {
    const calls: Array<{ cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv; timeoutMs: number }> = [];
    const runner: AgyQuotaRunner = vi.fn(async (cmd, args, options) => {
      calls.push({ cmd, args, ...options });
      if (args.includes("--version")) return { stdout: version };
      return { stdout: JSON.stringify(sample) };
    });
    const source = createAntigravityUsageSource(runner);
    return { calls, source, runner, registration: source.registration() };
  }

  it("registers the Provider and Usage Source together, without adding UI components", () => {
    const providers: unknown[] = [], sources: unknown[] = [];
    contribute({
      registerProvider: (provider: unknown) => { providers.push(provider); },
      registerUsageSource: (source: unknown) => { sources.push(source); },
    } as never);
    expect(providers).toHaveLength(1);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ id: "antigravity-provider", label: "Antigravity" });
  });

  it("registers only for its provider, using a single default signed-in account", async () => {
    const { registration, calls } = harness();
    expect(await registration.discover({ kind: "session", provider: "codex", model: "gpt", env: {} })).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(await registration.discover({ kind: "global" })).toEqual([
      { key: "default", label: "Antigravity CLI", harness: "Antigravity", input: { account: "default" } },
    ]);
    expect(await registration.discover({ kind: "session", provider: "antigravity", env: {} })).toHaveLength(1);
  });

  it("sends only the read-only version check and -p /usage command, with the configured binary", async () => {
    const { registration, source, calls } = harness();
    const launch: ProviderLaunch = { command: "/opt/agy", args: ["--some-wrapper-flag"], env: { HOME: "/account" } };
    source.rememberLaunch(launch);
    expect(await registration.fetch({ account: "default" })).toMatchObject({ status: "available" });
    expect(calls).toMatchObject([
      { cmd: "/opt/agy", args: ["--some-wrapper-flag", "--version"], env: { HOME: "/account" } },
      { cmd: "/opt/agy", args: ["--some-wrapper-flag", "-p", "/usage", "--output-format", "json"], env: { HOME: "/account" } },
    ]);
    for (const call of calls) {
      expect(call.args).not.toContain("--disable-slash-commands");
      expect(call.args).not.toContain("--model");
      expect(call.args).not.toContain("--input-format");
      expect(call.args).not.toContain("--conversation");
    }
  });

  it("gates older versions before making any /usage request", async () => {
    const { registration, calls } = harness("1.1.10");
    expect(await registration.discover({ kind: "global" })).toEqual([]);
    expect(await registration.fetch({ account: "default" })).toMatchObject({ status: "unavailable" });
    expect(calls.every((call) => call.args.includes("--version"))).toBe(true);
  });

  it("never accepts another account locator or converts a failed CLI call to a success", async () => {
    const { registration } = harness();
    await expect(registration.fetch({ account: "other" })).rejects.toThrow();
    const fail = createAntigravityUsageSource(async (_cmd, args) => {
      if (args.includes("--version")) return { stdout: "1.2.13" };
      throw new Error("Please sign in");
    });
    expect(await fail.registration().fetch({ account: "default" })).toEqual({
      status: "unavailable", problem: { kind: "rejected", status: 401, refreshedBy: "agy" },
    });
  });
});
