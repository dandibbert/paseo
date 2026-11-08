/**
 * The panel's page. It only draws what the main window sends, so it is plain DOM: it opens at
 * once and holds no host connections of its own. `runNotchPanel` is serialised into the page
 * with Function#toString, so it must not use anything outside its own body.
 */

/** The panel window's size; the visible island is drawn inside it, the rest lets clicks through. */
export const NOTCH_WINDOW_WIDTH = 760;
export const NOTCH_WINDOW_HEIGHT = 640;

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
  font: 13px/1.35 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
  color: #f2f2f2; -webkit-user-select: none; user-select: none; cursor: default; }
#island { position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  background: #000; overflow: hidden; border-radius: 0 0 14px 14px;
  transition: width .32s cubic-bezier(.2,.9,.25,1.05), height .32s cubic-bezier(.2,.9,.25,1.05),
    border-radius .32s ease, opacity .2s ease, box-shadow .3s ease; }
#island.hidden { opacity: 0; }
#island.expanded { border-radius: 0 0 26px 26px; box-shadow: 0 14px 44px rgba(0,0,0,.5); }
#bar { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center;
  justify-content: space-between; padding: 0 12px; transition: opacity .2s ease; }
#island.expanded #bar { opacity: 0; pointer-events: none; }
.ear { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px;
  font-variant-numeric: tabular-nums; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #5a5a5a; flex: none; }
.dot.needs { background: #f5a524; box-shadow: 0 0 8px rgba(245,165,36,.8); }
.dot.error { background: #f26d6d; box-shadow: 0 0 8px rgba(242,109,109,.7); }
.dot.running { background: #4b9cff; animation: pulse 1.6s ease-in-out infinite; }
.dot.finished { background: #3ecf72; }
.dot.recent { background: #6b6b6b; }
.dot.online { background: #3ecf72; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
#island.alert { box-shadow: 0 0 0 1px rgba(245,165,36,.65), 0 6px 26px rgba(245,165,36,.35); }
#content { position: absolute; left: 0; right: 0; bottom: 0; padding: 4px 16px 16px;
  overflow-y: auto; opacity: 0; transition: opacity .18s ease; }
#island.expanded #content { opacity: 1; transition-delay: .08s; }
#content::-webkit-scrollbar { width: 0; }
.hosts { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 4px; }
.chip { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
  background: #151515; font-size: 11.5px; color: #cfcfcf; max-width: 220px; }
.chip .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip .count { color: #8b8b8b; font-variant-numeric: tabular-nums; }
.chip.offline { color: #6f6f6f; }
.section-title { font-size: 11px; font-weight: 600; letter-spacing: .02em; color: #8b8b8b;
  margin: 12px 4px 6px; display: flex; justify-content: space-between; }
.section-title.needs { color: #f5b54a; }
.calm { color: #8b8b8b; font-size: 12px; margin: 12px 4px 2px; display: flex; gap: 6px;
  align-items: center; }
.item { background: #161616; border-radius: 14px; padding: 9px 11px; margin-bottom: 6px; }
.item:hover { background: #1f1f1f; }
.row { display: flex; align-items: center; gap: 8px; }
.title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.time { color: #8b8b8b; font-size: 11px; font-variant-numeric: tabular-nums; flex: none; }
.sub { color: #8b8b8b; font-size: 11.5px; margin: 2px 0 0 16px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.detail { margin: 6px 0 0 16px; padding: 6px 8px; border-radius: 8px; background: #0c0c0c;
  font: 11.5px/1.4 ui-monospace, "SF Mono", Menlo, monospace; color: #d6d6d6;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail.error { color: #f6a3a3; }
.buttons { display: flex; gap: 6px; margin: 8px 0 0 16px; flex-wrap: wrap; }
button { border: 0; border-radius: 9px; padding: 5px 12px; font: inherit; font-size: 12px;
  font-weight: 600; color: #f2f2f2; background: #2a2a2a; cursor: pointer; }
button:hover { background: #363636; }
button.primary { background: #f2f2f2; color: #000; }
button.primary:hover { background: #fff; }
button.danger { background: #4a1c1c; color: #ffb4b4; }
button:disabled { opacity: .45; cursor: default; }
.board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 4px; }
.column { background: #0d0d0d; border-radius: 16px; padding: 8px; min-height: 92px; }
.column .section-title { margin: 2px 4px 8px; }
.card { background: #171717; border-radius: 11px; padding: 7px 9px; margin-bottom: 5px; }
.card:hover { background: #222; }
.card .title { font-size: 12px; }
.card .sub { margin-left: 16px; font-size: 11px; }
.none { color: #5d5d5d; font-size: 11.5px; text-align: center; padding: 14px 0; }
.more { color: #8b8b8b; font-size: 11px; text-align: center; padding: 2px 0 0; }
`;

export function runNotchPanel(): void {
  interface Button {
    key: string;
    label: string;
    tone: string;
    kind: string;
  }
  interface Item {
    key: string;
    serverId: string;
    agentId: string;
    title: string;
    subtitle: string;
    state: string;
    detail: string | null;
    since: number;
    requestId: string | null;
    buttons: Button[];
  }
  interface HostSummary {
    serverId: string;
    label: string;
    online: boolean;
    running: number;
    needsYou: number;
  }
  interface State {
    enabled: boolean;
    labels: {
      needsYou: string;
      running: string;
      finished: string;
      recent: string;
      columnEmpty: string;
      empty: string;
      offline: string;
      open: string;
    };
    needsYou: Item[];
    running: Item[];
    finished: Item[];
    recent: Item[];
    hosts: HostSummary[];
    offlineHosts: string[];
  }
  interface Geometry {
    notchWidth: number;
    notchHeight: number;
    hasNotch: boolean;
  }
  interface Bridge {
    onUpdate(handler: (message: { state: State | null; geometry: Geometry }) => void): void;
    action(action: unknown): void;
    setInteractive(interactive: boolean): void;
  }

  const bridge = (window as unknown as { paseoNotch?: Bridge }).paseoNotch;
  const island = document.getElementById("island") as HTMLDivElement;
  const bar = document.getElementById("bar") as HTMLDivElement;
  const content = document.getElementById("content") as HTMLDivElement;
  if (!bridge || !island) return;

  const EXPANDED_WIDTH = 720;
  const EAR_WIDTH = 64;
  const MAX_HEIGHT = 620;
  const COLUMN_LIMIT = 5;
  let state: State | null = null;
  let geometry: Geometry = { notchWidth: 190, notchHeight: 32, hasNotch: false };
  let expanded = false;
  let interactive = false;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastNeedsKeys = "";
  const answered = new Set<string>();

  function el(tag: string, className?: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ago(since: number): string {
    const minutes = Math.max(0, Math.floor((Date.now() - since) / 60000));
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
  }

  function dotClass(item: Item): string {
    if (item.state === "error") return "dot error";
    if (item.state === "running") return "dot running";
    if (item.state === "finished") return "dot finished";
    if (item.state === "recent") return "dot recent";
    return "dot needs";
  }

  function open(item: Item): void {
    bridge?.action({ type: "open", serverId: item.serverId, agentId: item.agentId });
    collapse();
  }

  function renderButtons(item: Item): HTMLElement | null {
    if (item.buttons.length === 0 || !item.requestId) return null;
    const buttons = el("div", "buttons");
    const done = answered.has(item.requestId);
    for (const spec of item.buttons) {
      const button = el("button", spec.tone, spec.label) as HTMLButtonElement;
      button.disabled = done;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (spec.kind === "open") {
          open(item);
          return;
        }
        if (!item.requestId) return;
        answered.add(item.requestId);
        bridge?.action({
          type: "respond",
          serverId: item.serverId,
          agentId: item.agentId,
          requestId: item.requestId,
          buttonKey: spec.key,
        });
        render();
      });
      buttons.append(button);
    }
    return buttons;
  }

  /** A full-width card for something that needs you, with its detail and buttons. */
  function renderNeed(item: Item): HTMLElement {
    const card = el("div", "item");
    const row = el("div", "row");
    row.append(el("span", dotClass(item)), el("span", "title", item.title));
    row.append(el("span", "time", ago(item.since)));
    card.append(row, el("div", "sub", item.subtitle));
    if (item.detail) {
      card.append(el("div", item.state === "error" ? "detail error" : "detail", item.detail));
    }
    const buttons = renderButtons(item);
    if (buttons) card.append(buttons);
    card.addEventListener("click", () => open(item));
    return card;
  }

  /** A small board card: title, where it runs, how long ago. */
  function renderCard(item: Item): HTMLElement {
    const card = el("div", "card");
    const row = el("div", "row");
    row.append(el("span", dotClass(item)), el("span", "title", item.title));
    row.append(el("span", "time", ago(item.since)));
    card.append(row, el("div", "sub", item.subtitle));
    card.addEventListener("click", () => open(item));
    return card;
  }

  function renderColumn(title: string, items: Item[], empty: string): HTMLElement {
    const column = el("div", "column");
    const heading = el("div", "section-title");
    heading.append(el("span", undefined, title), el("span", undefined, String(items.length)));
    column.append(heading);
    if (items.length === 0) column.append(el("div", "none", empty));
    for (const item of items.slice(0, COLUMN_LIMIT)) column.append(renderCard(item));
    if (items.length > COLUMN_LIMIT)
      column.append(el("div", "more", `+${items.length - COLUMN_LIMIT}`));
    return column;
  }

  function renderHosts(current: State): HTMLElement | null {
    if (current.hosts.length === 0) return null;
    const row = el("div", "hosts");
    for (const host of current.hosts) {
      const chip = el("div", host.online ? "chip" : "chip offline");
      chip.title = host.label;
      chip.append(el("span", host.online ? "dot online" : "dot"), el("span", "name", host.label));
      if (!host.online) chip.append(el("span", "count", current.labels.offline));
      else if (host.needsYou > 0) chip.append(el("span", "count", `! ${host.needsYou}`));
      else if (host.running > 0) chip.append(el("span", "count", String(host.running)));
      row.append(chip);
    }
    return row;
  }

  function renderBar(current: State): void {
    bar.replaceChildren();
    const needs = current.needsYou.length;
    const errors = current.needsYou.filter((item) => item.state === "error").length;
    const running = current.running.length;
    const left = el("div", "ear");
    const right = el("div", "ear");
    if (needs > 0) {
      left.append(el("span", errors === needs ? "dot error" : "dot needs"));
      right.append(el("span", undefined, String(needs)));
    } else if (running > 0) {
      left.append(el("span", "dot running"));
      right.append(el("span", undefined, String(running)));
    } else if (current.finished.length > 0) {
      left.append(el("span", "dot finished"));
      right.append(el("span", undefined, String(current.finished.length)));
    }
    bar.append(left, right);
  }

  /** Whether the collapsed island grows ears: only for live work, not for yesterday's chats. */
  function hasLiveWork(current: State): boolean {
    return current.needsYou.length + current.running.length + current.finished.length > 0;
  }

  function layout(): void {
    const current = state;
    const visible = current !== null && current.enabled;
    const live = current !== null && hasLiveWork(current);
    // A screen without a notch shows nothing until there is something to show.
    island.classList.toggle("hidden", !visible || (!geometry.hasNotch && !live && !expanded));
    island.classList.toggle("expanded", expanded);
    bar.style.height = `${geometry.notchHeight}px`;
    if (expanded) {
      content.style.top = `${geometry.notchHeight}px`;
      const height = Math.min(MAX_HEIGHT, geometry.notchHeight + content.scrollHeight + 4);
      island.style.width = `${EXPANDED_WIDTH}px`;
      island.style.height = `${Math.max(height, geometry.notchHeight + 64)}px`;
    } else {
      island.style.width = `${geometry.notchWidth + (live ? EAR_WIDTH * 2 : 0)}px`;
      island.style.height = `${geometry.notchHeight}px`;
    }
  }

  function render(): void {
    const current = state;
    if (!current) {
      layout();
      return;
    }
    renderBar(current);
    content.replaceChildren();
    const hosts = renderHosts(current);
    if (hosts) content.append(hosts);
    if (current.needsYou.length > 0) {
      const heading = el("div", "section-title needs");
      heading.append(
        el("span", undefined, current.labels.needsYou),
        el("span", undefined, String(current.needsYou.length)),
      );
      content.append(heading);
      for (const item of current.needsYou) content.append(renderNeed(item));
    } else {
      const calm = el("div", "calm");
      calm.append(el("span", "dot finished"), el("span", undefined, current.labels.empty));
      content.append(calm);
    }
    const board = el("div", "board");
    board.append(
      renderColumn(current.labels.running, current.running, current.labels.columnEmpty),
      renderColumn(current.labels.finished, current.finished, current.labels.columnEmpty),
      renderColumn(current.labels.recent, current.recent, current.labels.columnEmpty),
    );
    content.append(board);
    layout();
  }

  function setInteractive(next: boolean): void {
    if (interactive === next) return;
    interactive = next;
    bridge?.setInteractive(next);
  }

  function expand(): void {
    clearTimeout(closeTimer);
    if (expanded) return;
    expanded = true;
    render();
  }

  function collapse(): void {
    clearTimeout(openTimer);
    if (!expanded) return;
    expanded = false;
    layout();
  }

  function pointerInside(x: number, y: number): boolean {
    const rect = island.getBoundingClientRect();
    // The collapsed island is thin; a few points of slack make it easy to reach.
    const slack = expanded ? 6 : 10;
    return (
      x >= rect.left - slack && x <= rect.right + slack && y >= rect.top && y <= rect.bottom + slack
    );
  }

  // The window ignores the mouse except over the island; moves are still forwarded here.
  document.addEventListener("mousemove", (event) => {
    if (island.classList.contains("hidden")) return;
    const inside = pointerInside(event.clientX, event.clientY);
    setInteractive(inside);
    if (inside) {
      clearTimeout(closeTimer);
      if (!expanded) {
        clearTimeout(openTimer);
        openTimer = setTimeout(expand, 140);
      }
    } else {
      clearTimeout(openTimer);
      if (expanded) {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(collapse, 380);
      }
    }
  });
  document.addEventListener("mouseleave", () => {
    setInteractive(false);
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(collapse, 380);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") collapse();
  });
  // Relative times drift; redraw them every half minute.
  setInterval(() => {
    if (state) render();
  }, 30000);

  bridge.onUpdate((message) => {
    geometry = message.geometry;
    state = message.state;
    if (state) {
      const live = new Set(state.needsYou.map((item) => item.requestId).filter(Boolean));
      for (const id of answered) if (!live.has(id)) answered.delete(id);
      const needsKeys = state.needsYou.map((item) => item.key).join("|");
      if (needsKeys && needsKeys !== lastNeedsKeys && !expanded) {
        island.classList.add("alert");
        setTimeout(() => island.classList.remove("alert"), 2600);
      }
      lastNeedsKeys = needsKeys;
    }
    render();
  });
}

export function notchPanelPageHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>${STYLE}</style></head><body>
<div id="island" class="hidden"><div id="bar"></div><div id="content"></div></div>
<script>(${runNotchPanel.toString()})();</script></body></html>`;
}
