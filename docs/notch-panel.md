# Notch panel

The macOS desktop app draws a panel under the MacBook notch: a small board of every connected host,
with what needs you on top (approvals answered in place) and running, to-review and recent chats below.

## Who owns what

- A main Paseo window builds the content (`packages/app/src/desktop/notch-panel/`) from the session
  store it already keeps for every host, translates it, and publishes it over IPC. The panel holds
  no host connections, so it costs no extra sockets or memory.
- The main process (`packages/desktop/src/features/notch-panel/`) owns the panel window and relays
  button presses: `open` goes through the desktop window owner, `respond` goes back to the
  publishing window, which answers the permission as it currently stands.
- The panel page is plain DOM serialised from `runNotchPanel` with `Function#toString`. Keep that
  function free of imports and outer variables.

## Gotchas

- Electron has no notch API. `geometry.ts` asks AppKit through `osascript -l JavaScript`
  (`safeAreaInsets`, `auxiliaryTopLeftArea/RightArea`). If that fails, the panel becomes a pill in
  the primary menu bar that only appears when there is something to show.
- The window is larger than the island and ignores the mouse with `forward: true`; the page turns
  interaction on only while the pointer is over the island. Without this, the transparent part
  would swallow clicks on the menu bar and the app below.
- `type: "panel"` keeps clicks from activating Paseo. `setVisibleOnAllWorkspaces` needs
  `skipTransformProcessType`, or macOS hides the Dock icon.
- `BrowserWindow.getAllWindows()` includes the panel. Code that picks "the" app window must skip
  it with `isNotchPanelWindow`.
- The panel shows only while a main window is open; it closes with the last one.
