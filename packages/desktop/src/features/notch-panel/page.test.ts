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
    finished: "待查看",
    recent: "最近完成",
    columnEmpty: "暂无",
    empty: "目前没有需要你处理的任务",
    offline: "离线",
    open: "打开",
    states: { permission: "", question: "", error: "", running: "", finished: "", recent: "" },
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
  recent: [
    {
      key: "mac:r",
      serverId: "mac",
      agentId: "r",
      title: "Write release notes",
      subtitle: "Mac · docs",
      state: "recent",
      detail: null,
      since: Date.now() - 3_600_000,
      requestId: null,
      buttons: [],
    },
  ],
  hosts: [
    { serverId: "mac", label: "Mac", online: true, running: 0, needsYou: 1 },
    { serverId: "linux", label: "Linux", online: false, running: 0, needsYou: 0 },
  ],
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
    expect([...document.querySelectorAll(".chip")].map((chip) => chip.textContent)).toEqual([
      "Mac! 1",
      "Linux离线",
    ]);
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

  it("shows a small board of running, to-review and recent chats when nothing needs you", () => {
    const page = loadPage();
    page.push({
      state: { ...state, needsYou: [] },
      geometry: { notchWidth: 185, notchHeight: 38, hasNotch: true },
    });
    expect(document.querySelector(".calm")?.textContent).toBe("目前没有需要你处理的任务");
    const columns = [...document.querySelectorAll(".column")];
    expect(columns.map((column) => column.querySelector(".section-title")?.textContent)).toEqual([
      "运行中0",
      "待查看0",
      "最近完成1",
    ]);
    expect(columns[2]?.querySelector(".card .title")?.textContent).toBe("Write release notes");
    // Yesterday's chats alone do not grow the collapsed island.
    expect(document.getElementById("island")!.style.width).toBe("185px");
  });

  it("stays hidden on a screen without a notch while nothing needs showing", () => {
    const page = loadPage();
    page.push({
      state: { ...state, needsYou: [], recent: [], offlineHosts: [] },
      geometry: { notchWidth: 190, notchHeight: 25, hasNotch: false },
    });
    expect(document.getElementById("island")!.classList.contains("hidden")).toBe(true);
  });
});
