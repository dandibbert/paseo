import { createContext, useContext, type ReactElement, type ReactNode } from "react";

export const MARKDOWN_SCROLL_LINK_COOLDOWN_MS = 220;

export interface MarkdownScrollGuard {
  beginDrag: (nowMs?: number) => void;
  endDrag: (nowMs?: number) => void;
  beginMomentum: (nowMs?: number) => void;
  endMomentum: (nowMs?: number) => void;
  noteScroll: (nowMs?: number) => void;
  isSuppressed: (nowMs?: number) => boolean;
}

export function createMarkdownScrollGuard(
  cooldownMs = MARKDOWN_SCROLL_LINK_COOLDOWN_MS,
): MarkdownScrollGuard {
  let dragging = false;
  let momentum = false;
  let lastActivityAtMs = -Infinity;

  return {
    beginDrag(nowMs = Date.now()) {
      dragging = true;
      lastActivityAtMs = nowMs;
    },
    endDrag(nowMs = Date.now()) {
      dragging = false;
      lastActivityAtMs = nowMs;
    },
    beginMomentum(nowMs = Date.now()) {
      momentum = true;
      lastActivityAtMs = nowMs;
    },
    endMomentum(nowMs = Date.now()) {
      dragging = false;
      momentum = false;
      lastActivityAtMs = nowMs;
    },
    noteScroll(nowMs = Date.now()) {
      lastActivityAtMs = nowMs;
    },
    isSuppressed(nowMs = Date.now()) {
      if (dragging || momentum) {
        return true;
      }
      return nowMs - lastActivityAtMs < cooldownMs;
    },
  };
}

const MarkdownScrollGuardContext = createContext<MarkdownScrollGuard | null>(null);

export function MarkdownScrollGuardProvider({
  value,
  children,
}: {
  value: MarkdownScrollGuard;
  children: ReactNode;
}): ReactElement {
  return (
    <MarkdownScrollGuardContext.Provider value={value}>
      {children}
    </MarkdownScrollGuardContext.Provider>
  );
}

export function useMarkdownScrollGuard(): MarkdownScrollGuard | null {
  return useContext(MarkdownScrollGuardContext);
}
