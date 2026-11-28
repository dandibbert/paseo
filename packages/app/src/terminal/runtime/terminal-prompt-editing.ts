/**
 * Mouse editing of the shell command line. The shell's line editor owns the input, so the
 * terminal can only move its cursor and delete with keys: a click becomes arrow presses and a
 * selection plus Backspace becomes arrow presses and backspaces. The command line is the text
 * after the shell integration's OSC 633 B mark, until the command runs (C) or the next prompt (A).
 */

/** A buffer cell: `x` is the 0-based column, `y` the 0-based absolute buffer row. */
export interface BufferCellPosition {
  x: number;
  y: number;
}

interface PromptBufferCell {
  getWidth(): number;
  getChars(): string;
}

interface PromptBufferLine {
  readonly isWrapped: boolean;
  getCell(x: number): PromptBufferCell | undefined;
}

/** The part of xterm's `IBuffer` this module reads; both `@xterm/xterm` and headless fit it. */
export interface PromptBuffer {
  getLine(y: number): PromptBufferLine | undefined;
}

export interface PromptLayout {
  buffer: PromptBuffer;
  cols: number;
  /** Where the command line starts (the OSC 633 B mark). */
  inputStart: BufferCellPosition;
  cursor: BufferCellPosition;
}

export interface SelectionDeletePlan {
  /** Arrow presses that put the cursor at the selection's end; negative moves left. */
  move: number;
  /** Backspaces that remove the selected characters. */
  deletes: number;
}

const BACKSPACE = "\x7f";
const NORMAL_ARROWS = { left: "\x1b[D", right: "\x1b[C" };
const APPLICATION_ARROWS = { left: "\x1bOD", right: "\x1bOC" };

export function cursorMoveSequence(steps: number, applicationCursorKeys: boolean): string {
  if (steps === 0) return "";
  const arrows = applicationCursorKeys ? APPLICATION_ARROWS : NORMAL_ARROWS;
  return (steps > 0 ? arrows.right : arrows.left).repeat(Math.abs(steps));
}

export function selectionDeleteSequence(
  plan: SelectionDeletePlan,
  applicationCursorKeys: boolean,
): string {
  return cursorMoveSequence(plan.move, applicationCursorKeys) + BACKSPACE.repeat(plan.deletes);
}

/** Arrow presses that move the shell cursor to `target`, or null when the click is not on the command line. */
export function planCursorMove(layout: PromptLayout, target: BufferCellPosition): number | null {
  const end = commandLineEnd(layout);
  if (!end || !isWithin(layout, layout.cursor, end)) return null;
  const clamped = clampToCommandLine(layout, snapToCellStart(layout, target), end);
  if (!clamped) return null;
  return characterSteps(layout, layout.cursor, clamped);
}

/**
 * Removes a selection that lies on the command line: move to its end, then backspace over it.
 * `selectionEnd` is exclusive. Returns null when any part of the selection is outside the line.
 */
export function planSelectionDelete(
  layout: PromptLayout,
  selectionStart: BufferCellPosition,
  selectionEnd: BufferCellPosition,
): SelectionDeletePlan | null {
  const end = commandLineEnd(layout);
  if (!end || !isWithin(layout, layout.cursor, end)) return null;
  const start = snapToCellStart(layout, selectionStart);
  if (compare(start, layout.inputStart) < 0 || compare(start, end) > 0) return null;
  // A selection that runs past the typed text, onto the blank rest of the row, ends at the text.
  const stop = compare(selectionEnd, end) > 0 ? end : snapToCellStart(layout, selectionEnd);
  const deletes = characterSteps(layout, start, stop);
  if (deletes === null || deletes <= 0) return null;
  const move = characterSteps(layout, layout.cursor, stop);
  if (move === null) return null;
  return { move, deletes };
}

function compare(a: BufferCellPosition, b: BufferCellPosition): number {
  return a.y === b.y ? a.x - b.x : a.y - b.y;
}

