#!/usr/bin/env node
// Moves this workflow run to the M1 build machine (dandibbert/mac-build-hub) when a
// GitHub-hosted macOS job has waited too long for a runner. Runs as a small Ubuntu job beside
// the macOS jobs: it exits once every macOS job has a runner, and otherwise dispatches the
// matching hub workflow for the same commit. It cancels this run only once an M1 runner has
// picked that build up, so an offline M1 leaves the run on GitHub.
//
// A job is only created once the jobs it needs have finished, so a queued job's age is how
// long it has been waiting for a runner.

import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { isMainModule } from "./is-main-module.mjs";

const API = "https://api.github.com";

export function isMacJob(job) {
  return job.labels.some((label) => label.startsWith("macos"));
}

/** macOS jobs of the run that have waited at least `minutes` for a runner. */
export function stuckMacJobs(jobs, now, minutes) {
  return jobs.filter(
    (job) =>
      isMacJob(job) &&
      (job.status === "queued" || job.status === "waiting") &&
      now - Date.parse(job.created_at) >= minutes * 60_000,
  );
}

/** What the guard does after one look at the run's jobs. */
export function decide({ jobs, guardName, expectedMacJobs, now, minutes }) {
  const started = jobs.filter(
    (job) => isMacJob(job) && (job.status === "in_progress" || job.status === "completed"),
  );
  if (started.length >= expectedMacJobs)
    return { action: "done", reason: "hosted runners took every macOS job" };
  const others = jobs.filter((job) => job.name !== guardName);
  if (others.length > 0 && others.every((job) => job.status === "completed")) {
    return { action: "done", reason: "the run finished without waiting macOS jobs" };
  }
  const stuck = stuckMacJobs(jobs, now, minutes);
  if (stuck.length > 0) return { action: "takeover", stuck };
  return { action: "wait" };
}

/**
 * After the hub build is dispatched: whichever side gets a runner first keeps the build.
 * `hubJobs` are the hub run's jobs; `step` is decide() for this run, looked at again.
 */
export function decideHandover({ hubJobs, step, waitedMs, limitMs }) {
  const onM1 = hubJobs.filter((job) => job.labels.includes("m1-build"));
  if (onM1.some((job) => job.status === "in_progress" || job.status === "completed")) {
    return "m1";
  }
  if (step.action === "done") return "github";
  if (waitedMs >= limitMs) return "give-up";
  return "wait";
}

async function call(method, path, token, body) {
  const init = {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "paseo-m1-queue-fallback",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(API + path, init);
  if (!response.ok) {
    throw new Error(
      `${method} ${path} failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function readConfig(env) {
  // SOURCE_SHA in projects other than Paseo, which copy this script.
  const sha = env.SOURCE_SHA ?? env.PASEO_SHA;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error(`Commit to build is not a SHA: ${sha}`);
  return {
    repo: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    token: env.GITHUB_TOKEN,
    hubToken: env.M1_BUILD_HUB_TOKEN,
    hubRepo: env.HUB_REPO,
    hubWorkflow: env.HUB_WORKFLOW,
    hubWorkflowUrl: `${env.GITHUB_SERVER_URL}/${env.HUB_REPO}/actions/workflows/${env.HUB_WORKFLOW}`,
    hubInputs: { ...JSON.parse(env.HUB_INPUTS ?? "{}"), [env.HUB_SHA_INPUT ?? "paseo_sha"]: sha },
    sha,
    guardName: env.GUARD_JOB_NAME,
    expectedMacJobs: Number(env.EXPECTED_MAC_JOBS),
    minutes: Number(env.QUEUE_MINUTES ?? "10"),
    handoverMs: Number(env.HANDOVER_MINUTES ?? "15") * 60_000,
    pollMs: Number(env.POLL_SECONDS ?? "60") * 1000,
  };
}

async function lookAtRun(config) {
  const { jobs } = await call(
    "GET",
    `/repos/${config.repo}/actions/runs/${config.runId}/jobs?per_page=100`,
    config.token,
  );
  return decide({
    jobs,
    guardName: config.guardName,
    expectedMacJobs: config.expectedMacJobs,
    now: Date.now(),
    minutes: config.minutes,
  });
}

/** Asks the M1 for the build and cancels this run only once an M1 runner has it. */
async function handOver(config, stuck) {
  const dispatched = await call(
    "POST",
    `/repos/${config.hubRepo}/actions/workflows/${config.hubWorkflow}/dispatches`,
    config.hubToken,
    {
      ref: "main",
      inputs: { ...config.hubInputs, requested_by: config.runUrl },
      return_run_details: true,
    },
  );
  const names = stuck.map((job) => job.name).join(", ");
  summary(
    `Waited ${config.minutes} min for a GitHub-hosted Mac (${names}). Asked the M1 to build ${config.sha}: ${dispatched?.html_url ?? config.hubWorkflowUrl}`,
  );
  const hubRunId = dispatched?.workflow_run_id;
  if (!hubRunId) {
    summary("The hub did not return its run, so this run stays on GitHub as well.");
    return;
  }
  const askedAt = Date.now();
  for (;;) {
    await sleep(config.pollMs);
    const hub = await call(
      "GET",
      `/repos/${config.hubRepo}/actions/runs/${hubRunId}/jobs?per_page=100`,
      config.hubToken,
    );
    const outcome = decideHandover({
      hubJobs: hub.jobs,
      step: await lookAtRun(config),
      waitedMs: Date.now() - askedAt,
      limitMs: config.handoverMs,
    });
    if (outcome === "wait") continue;
    if (outcome === "m1") {
      summary("The M1 picked the build up; cancelling this run.");
      await call("POST", `/repos/${config.repo}/actions/runs/${config.runId}/cancel`, config.token);
      return;
    }
    await call("POST", `/repos/${config.hubRepo}/actions/runs/${hubRunId}/cancel`, config.hubToken);
    summary(
      outcome === "github"
        ? "A GitHub-hosted Mac became free first; withdrew the M1 build."
        : `No M1 runner took the build within ${config.handoverMs / 60_000} min; withdrew it and stayed on GitHub.`,
    );
    return;
  }
}

async function main() {
  if (!process.env.M1_BUILD_HUB_TOKEN) {
    summary("M1_BUILD_HUB_TOKEN is not set; this run stays on GitHub-hosted runners.");
    return;
  }
  const config = readConfig(process.env);
  for (;;) {
    const step = await lookAtRun(config);
    if (step.action === "done") {
      console.log(`Nothing to move: ${step.reason}.`);
      return;
    }
    if (step.action === "takeover") {
      await handOver(config, step.stuck);
      return;
    }
    await sleep(config.pollMs);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
