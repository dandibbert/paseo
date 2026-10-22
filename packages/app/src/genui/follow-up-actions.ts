// Where a card's follow-up buttons send their prompt. Null when the timeline is read-only,
// in which case the buttons are not drawn at all.
export interface RenderUiActionTarget {
  serverId: string;
  agentId: string;
  // The timeline item of the render_ui call, to tell whether it is still the latest turn.
  itemId: string;
}

export type FollowUpAvailability = "hidden" | "disabled" | "enabled";

// Buttons are pressable only on the latest turn, once the agent has finished it, while
// the host is connected and nothing from this card has been sent yet.
export function resolveFollowUpAvailability(input: {
  // isLatestTurn is false once the user has sent another message after this card: the
  // choice it offered is no longer the open question.
  target: (RenderUiActionTarget & { isLatestTurn: boolean }) | null;
  agentBusy: boolean;
  connected: boolean;
  sending: boolean;
  sentLabel: string | null;
}): FollowUpAvailability {
  if (!input.target) {
    return "hidden";
  }
  if (
    !input.target.isLatestTurn ||
    input.agentBusy ||
    !input.connected ||
    input.sending ||
    input.sentLabel !== null
  ) {
    return "disabled";
  }
  return "enabled";
}

interface TimelineEntry {
  id: string;
  kind: string;
}

// Whether `itemId` comes after the last user message across the committed tail and the
// live head, i.e. belongs to the current turn. Scans from the end, so the cost is the
// length of the current turn, not of the history.
export function isInCurrentTurn(input: {
  tail: readonly TimelineEntry[];
  head: readonly TimelineEntry[];
  itemId: string;
}): boolean {
  for (const items of [input.head, input.tail]) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.id === input.itemId) {
        return true;
      }
      if (item.kind === "user_message") {
        return false;
      }
    }
  }
  return false;
}
