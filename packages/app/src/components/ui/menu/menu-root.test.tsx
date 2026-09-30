/**
 * @vitest-environment jsdom
 */
import React, { createRef } from "react";
import { createPortal } from "react-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Text, type View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot, MenuTrigger } from "./menu-root";
import { MenuSurface } from "./menu-surface";
import { MenuItem } from "./menu-item";
import { useWebOverlayRegistration } from "@/lib/overlay-root";

beforeEach(() => vi.stubGlobal("React", React));

describe("MenuTrigger", () => {
  it("forwards its rendered trigger to callers", () => {
    const triggerRef = createRef<View>();

    render(
      <MenuRoot>
        <MenuTrigger ref={triggerRef} accessibilityLabel="Open menu">
          <Text>Open</Text>
        </MenuTrigger>
      </MenuRoot>,
    );

    expect(triggerRef.current).not.toBeNull();
  });
});

// JSDOM cannot measure a Gorhom sheet. Keep its imperative visibility and a real DOM portal,
// while exercising the actual MenuSheetSurface, item handlers, and overlay keyboard registry.
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => true,
}));
vi.mock("@gorhom/bottom-sheet", async (importOriginal) => {
  const original = await importOriginal<typeof import("@gorhom/bottom-sheet")>();
  return {
    ...original,
    BottomSheetModal: React.forwardRef<
      { present: () => void; dismiss: () => void },
      { children?: React.ReactNode; onChange?: (index: number) => void; onDismiss?: () => void }
    >(function TestSheet({ children, onChange, onDismiss }, ref) {
      const [visible, setVisible] = React.useState(false);
      React.useImperativeHandle(
        ref,
        () => ({
          present: () => {
            setVisible(true);
            onChange?.(0);
          },
          dismiss: () => {
            setVisible(false);
            onDismiss?.();
          },
        }),
        [onChange, onDismiss],
      );
      return visible ? createPortal(<div data-test-sheet>{children}</div>, document.body) : null;
    }),
  };
});

function CompactMenuFixture({ onSelect }: { onSelect: () => void }) {
  return (
    <MenuRoot compactMode="sheet">
      <MenuTrigger accessibilityRole="button" accessibilityLabel="Agent actions">
        <Text>Actions</Text>
      </MenuTrigger>
      <MenuSurface sheetTitle="Agent actions">
        <MenuItem onSelect={onSelect}>Open agent</MenuItem>
        <MenuItem disabled>Unavailable</MenuItem>
        <MenuItem onSelect={onSelect}>Rename agent</MenuItem>
      </MenuSurface>
    </MenuRoot>
  );
}

function HigherOverlay({ onClose }: { onClose: () => void }) {
  const close = React.useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      onClose();
      return true;
    },
    [onClose],
  );
  const scope = useWebOverlayRegistration({ active: true, layer: 40, onKeyDown: close });
  return (
    <div ref={scope} tabIndex={-1}>
      <button type="button">Dialog action</button>
    </div>
  );
}

function StackedMenuFixture({ onSelect }: { onSelect: () => void }) {
  const [dialog, setDialog] = React.useState(false);
  const openDialog = React.useCallback(() => setDialog(true), []);
  const closeDialog = React.useCallback(() => setDialog(false), []);
  return (
    <>
      <button type="button" onClick={openDialog}>
        Show dialog
      </button>
      <CompactMenuFixture onSelect={onSelect} />
      {dialog ? <HigherOverlay onClose={closeDialog} /> : null}
    </>
  );
}

describe("compact web menu keyboard ownership", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("dismisses a sheet on Escape, restores its trigger focus, and can reopen without selecting", async () => {
    const select = vi.fn();
    const view = render(<CompactMenuFixture onSelect={select} />);
    const trigger = view.getByRole("button", { name: "Agent actions" });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(view.getByRole("menuitem", { name: "Open agent" })).not.toBeNull());
    const restoreFocus = vi.spyOn(trigger, "focus");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("menuitem", { name: "Open agent" })).toBeNull());
    expect(restoreFocus).toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    await waitFor(() => expect(view.getByRole("menuitem", { name: "Open agent" })).not.toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("menuitem", { name: "Open agent" })).toBeNull());
    expect(select).not.toHaveBeenCalled();
  });

  it("shares arrow navigation and keyboard selection with popovers", async () => {
    const select = vi.fn();
    const view = render(<CompactMenuFixture onSelect={select} />);
    fireEvent.click(view.getByRole("button", { name: "Agent actions" }));
    const open = await view.findByRole("menuitem", { name: "Open agent" });
    open.focus();
    fireEvent.keyDown(open, { key: "ArrowDown" });
    const rename = view.getByRole("menuitem", { name: "Rename agent" });
    expect(document.activeElement).toBe(rename);
    fireEvent.keyDown(rename, { key: "Enter" });
    await waitFor(() => expect(view.queryByRole("menuitem", { name: "Open agent" })).toBeNull());
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("leaves the sheet open when Escape belongs to a higher overlay", async () => {
    const select = vi.fn();
    const view = render(<StackedMenuFixture onSelect={select} />);
    fireEvent.click(view.getByRole("button", { name: "Agent actions" }));
    await view.findByRole("menuitem", { name: "Open agent" });
    fireEvent.click(view.getByRole("button", { name: "Show dialog" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(view.queryByRole("button", { name: "Dialog action" })).toBeNull();
    expect(view.getByRole("menuitem", { name: "Open agent" })).not.toBeNull();
    expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("menuitem", { name: "Open agent" })).toBeNull());
  });
});
