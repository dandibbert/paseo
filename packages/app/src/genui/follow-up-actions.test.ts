import { describe, expect, it } from "vitest";
import { isInCurrentTurn, resolveFollowUpAvailability } from "./follow-up-actions";

const target = { serverId: "s", agentId: "a", itemId: "card", isLatestTurn: true };
const ready = { target, agentBusy: false, connected: true, sending: false, sentLabel: null };

describe("resolveFollowUpAvailability", () => {
  it("hides buttons in a read-only timeline", () => {
    expect(resolveFollowUpAvailability({ ...ready, target: null })).toBe("hidden");
  });

  it("enables buttons on the finished latest turn", () => {
    expect(resolveFollowUpAvailability(ready)).toBe("enabled");
  });

  it("disables buttons while the agent runs, after a later message, offline, or once sent", () => {
    expect(resolveFollowUpAvailability({ ...ready, agentBusy: true })).toBe("disabled");
    expect(
      resolveFollowUpAvailability({ ...ready, target: { ...target, isLatestTurn: false } }),
    ).toBe("disabled");
    expect(resolveFollowUpAvailability({ ...ready, connected: false })).toBe("disabled");
    expect(resolveFollowUpAvailability({ ...ready, sending: true })).toBe("disabled");
    expect(resolveFollowUpAvailability({ ...ready, sentLabel: "Go" })).toBe("disabled");
  });
});

describe("isInCurrentTurn", () => {
  const tail = [
    { id: "u1", kind: "user_message" },
    { id: "card-old", kind: "tool_call" },
    { id: "u2", kind: "user_message" },
    { id: "card-new", kind: "tool_call" },
  ];

  it("finds cards after the last user message in the tail or the live head", () => {
    expect(isInCurrentTurn({ tail, head: [], itemId: "card-new" })).toBe(true);
    expect(
      isInCurrentTurn({ tail, head: [{ id: "live", kind: "tool_call" }], itemId: "live" }),
    ).toBe(true);
  });

  it("rejects cards from earlier turns, including once a new message is in the head", () => {
    expect(isInCurrentTurn({ tail, head: [], itemId: "card-old" })).toBe(false);
    expect(
      isInCurrentTurn({ tail, head: [{ id: "u3", kind: "user_message" }], itemId: "card-new" }),
    ).toBe(false);
  });
});
