import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { within, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { ProviderCliUpdate } from "./cli-update";
import type { ProviderCliUpdateResult } from "@getpaseo/protocol/provider-cli-update";

// The UI must never update the developer's installed CLI. Keep the RPC boundary
// injectable while exercising real React Query mutations and rendered feedback.
const rpc = vi.hoisted(() => ({
  supported: true,
  inspectProviderCliUpdate: vi.fn(),
  updateProviderCli: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => rpc,
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => rpc.supported }));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: async () => true }));

let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;
beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  rpc.supported = true;
  rpc.inspectProviderCliUpdate.mockResolvedValue({
    status: "available",
    plan: {
      provider: "codex",
      token: "confirmed",
      hostname: "dev-host",
      binaryPath: "/opt/node/bin/codex",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      command: ["/opt/node/bin/npm", "install", "@openai/codex@1.1.0"],
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() =>
    root.render(
      <QueryClientProvider client={queries}>
        <ProviderCliUpdate provider="codex" serverId="host" />
      </QueryClientProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queries.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function openUpdate() {
  act(() => within(document.body).getByTestId("provider-cli-update-open").click());
  await waitFor(() =>
    expect(within(document.body).getByTestId("provider-cli-update-confirm").textContent).toBe(
      "Update CLI",
    ),
  );
}

it("shows the host and command, prevents duplicates, and acknowledges a verified update", async () => {
  const done = Promise.withResolvers<ProviderCliUpdateResult>();
  rpc.updateProviderCli.mockReturnValue(done.promise);
  await openUpdate();
  expect(document.body.textContent).toContain("Host: dev-host");
  expect(document.body.textContent).toContain("/opt/node/bin/codex");
  expect(document.body.textContent).toContain("@openai/codex@1.1.0");
  await act(async () => within(document.body).getByTestId("provider-cli-update-confirm").click());
  await waitFor(() =>
    expect(
      within(document.body)
        .getByTestId("provider-cli-update-confirm")
        .getAttribute("aria-disabled"),
    ).toBe("true"),
  );
  expect(rpc.updateProviderCli).toHaveBeenCalledExactlyOnceWith("codex", "confirmed");
  await act(async () =>
    done.resolve({
      success: true,
      version: "codex-cli 1.1.0",
      output: "Package updated",
      error: null,
    }),
  );
  await waitFor(() =>
    expect(within(document.body).getByTestId("provider-cli-update-success").textContent).toContain(
      "CLI updated: codex-cli 1.1.0",
    ),
  );
  expect(document.body.textContent).toContain("Package updated");
  expect(document.body.textContent).toContain("create a new session");
});

it("keeps an actionable update failure visible and lets the user check again", async () => {
  rpc.updateProviderCli.mockResolvedValue({
    success: false,
    version: null,
    output: "npm output",
    error: "Wait for running agents",
  });
  await openUpdate();
  await act(async () => within(document.body).getByTestId("provider-cli-update-confirm").click());
  await waitFor(() =>
    expect(within(document.body).getByTestId("provider-cli-update-error").textContent).toContain(
      "Wait for running agents",
    ),
  );
  expect(document.body.textContent).toContain("npm output");
  act(() => within(document.body).getByRole("button", { name: "Check for updates" }).click());
  await waitFor(() => expect(rpc.inspectProviderCliUpdate).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(within(document.body).getByTestId("provider-cli-update-confirm").textContent).toBe(
      "Update CLI",
    ),
  );
});

it("warns that a disconnected request may still be running on the host", async () => {
  rpc.updateProviderCli.mockRejectedValue(new Error("Connection lost"));
  await openUpdate();
  await act(async () => within(document.body).getByTestId("provider-cli-update-confirm").click());
  await waitFor(() =>
    expect(within(document.body).getByTestId("provider-cli-update-error").textContent).toContain(
      "The host may still be updating",
    ),
  );
  expect(document.body.textContent).toContain("Connection lost");
});

it("does not send unsupported RPCs to an older host", async () => {
  rpc.supported = false;
  act(() => within(document.body).getByTestId("provider-cli-update-open").click());
  await waitFor(() =>
    expect(document.body.textContent).toContain("This host does not support in-app CLI updates"),
  );
  expect(rpc.inspectProviderCliUpdate).not.toHaveBeenCalled();
});

it("describes native updater channels without claiming an npm target version", async () => {
  rpc.inspectProviderCliUpdate.mockResolvedValue({
    status: "available",
    plan: {
      provider: "claude",
      token: "native-confirmed",
      hostname: "dev-host",
      binaryPath: "/home/dev/.local/bin/claude",
      currentVersion: "2.1.100 (Claude Code)",
      latestVersion: "unknown",
      updateMethod: "native",
      command: ["/home/dev/.local/bin/claude", "update"],
    },
  });
  rpc.updateProviderCli.mockResolvedValue({
    success: true,
    version: "2.1.100 (Claude Code)",
    output: "Already up to date",
    error: null,
  });
  await openUpdate();
  expect(document.body.textContent).toContain(
    "The update command checks for a release using its configured channel.",
  );
  expect(document.body.textContent).not.toContain("Latest: unknown");
  await act(async () => within(document.body).getByTestId("provider-cli-update-confirm").click());
  await waitFor(() =>
    expect(within(document.body).getByTestId("provider-cli-update-success").textContent).toContain(
      "CLI updated: 2.1.100",
    ),
  );
  expect(document.body.textContent).toContain("Already up to date");
});

it("shows the new pinned catalog launcher that will be saved after package preparation", async () => {
  rpc.inspectProviderCliUpdate.mockResolvedValue({
    status: "available",
    plan: {
      provider: "gemini",
      token: "catalog-confirmed",
      hostname: "dev-host",
      binaryPath: "/opt/node/bin/npx",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      updateMethod: "npx",
      command: [
        "/opt/node/bin/npm",
        "exec",
        "--yes",
        "--package=@google/gemini-cli@2.0.0",
        "--",
        "node",
        "-e",
        "",
      ],
      updatedCommand: ["npx", "-y", "@google/gemini-cli@2.0.0", "--acp"],
    },
  });
  rpc.updateProviderCli.mockResolvedValue({
    success: true,
    version: "2.0.0",
    output: "Package ready",
    error: null,
  });
  await openUpdate();
  expect(document.body.textContent).toContain("Launcher command saved after the update:");
  expect(document.body.textContent).toContain('"npx" "-y" "@google/gemini-cli@2.0.0" "--acp"');
  await act(async () => within(document.body).getByTestId("provider-cli-update-confirm").click());
  await waitFor(() =>
    expect(within(document.body).getByTestId("provider-cli-update-success").textContent).toContain(
      "CLI updated: 2.0.0",
    ),
  );
});
