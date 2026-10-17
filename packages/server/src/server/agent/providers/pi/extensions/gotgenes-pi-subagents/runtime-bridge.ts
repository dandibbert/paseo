export const GOTGENES_CHILD_SESSION_MARKER = "PASEO_GOTGENES_CHILD_SESSION";
export const GOTGENES_LIFECYCLE_MARKER = "PASEO_GOTGENES_LIFECYCLE";

/** gotgenes appends one of these custom entries for every finished run, fresh or resumed. */
export const GOTGENES_RECORD_ENTRY = "subagents:record";

/**
 * Runs inside Pi. The spawn result omits the child's session file, so the parent's public service
 * is the live source. Each child session loads its own copy of gotgenes, which republishes the
 * global service and deletes it on exit, so the parent's service is captured at session_start.
 *
 * Lifecycle events are relayed so a background run settles its card without the parent ever
 * calling get_subagent_result. Only agents the parent's service owns are relayed, and each carries
 * the record's `startedAt`, which gotgenes resets on resume, so Paseo can tell runs apart.
 */
export const gotgenesRuntimeBridge = `
  let gotgenesParent;
  pi.on("session_start", (_event, ctx) => {
    gotgenesParent = { ctx, service: globalThis[Symbol.for("@gotgenes/pi-subagents:service")] };
  });
  pi.events.on("subagents:child:session-created", (event) => {
    const parent = gotgenesParent;
    let attempts = 0;
    // The record gets its session file after the child's extensions bind.
    const report = () => {
      const record = parent?.service?.listAgents().find((agent) =>
        agent.outputFile?.includes(event.sessionId),
      );
      if (record) {
        parent.ctx.ui.notify(
          "${GOTGENES_CHILD_SESSION_MARKER} " +
            JSON.stringify({ agentId: record.id, file: record.outputFile }),
          "info",
        );
      } else if (++attempts < 240) {
        setTimeout(report, 250);
      }
    };
    setTimeout(report, 0);
  });
  for (const channel of [
    "subagents:started",
    "subagents:resuming",
    "subagents:completed",
    "subagents:failed",
    "subagents:resumed",
  ]) {
    pi.events.on(channel, (event) => {
      const parent = gotgenesParent;
      const record = event?.id ? parent?.service?.getRecord?.(event.id) : undefined;
      if (!record || typeof record.startedAt !== "number") return;
      const running = channel === "subagents:started" || channel === "subagents:resuming";
      parent.ctx.ui.notify(
        "${GOTGENES_LIFECYCLE_MARKER} " +
          JSON.stringify({
            agentId: record.id,
            status: running ? "running" : (event.status ?? record.status),
            startedAt: record.startedAt,
          }),
        "info",
      );
    });
  }
`;
