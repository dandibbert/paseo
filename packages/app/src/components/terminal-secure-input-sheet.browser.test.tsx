import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { TerminalSecureInputSheet } from "./terminal-secure-input-sheet";

const roots: Root[] = [];
const noop = () => {};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

function mountSheet(onSubmit: (secret: string, newline: boolean) => Promise<void>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<TerminalSecureInputSheet supported onClose={noop} onSubmit={onSubmit} />));
}

function field(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    "[data-testid='terminal-secure-input-field']",
  );
  if (!input) throw new Error("secure input field not rendered");
  return input;
}

describe("terminal secure input sheet", () => {
  it("sends the secret with Enter", async () => {
    const onSubmit = vi.fn(async () => {});
    mountSheet(onSubmit);
    await userEvent.type(field(), "s3cret-token");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("s3cret-token", true));
  });

  it("focuses the field when it opens", () => {
    mountSheet(async () => noop());
    expect(document.activeElement).toBe(field());
  });
});
