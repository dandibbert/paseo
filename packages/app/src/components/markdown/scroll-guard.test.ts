import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMarkdownScrollGuard, MARKDOWN_SCROLL_LINK_COOLDOWN_MS } from "./scroll-guard";

describe("createMarkdownScrollGuard", () => {
  it("does not suppress taps before any scroll interaction", () => {
    const guard = createMarkdownScrollGuard();
    assert.equal(guard.isSuppressed(1000), false);
  });

  it("suppresses taps while dragging and for the cooldown after drag ends", () => {
    const guard = createMarkdownScrollGuard(200);
    guard.beginDrag(1000);
    assert.equal(guard.isSuppressed(1050), true);

    guard.endDrag(1100);
    assert.equal(guard.isSuppressed(1150), true);
    assert.equal(guard.isSuppressed(1299), true);
    assert.equal(guard.isSuppressed(1300), false);
  });

  it("keeps suppressing across momentum scroll until momentum settles plus cooldown", () => {
    const guard = createMarkdownScrollGuard();
    guard.beginDrag(1000);
    guard.endDrag(1050);
    guard.beginMomentum(1055);
    assert.equal(guard.isSuppressed(1500), true);

    guard.noteScroll(1600);
    guard.endMomentum(1700);
    assert.equal(guard.isSuppressed(1700 + MARKDOWN_SCROLL_LINK_COOLDOWN_MS - 1), true);
    assert.equal(guard.isSuppressed(1700 + MARKDOWN_SCROLL_LINK_COOLDOWN_MS), false);
  });
});
