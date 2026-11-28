import { Terminal } from "@xterm/headless";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { describe, expect, it } from "vitest";
import {
  cursorMoveSequence,
  planCursorMove,
  planSelectionDelete,
  selectionDeleteSequence,
  type BufferCellPosition,
  type PromptLayout,
} from "./terminal-prompt-editing";

const COLS = 20;

async function promptTerminal(output: string): Promise<Terminal> {
  const terminal = new Terminal({ cols: COLS, rows: 6, allowProposedApi: true });
  terminal.loadAddon(new UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = "15-graphemes";
  await new Promise<void>((resolve) => terminal.write(output, resolve));
  return terminal;
}

function layout(terminal: Terminal, inputStart: BufferCellPosition): PromptLayout {
  const buffer = terminal.buffer.active;
  return {
    buffer,
    cols: terminal.cols,
    inputStart,
    cursor: { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY },
  };
}

describe("planCursorMove", () => {
  it("counts the characters between the cursor and the click on the command line", async () => {
    const terminal = await promptTerminal("$ echo hello");
    const prompt = layout(terminal, { x: 2, y: 0 });
    expect(prompt.cursor).toEqual({ x: 12, y: 0 });
    expect(planCursorMove(prompt, { x: 7, y: 0 })).toBe(-5);
    expect(planCursorMove(prompt, { x: 2, y: 0 })).toBe(-10);
  });

  it("moves right from a cursor in the middle of the line", async () => {
    const terminal = await promptTerminal("$ echo hello\x1b[6D");
    const prompt = layout(terminal, { x: 2, y: 0 });
    expect(prompt.cursor).toEqual({ x: 6, y: 0 });
    expect(planCursorMove(prompt, { x: 10, y: 0 })).toBe(4);
  });

  it("puts a click past the typed text at its end", async () => {
    const terminal = await promptTerminal("$ echo hi\x1b[4D");
    const prompt = layout(terminal, { x: 2, y: 0 });
    expect(planCursorMove(prompt, { x: 18, y: 0 })).toBe(4);
  });

  it("ignores clicks on the prompt and on the output above it", async () => {
    const terminal = await promptTerminal("old output\r\n$ echo hi");
    const prompt = layout(terminal, { x: 2, y: 1 });
    expect(planCursorMove(prompt, { x: 0, y: 1 })).toBeNull();
    expect(planCursorMove(prompt, { x: 3, y: 0 })).toBeNull();
  });

  it("steps over a wide character once and snaps a click on its second column", async () => {
    const terminal = await promptTerminal("$ 中文ab");
    const prompt = layout(terminal, { x: 2, y: 0 });
    expect(prompt.cursor).toEqual({ x: 8, y: 0 });
    expect(planCursorMove(prompt, { x: 2, y: 0 })).toBe(-4);
    expect(planCursorMove(prompt, { x: 5, y: 0 })).toBe(-3);
  });

  it("follows a command line that soft-wraps onto the next row", async () => {
    const terminal = await promptTerminal(`$ ${"a".repeat(25)}`);
    const prompt = layout(terminal, { x: 2, y: 0 });
    expect(prompt.cursor).toEqual({ x: 7, y: 1 });
    // Ten characters left on the first row, seven on the wrapped one.
    expect(planCursorMove(prompt, { x: 10, y: 0 })).toBe(-17);
    expect(planCursorMove(prompt, { x: 3, y: 1 })).toBe(-4);
  });

  it("does not cross a hard line break into a continuation prompt", async () => {
    const terminal = await promptTerminal("$ echo 'a\r\n> b");
    const prompt = layout(terminal, { x: 2, y: 0 });
    expect(planCursorMove(prompt, { x: 4, y: 0 })).toBeNull();
  });

  it("returns null when the cursor has left the command line", async () => {
    const terminal = await promptTerminal("$ echo hi\r\nhi\r\n");
    const prompt = layout(terminal, { x: 2, y: 0 });
    expect(planCursorMove(prompt, { x: 4, y: 0 })).toBeNull();
  });
});

describe("planSelectionDelete", () => {
  it("moves to the selection's end and backspaces over it", async () => {
    const terminal = await promptTerminal("$ echo hello world");
    const prompt = layout(terminal, { x: 2, y: 0 });
    // "hello " spans columns 7 to 12.
    expect(planSelectionDelete(prompt, { x: 7, y: 0 }, { x: 13, y: 0 })).toEqual({
      move: -5,
      deletes: 6,
    });
  });

  it("stops a selection that runs past the text at the end of the text", async () => {
    const terminal = await promptTerminal("$ echo hi");
    const prompt = layout(terminal, { x: 2, y: 0 });
    expect(planSelectionDelete(prompt, { x: 7, y: 0 }, { x: 0, y: 1 })).toEqual({
      move: 0,
      deletes: 2,
    });
  });

  it("counts a selected wide character once", async () => {
    const terminal = await promptTerminal("$ ls 中文 x");
    const prompt = layout(terminal, { x: 2, y: 0 });
    expect(planSelectionDelete(prompt, { x: 5, y: 0 }, { x: 9, y: 0 })).toEqual({
      move: -2,
      deletes: 2,
    });
  });

  it("leaves a selection that reaches into the prompt or the output alone", async () => {
    const terminal = await promptTerminal("old\r\n$ echo hi");
    const prompt = layout(terminal, { x: 2, y: 1 });
    expect(planSelectionDelete(prompt, { x: 0, y: 1 }, { x: 6, y: 1 })).toBeNull();
    expect(planSelectionDelete(prompt, { x: 1, y: 0 }, { x: 6, y: 1 })).toBeNull();
  });
});

describe("key sequences", () => {
  it("uses the arrow encoding of the cursor key mode", () => {
    expect(cursorMoveSequence(2, false)).toBe("\x1b[C\x1b[C");
    expect(cursorMoveSequence(-1, true)).toBe("\x1bOD");
    expect(cursorMoveSequence(0, false)).toBe("");
    expect(selectionDeleteSequence({ move: -1, deletes: 2 }, false)).toBe("\x1b[D\x7f\x7f");
  });
});