function isWithin(
  layout: PromptLayout,
  position: BufferCellPosition,
  end: BufferCellPosition,
): boolean {
  return compare(position, layout.inputStart) >= 0 && compare(position, end) <= 0;
}

/** The second column of a wide character belongs to the character in the column before it. */
function snapToCellStart(layout: PromptLayout, position: BufferCellPosition): BufferCellPosition {
  const cell = layout.buffer.getLine(position.y)?.getCell(position.x);
  if (cell && cell.getWidth() === 0 && position.x > 0) return { x: position.x - 1, y: position.y };
  return position;
}

/**
 * The position just after the last typed character. The command line is the input row plus the
 * rows that soft-wrap from it; a hard line break ends it, because a multi-line command's
 * continuation prompt sits between its lines and cannot be stepped over with arrows.
 */
function commandLineEnd(layout: PromptLayout): BufferCellPosition | null {
  const { buffer, cols, inputStart } = layout;
  if (!buffer.getLine(inputStart.y)) return null;
  let end: BufferCellPosition = { ...inputStart };
  for (let y = inputStart.y; ; y += 1) {
    const line = buffer.getLine(y);
    if (!line || (y > inputStart.y && !line.isWrapped)) break;
    for (let x = y === inputStart.y ? inputStart.x : 0; x < cols; x += 1) {
      const cell = line.getCell(x);
      if (cell && cell.getChars() !== "") end = { x: x + Math.max(cell.getWidth(), 1), y };
    }
  }
  if (end.x >= cols && buffer.getLine(end.y + 1)?.isWrapped) end = { x: 0, y: end.y + 1 };
  return end;
}

function clampToCommandLine(
  layout: PromptLayout,
  target: BufferCellPosition,
  end: BufferCellPosition,
): BufferCellPosition | null {
  if (compare(target, layout.inputStart) < 0) return null;
  if (target.y > end.y)
    return target.y === end.y + 1 && isSoftWrapRow(layout, target.y) ? end : null;
  return compare(target, end) > 0 ? end : target;
}

function isSoftWrapRow(layout: PromptLayout, y: number): boolean {
  return y > layout.inputStart.y && layout.buffer.getLine(y)?.isWrapped === true;
}

/** Characters between two positions on the command line, signed by direction; null across a hard break. */
function characterSteps(
  layout: PromptLayout,
  from: BufferCellPosition,
  to: BufferCellPosition,
): number | null {
  const order = compare(from, to);
  if (order === 0) return 0;
  const [first, last] = order < 0 ? [from, to] : [to, from];
  let count = 0;
  for (let y = first.y; y <= last.y; y += 1) {
    const line = layout.buffer.getLine(y);
    if (!line || (y > first.y && !line.isWrapped)) return null;
    const startX = y === first.y ? first.x : 0;
    const endX = y === last.y ? last.x : layout.cols;
    for (let x = startX; x < endX; x += 1) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      // A wide character that did not fit leaves the row's last column empty and wraps whole.
      if (x === layout.cols - 1 && y < last.y && cell.getChars() === "") {
        const next = layout.buffer.getLine(y + 1)?.getCell(0);
        if (next && next.getWidth() === 2) continue;
      }
      count += 1;
    }
  }
  return order < 0 ? count : -count;
}

interface CommandLineStart {
  marker: { readonly line: number; readonly isDisposed: boolean; dispose(): void };
  x: number;
}

/** The parts of xterm's `Terminal` the editor uses. */
export interface PromptEditingTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | undefined;
  readonly buffer: {
    readonly active: PromptBuffer & {
      readonly type: "normal" | "alternate";
      readonly cursorX: number;
      readonly cursorY: number;
      readonly baseY: number;
      readonly viewportY: number;
    };
  };
  readonly modes: {
    readonly applicationCursorKeysMode: boolean;
    readonly mouseTrackingMode: string;
  };
  readonly parser: {
    registerOscHandler(ident: number, callback: (data: string) => boolean): { dispose(): void };
  };
  registerMarker(cursorYOffset?: number): CommandLineStart["marker"] | undefined;
  hasSelection(): boolean;
  getSelectionPosition(): { start: BufferCellPosition; end: BufferCellPosition } | undefined;
  clearSelection(): void;
  input(data: string, wasUserInput?: boolean): void;
}

