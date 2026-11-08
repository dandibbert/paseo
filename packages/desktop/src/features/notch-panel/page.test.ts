/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { notchPanelPageHtml } from "./page";
import type { NotchPanelState } from "./types";

const state: NotchPanelState = {
  enabled: true,
  labels: {
    needsYou: "需要你",
    running: "运行中",
    finished: "刚完成",
    empty: "没有正在进行的任务",
    offline: "离线",
    open: "打开",
    states: { permission: "", question: "", error: "", running: "", finished: "" },
  },
  needsYou: [
    {
      key: "mac:a",
      serverId: "mac",
      agentId: "a",
      title: "Fix <b>login</b>",
      subtitle: "Mac · repo",
      state: "permission",
      detail: "rm -rf build",
      since: Date.now(),
      requestId: "req-1",
      buttons: [
        { key: "allow", label: "允许", tone: "primary", kind: "respond" },
        { key: "deny", label: "拒绝", tone: "secondary", kind: "respond" },
      ],
    },
  ],
  running: [],
  finished: [],
  offlineHosts: ["Linux"],
};

function loadPage() {
  const html = notchPanelPageHtml();
  const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script>"));
  const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
  document.body.innerHTML = body;
  let push: ((message: unknown) => void) | null = null;
  const bridge = {
    onUpdate: (handler: (message: unknown) => void) => {
      push = handler;
    },
    action: vi.fn(),
    setInteractive: vi.fn(),
  };
  (window as unknown as { paseoNotch: typeof bridge }).paseoNotch = bridge;
  // The page's own inline script, exactly as Electron runs it.
  new Function(script)();
  return {
    bridge,
    push: (message: unknown) => push?.(message),
  };
}

describe("notch panel page", () => {
  it("draws approvals as text and sends the pressed button to the main process", () => {
    const page = loadPage();
    page.push({ state, geometry: { notchWidth: 185, notchHeight: 38, hasNotch: true } });
    const island = document.getElementById("island")!;
    expect(island.classList.contains("hidden")).toBe(false);
    expect(island.style.width).toBe(`${185 + 128}px`);
    // Titles are text, never markup.
    expect(document.querySelector(".title")?.textContent).toBe("Fix <b>login</b>");
    expect(document.querySelector(".footer")?.textContent).toBe("离线: Linux");
    const allow = [...document.querySelectorAll("button")].find((b) => b.textContent === "允许")!;
    allow.click();
    expect(page.bridge.action).toHaveBeenCalledWith({
      type: "respond",
      serverId: "mac",
      agentId: "a",
      requestId: "req-1",
      buttonKey: "allow",
    });
    expect(page.bridge.action).toHaveBeenCalledTimes(1);
    expect((document.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("stays hidden on a screen without a notch while nothing needs showing", () => {
    const page = loadPage();
    page.push({
      state: { ...state, needsYou: [], offlineHosts: [] },
      geometry: { notchWidth: 190, notchHeight: 25, hasNotch: false },
    });
    expect(document.getElementById("island")!.classList.contains("hidden")).toBe(true);
  });
});
