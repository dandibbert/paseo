#!/usr/bin/env node
// Moves this workflow run to the M1 build machine (dandibbert/mac-build-hub) when a
// GitHub-hosted macOS job has waited too long for a runner. Runs as a small Ubuntu job beside
// the macOS jobs: it exits once every macOS job has a runner, and otherwise dispatches the
// matching hub workflow for the same commit and cancels this run.
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

async function main() {
  const env = process.env;
  const hubToken = env.M1_BUILD_HUB_TOKEN;
  if (!hubToken) {
    summary("M1_BUILD_HUB_TOKEN is not set; this run stays on GitHub-hosted runners.");
    return;
  }
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const minutes = Number(env.QUEUE_MINUTES ?? "10");
  const pollMs = Number(env.POLL_SECONDS ?? "60") * 1000;
  const expectedMacJobs = Number(env.EXPECTED_MAC_JOBS);
  const sha = env.PASEO_SHA;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error(`PASEO_SHA is not a commit: ${sha}`);
  const inputs = JSON.parse(env.HUB_INPUTS ?? "{}");

  for (;;) {
    const { jobs } = await call(
      "GET",
      `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
      env.GITHUB_TOKEN,
    );
    const step = decide({
      jobs,
      guardName: env.GUARD_JOB_NAME,
      expectedMacJobs,
      now: Date.now(),
      minutes,
    });
    if (step.action === "done") {
      console.log(`Nothing to move: ${step.reason}.`);
      return;
    }
    if (step.action === "takeover") {
      const names = step.stuck.map((job) => job.name).join(", ");
      const runUrl = `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${runId}`;
      const dispatched = await call(
        "POST",
        `/repos/${env.HUB_REPO}/actions/workflows/${env.HUB_WORKFLOW}/dispatches`,
        hubToken,
        {
          ref: "main",
          inputs: { ...inputs, paseo_sha: sha, requested_by: runUrl },
          return_run_details: true,
        },
      );
      const hubRun =
        dispatched?.html_url ??
        `${env.GITHUB_SERVER_URL}/${env.HUB_REPO}/actions/workflows/${env.HUB_WORKFLOW}`;
      summary(
        `Waited ${minutes} min for a GitHub-hosted Mac (${names}). Building ${sha} on the M1: ${hubRun}`,
      );
      await call("POST", `/repos/${repo}/actions/runs/${runId}/cancel`, env.GITHUB_TOKEN);
      summary("Cancelled this run; the M1 build replaces it.");
      return;
    }
    await sleep(pollMs);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