/**
 * Tracks the shell command line through OSC 633 and turns clicks and Backspace over a selection on
 * it into the keys the shell's line editor understands. Without the shell integration's B mark
 * (another shell, a replay that dropped it, a program in the foreground) it does nothing.
 */
export class ShellCommandLineEditor {
  private start: CommandLineStart | null = null;
  private readonly oscHandler: { dispose(): void };

  constructor(private readonly terminal: PromptEditingTerminal) {
    this.oscHandler = terminal.parser.registerOscHandler(633, (data) => {
      this.handleShellIntegration(data);
      // Other OSC 633 readers, such as the daemon's command-finished parser, still see it.
      return false;
    });
  }

  dispose(): void {
    this.oscHandler.dispose();
    this.clear();
  }

  /** Moves the shell cursor to the clicked cell when the click lands on the command line. */
  moveCursorToPoint(clientX: number, clientY: number): boolean {
    const prompt = this.layout();
    const target = prompt ? this.cellAtPoint(clientX, clientY) : null;
    if (!prompt || !target) return false;
    const steps = planCursorMove(prompt, target);
    if (!steps) return false;
    this.terminal.input(
      cursorMoveSequence(steps, this.terminal.modes.applicationCursorKeysMode),
      true,
    );
    return true;
  }

  /** Deletes the selection with Backspace when it lies on the command line. */
  deleteSelection(): boolean {
    const prompt = this.layout();
    const selection =
      prompt && this.terminal.hasSelection() ? this.terminal.getSelectionPosition() : undefined;
    if (!prompt || !selection) return false;
    const plan = planSelectionDelete(prompt, selection.start, selection.end);
    if (!plan) return false;
    this.terminal.clearSelection();
    this.terminal.input(
      selectionDeleteSequence(plan, this.terminal.modes.applicationCursorKeysMode),
      true,
    );
    return true;
  }

  private handleShellIntegration(data: string): void {
    const kind = data.split(";", 1)[0];
    if (kind === "B") {
      this.clear();
      const marker = this.terminal.registerMarker(0);
      if (marker) this.start = { marker, x: this.terminal.buffer.active.cursorX };
    } else if (kind === "A" || kind === "C" || kind === "D") {
      this.clear();
    }
  }

  private clear(): void {
    this.start?.marker.dispose();
    this.start = null;
  }

  private layout(): PromptLayout | null {
    const start = this.start;
    const buffer = this.terminal.buffer.active;
    if (!start || start.marker.isDisposed || start.marker.line < 0) return null;
    // A full-screen program or a program reading the mouse owns the screen, not the shell.
    if (buffer.type !== "normal" || this.terminal.modes.mouseTrackingMode !== "none") return null;
    return {
      buffer,
      cols: this.terminal.cols,
      inputStart: { x: start.x, y: start.marker.line },
      cursor: { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY },
    };
  }

  private cellAtPoint(clientX: number, clientY: number): BufferCellPosition | null {
    const screen = this.terminal.element?.querySelector(".xterm-screen");
    if (!screen) return null;
    const rect = screen.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const column = Math.floor(((clientX - rect.left) / rect.width) * this.terminal.cols);
    const row = Math.floor(((clientY - rect.top) / rect.height) * this.terminal.rows);
    if (column < 0 || column >= this.terminal.cols || row < 0 || row >= this.terminal.rows) {
      return null;
    }
    return { x: column, y: this.terminal.buffer.active.viewportY + row };
  }
}
