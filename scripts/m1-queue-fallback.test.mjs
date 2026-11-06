import assert from "node:assert/strict";
import test from "node:test";
import { decide, stuckMacJobs } from "./m1-queue-fallback.mjs";

const now = Date.parse("2026-11-06T12:00:00Z");
const minutesAgo = (minutes) => new Date(now - minutes * 60_000).toISOString();
const job = (name, labels, status, createdMinutesAgo) => ({
  name,
  labels,
  status,
  created_at: minutesAgo(createdMinutesAgo),
});
const guard = job("M1 fallback", ["ubuntu-latest"], "in_progress", 30);
const look = (jobs, expectedMacJobs = 2) =>
  decide({ jobs, guardName: "M1 fallback", expectedMacJobs, now, minutes: 10 });

test("waits while macOS jobs have queued for less than the limit", () => {
  const jobs = [guard, job("macos (macos-15, arm64)", ["macos-15"], "queued", 9)];
  assert.equal(look(jobs).action, "wait");
});

test("takes over once a macOS job has waited the limit", () => {
  const stuck = job("macos (macos-15-intel, x64)", ["macos-15-intel"], "queued", 10);
  const jobs = [guard, job("macos (macos-15, arm64)", ["macos-15"], "in_progress", 12), stuck];
  assert.deepEqual(look(jobs), { action: "takeover", stuck: [stuck] });
});

test("ignores queued jobs that do not need a Mac", () => {
  const jobs = [guard, job("release", ["ubuntu-latest"], "queued", 30)];
  assert.deepEqual(stuckMacJobs(jobs, now, 10), []);
  assert.equal(look(jobs).action, "wait");
});

test("stops once hosted runners took every macOS job", () => {
  const jobs = [guard, job("Unsigned iPhoneOS IPA", ["macos-15"], "in_progress", 40)];
  assert.equal(look(jobs, 1).action, "done");
});

test("stops when the run finished before any macOS job", () => {
  const jobs = [
    guard,
    { ...job("validate", ["ubuntu-latest"], "completed", 20), conclusion: "failure" },
  ];
  assert.equal(look(jobs, 4).action, "done");
});
