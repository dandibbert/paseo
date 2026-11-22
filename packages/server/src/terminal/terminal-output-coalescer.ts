export interface TerminalOutputCoalescerTimers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export interface TerminalOutputCoalescerFlush {
  payload: Buffer;
  chars: number;
  bytes: number;
}

export interface TerminalOutputCoalescerOptions {
  timers: TerminalOutputCoalescerTimers;
  flushDelayMs?: number;
  now?: () => number;
  onFlush: (payload: TerminalOutputCoalescerFlush) => void;
}

const DEFAULT_FLUSH_DELAY_MS = 5;
const DEFAULT_SYNC_HOLD_MS = 32;
const BULK_LEADING_EDGE_DEFER_BYTES = 128;
const ESC = String.fromCharCode(0x1b);
const SYNC_OUTPUT_ENABLE = `${ESC}[?2026h`;
const SYNC_OUTPUT_DISABLE = `${ESC}[?2026l`;
const SYNC_TAIL_LENGTH = SYNC_OUTPUT_ENABLE.length - 1;
const SCREEN_OR_FULL_LINE_ERASE_RE = new RegExp(
  `${ESC}\\[(?:[0-3]?J|[12]K|\\?(?:47|1047|1049)[hl])`,
);
const CURSOR_REPOSITION_RE = new RegExp(`${ESC}\\[[0-9;]*[AHf]`);
const LINE_ERASE_RE = new RegExp(`${ESC}\\[[0-2]?K`, "g");

function shouldDeferLeadingEdgeFlush(data: string, byteLength: number): boolean {
  if (byteLength >= BULK_LEADING_EDGE_DEFER_BYTES) {
    return true;
  }
  if (SCREEN_OR_FULL_LINE_ERASE_RE.test(data)) {
    return true;
  }
  const erases = data.match(LINE_ERASE_RE);
  if (!erases) {
    return false;
  }
  // Single small line erase (e.g. interactive Backspace \b\x1b[K) stays 0ms;
  // multiple line erases or cursor-up/home + erase indicates a multi-line redraw.
  return erases.length >= 2 || CURSOR_REPOSITION_RE.test(data);
}

export class TerminalOutputCoalescer {
  private readonly timers: TerminalOutputCoalescerTimers;
  private readonly flushDelayMs: number;
  private readonly syncHoldMs: number;
  private readonly now: () => number;
  private readonly onFlush: (payload: TerminalOutputCoalescerFlush) => void;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private chars = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimerIsSyncHold = false;
  private lastFlushAt: number | null = null;
  private inSynchronizedOutput = false;
  private syncSequenceTail = "";

  constructor(options: TerminalOutputCoalescerOptions) {
    this.timers = options.timers;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.syncHoldMs = Math.max(this.flushDelayMs, DEFAULT_SYNC_HOLD_MS);
    this.now = options.now ?? Date.now;
    this.onFlush = options.onFlush;
  }

  handle(data: string): void {
    if (data.length === 0) {
      return;
    }

    const wasInSynchronizedOutput = this.inSynchronizedOutput;
    this.updateSynchronizedOutputState(data);
    const closedSynchronizedOutput = wasInSynchronizedOutput && !this.inSynchronizedOutput;

    const chunk = Buffer.from(data, "utf8");
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    this.chars += data.length;

    if (closedSynchronizedOutput) {
      this.flush();
      return;
    }

    if (this.inSynchronizedOutput) {
      if (!this.flushTimer || !this.flushTimerIsSyncHold) {
        this.clearTimer();
        this.flushTimerIsSyncHold = true;
        this.flushTimer = this.timers.setTimeout(() => {
          this.flushTimer = null;
          this.flushTimerIsSyncHold = false;
          this.inSynchronizedOutput = false;
          this.flush();
        }, this.syncHoldMs);
      }
      return;
    }

    // Leading edge: if nothing is pending and no flush happened within the last
    // flushDelayMs, flush simple interactive echo immediately so typing stays
    // low-latency. TUI redraws and bulk chunks defer onto the short trailing
    // window so split PTY reads recombine before painting.
    if (!this.flushTimer) {
      const elapsed =
        this.lastFlushAt === null ? Number.POSITIVE_INFINITY : this.now() - this.lastFlushAt;
      if (elapsed >= this.flushDelayMs && !shouldDeferLeadingEdgeFlush(data, chunk.byteLength)) {
        this.flush();
        return;
      }
      this.flushTimerIsSyncHold = false;
      this.flushTimer = this.timers.setTimeout(() => {
        this.flushTimer = null;
        this.flushTimerIsSyncHold = false;
        this.flush();
      }, this.flushDelayMs);
    }
  }

  flush(): void {
    this.clearTimer();

    if (this.chunks.length === 0) {
      return;
    }

    const payload =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.bytes);
    const bytes = this.bytes;
    const chars = this.chars;
    this.clearPending();
    this.lastFlushAt = this.now();

    this.onFlush({ payload, bytes, chars });
  }

  // Record that a frame was emitted out-of-band on this stream (e.g. a snapshot
  // frame sent directly, bypassing the coalescer). This keeps the next handled
  // chunk on the trailing path instead of leading-edge flushing it back-to-back
  // with that frame, preserving the small gap consumers rely on after a snapshot.
  markFlushed(): void {
    this.lastFlushAt = this.now();
  }

  dispose(): void {
    this.clearTimer();
    this.clearPending();
    this.inSynchronizedOutput = false;
    this.syncSequenceTail = "";
  }

  private updateSynchronizedOutputState(data: string): void {
    const combined = `${this.syncSequenceTail}${data}`;
    const lastEnable = combined.lastIndexOf(SYNC_OUTPUT_ENABLE);
    const lastDisable = combined.lastIndexOf(SYNC_OUTPUT_DISABLE);
    if (lastEnable > lastDisable) {
      this.inSynchronizedOutput = true;
    } else if (lastDisable > lastEnable) {
      this.inSynchronizedOutput = false;
    }
    this.syncSequenceTail = combined.slice(-SYNC_TAIL_LENGTH);
  }

  private clearTimer(): void {
    if (!this.flushTimer) {
      return;
    }
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flushTimerIsSyncHold = false;
  }

  private clearPending(): void {
    this.chunks = [];
    this.bytes = 0;
    this.chars = 0;
  }
}
