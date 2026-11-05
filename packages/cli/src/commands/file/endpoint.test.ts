import { describe, expect, it } from "vitest";
import type { HostDirectory } from "@getpaseo/client";
import { destinationFilePath, resolveFileEndpoint, splitFileEndpoint } from "./endpoint.js";

function host(overrides: Partial<HostDirectory["hosts"][number]>): HostDirectory["hosts"][number] {
  return {
    registrationId: "hst_1",
    serverId: "srv_mac",
    label: "mac-2",
    source: { id: "owner", key: "k" },
    metadata: {},
    enabled: true,
    status: "online",
    targetDescription: "relay://relay.example:443/srv_mac",
    lastOnlineAt: null,
    nextRetryAt: null,
    error: null,
    ...overrides,
  };
}

const directory: HostDirectory = {
  self: { serverId: "srv_linux", label: "linux" },
  hosts: [
    host({}),
    host({ registrationId: "hst_2", serverId: "srv_studio", label: "studio" }),
    host({ registrationId: "hst_3", serverId: null, label: "pending" }),
  ],
};

describe("file endpoints", () => {
  it("treats unprefixed paths and Windows drives as paths on this machine", () => {
    expect(splitFileEndpoint("./notes.txt")).toEqual({ host: null, path: "./notes.txt" });
    expect(splitFileEndpoint("C:\\work\\a.txt")).toEqual({ host: null, path: "C:\\work\\a.txt" });
    expect(splitFileEndpoint("/tmp/a:b")).toEqual({ host: null, path: "/tmp/a:b" });
    expect(resolveFileEndpoint("~/a.txt", directory)).toEqual({ kind: "local", path: "~/a.txt" });
  });

  it("selects hosts by label, server ID, registration ID, or self", () => {
    for (const name of ["mac-2", "srv_mac", "hst_1"]) {
      expect(resolveFileEndpoint(`${name}:/tmp/a.txt`, directory)).toEqual({
        kind: "host",
        serverId: "srv_mac",
        label: "mac-2",
        self: false,
        path: "/tmp/a.txt",
      });
    }
    for (const name of ["self", "linux", "srv_linux"]) {
      expect(resolveFileEndpoint(`${name}:a.txt`, directory)).toMatchObject({
        kind: "host",
        serverId: "srv_linux",
        self: true,
      });
    }
  });

  it("explains unknown, undiscovered, and ambiguous hosts", () => {
    expect(() => resolveFileEndpoint("nope:/a", directory)).toThrow(
      expect.objectContaining({ code: "host_unknown" }),
    );
    expect(() => resolveFileEndpoint("pending:/a", directory)).toThrow(
      expect.objectContaining({ code: "host_unknown", details: expect.stringContaining("hst_3") }),
    );
    const twins = { ...directory, hosts: [host({}), host({ registrationId: "hst_9" })] };
    expect(() => resolveFileEndpoint("mac-2:/a", twins)).toThrow(
      expect.objectContaining({ code: "host_ambiguous" }),
    );
    expect(() => resolveFileEndpoint("mac-2:", directory)).toThrow(
      expect.objectContaining({ code: "invalid_path" }),
    );
  });

  it("keeps the source name when the destination is a directory", () => {
    expect(destinationFilePath("/tmp/out/", "build/app.tar.gz")).toBe("/tmp/out/app.tar.gz");
    expect(destinationFilePath("~", "a.txt")).toBe("~/a.txt");
    expect(destinationFilePath("/tmp/out/renamed.txt", "a.txt")).toBe("/tmp/out/renamed.txt");
  });
});
