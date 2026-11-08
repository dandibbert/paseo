import { describe, expect, it } from "vitest";
import { feedbackDelivery } from "./use-feedback";

describe("feedbackDelivery", () => {
  it("queues feedback for a running agent when the send setting is Queue", () => {
    expect(feedbackDelivery("queue", true)).toBe("queue");
  });

  it("sends feedback straight to an idle agent whatever the setting", () => {
    expect(feedbackDelivery("queue", false)).not.toBe("queue");
    expect(feedbackDelivery("steer", false)).toBe("steer");
  });

  it("keeps steer and interrupt for a running agent", () => {
    expect(feedbackDelivery("steer", true)).toBe("steer");
    expect(feedbackDelivery("interrupt", true)).toBe("interrupt");
  });
});
