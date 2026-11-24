import type { AgentShellContextEntry, AgentShellContextSummary } from "@getpaseo/protocol/messages";

/** The wire form of a pending shell context entry: everything except its output. */
export function summarizeShellContextEntry(
  entry: AgentShellContextEntry,
): AgentShellContextSummary {
  const { output: _output, ...summary } = entry;
  return summary;
}
