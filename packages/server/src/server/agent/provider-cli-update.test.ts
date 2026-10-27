import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProviderCliUpdater } from "./provider-cli-update.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

interface InstallationOptions {
  fail?: boolean;
  hold?: Promise<void>;
}

async function installation(options: InstallationOptions = {}) {
  const prefix = await mkdtemp(join(tmpdir(), "paseo-cli-update-"));
  directories.push(prefix);
  const bin = join(prefix, "bin");
  const root = join(prefix, "lib/node_modules/@openai/codex");
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: "1.0.0",
      bin: { codex: "bin/codex.js" },
    }),
  );
  await writeFile(join(root, "bin/codex.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
  await symlink(join(root, "bin/codex.js"), join(bin, "codex"));
  const npmRoot = join(prefix, "lib/node_modules/npm");
  await mkdir(join(npmRoot, "bin"), { recursive: true });
  await writeFile(join(npmRoot, "package.json"), JSON.stringify({ name: "npm" }));
  await writeFile(join(npmRoot, "bin/npm-cli.js"), "");
  await symlink(join(npmRoot, "bin/npm-cli.js"), join(bin, "npm"));
  const calls: string[][] = [];
  const updater = new ProviderCliUpdater({
    isContainer: false,
    resolveBinary: async (command) => join(bin, command),
    execute: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "view") return { stdout: '"1.1.0"', stderr: "" };
      if (args[0] === "install") {
        await options.hold;
        if (options.fail) throw new Error("npm failed: registry unavailable");
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({
            name: "@openai/codex",
            version: "1.1.0",
            bin: { codex: "bin/codex.js" },
          }),
        );
        return { stdout: "updated", stderr: "" };
      }
      return { stdout: "codex-cli 1.1.0", stderr: "" };
    },
  });
  return { updater, prefix, bin, root, calls };
}

it.runIf(process.platform === "win32")("requires the original installer on Windows", async () => {
  const resolveBinary = vi.fn();
  const updater = new ProviderCliUpdater({ isContainer: false, resolveBinary });
  expect(await updater.inspect({ provider: "codex" })).toEqual({
    status: "unavailable",
    reason:
      "Update this CLI using its installer or container image. In-app updates currently run on macOS and Linux hosts outside containers.",
  });
  expect(resolveBinary).not.toHaveBeenCalled();
});

describe.skipIf(process.platform === "win32")("ProviderCliUpdater", () => {
  it("pins the update to the package and prefix used by the resolved binary", async () => {
    const { updater, prefix, bin, calls } = await installation();
    const inspection = await updater.inspect({ provider: "codex" });
    expect(inspection.status).toBe("available");
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(inspection.plan).toMatchObject({
      binaryPath: join(bin, "codex"),
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      command: [
        join(bin, "npm"),
        "install",
        "--global",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        "@openai/codex@1.1.0",
      ],
    });
    const result = await updater.update({ provider: "codex", token: inspection.plan.token });
    expect(result).toEqual({
      success: true,
      version: "codex-cli 1.1.0",
      output: "updated",
      error: null,
    });
    expect(calls.filter((call) => call.includes("install"))).toHaveLength(1);
    await expect(
      updater.update({ provider: "codex", token: inspection.plan.token }),
    ).rejects.toThrow("Check for updates again");
  });

  it("does not reject provider environment overrides", async () => {
    const { updater, calls } = await installation();
    expect(
      (
        await updater.inspect({
          provider: "codex",
          settings: { env: { OPENAI_BASE_URL: "https://example.test" } },
        })
      ).status,
    ).toBe("available");
    expect(calls.some((call) => call.includes("view"))).toBe(true);
  });

  it("refuses an installation that changed after confirmation", async () => {
    const { updater, root, calls } = await installation();
    const inspection = await updater.inspect({ provider: "codex" });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "@openai/codex", version: "1.0.1", bin: { codex: "bin/codex.js" } }),
    );
    expect(await updater.update({ provider: "codex", token: inspection.plan.token })).toEqual({
      success: false,
      version: null,
      output: "",
      error: "The CLI installation changed. Check for updates again.",
    });
    expect(calls.filter((call) => call.includes("install"))).toEqual([]);
  });

  it("reports command failure and permits a new check and retry", async () => {
    const { updater } = await installation({ fail: true });
    const inspection = await updater.inspect({ provider: "codex" });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(await updater.update({ provider: "codex", token: inspection.plan.token })).toEqual({
      success: false,
      version: null,
      output: "",
      error: "npm failed: registry unavailable",
    });
    expect((await updater.inspect({ provider: "codex" })).status).toBe("available");
  });

  it("rejects duplicate updates while the first update is running", async () => {
    const hold = Promise.withResolvers<void>();
    const { updater } = await installation({ hold: hold.promise });
    const inspection = await updater.inspect({ provider: "codex" });
    const second = await updater.inspect({ provider: "codex" });
    if (inspection.status !== "available" || second.status !== "available")
      throw new Error("Expected update plans");
    const update = updater.update({ provider: "codex", token: inspection.plan.token });
    await expect(updater.update({ provider: "codex", token: second.plan.token })).rejects.toThrow(
      "Another CLI update",
    );
    hold.resolve();
    expect((await update).success).toBe(true);
  });

  it("expires confirmation tokens", async () => {
    const { updater, calls } = await installation();
    const inspection = await updater.inspect({ provider: "codex" });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    try {
      await expect(
        updater.update({ provider: "codex", token: inspection.plan.token }),
      ).rejects.toThrow("Check for updates again");
      expect(calls.filter((call) => call.includes("install"))).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not offer a downgrade or an update when already current", async () => {
    const { updater, root } = await installation();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "@openai/codex", version: "2.0.0", bin: { codex: "bin/codex.js" } }),
    );
    expect(await updater.inspect({ provider: "codex" })).toEqual({
      status: "unavailable",
      reason: "This CLI is up to date (2.0.0).",
    });
  });

  it("refuses a CLI symlink pointing outside the verified npm package", async () => {
    const { updater, bin, prefix, calls } = await installation();
    const wrapper = join(prefix, "wrapper");
    await writeFile(wrapper, "wrapper");
    await rm(join(bin, "codex"));
    await symlink(wrapper, join(bin, "codex"));
    expect(await updater.inspect({ provider: "codex" })).toMatchObject({ status: "unavailable" });
    expect(calls).toEqual([]);
  });

  it("does not offer in-container updates", async () => {
    const updater = new ProviderCliUpdater({ isContainer: true });
    expect((await updater.inspect({ provider: "codex" })).status).toBe("unavailable");
  });
});

it.skipIf(process.platform === "win32")(
  "runs the real update process and verifies its installed binary without network access",
  async () => {
    const { bin, root } = await installation();
    await writeFile(
      join(root, "bin/codex.js"),
      `#!${process.execPath}\nconsole.log('codex-cli ' + JSON.parse(require('node:fs').readFileSync(${JSON.stringify(join(root, "package.json"))}, 'utf8')).version);\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "../lib/node_modules/npm/bin/npm-cli.js"),
      `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv[2] === 'view') console.log(JSON.stringify('1.1.0'));\nelse { const file = ${JSON.stringify(join(root, "package.json"))}; const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); manifest.version = '1.1.0'; fs.writeFileSync(file, JSON.stringify(manifest)); console.log('updated by real child'); }\n`,
      { mode: 0o755 },
    );
    await chmod(join(bin, "../lib/node_modules/npm/bin/npm-cli.js"), 0o755);
    const updater = new ProviderCliUpdater({
      isContainer: false,
      resolveBinary: async (command) => join(bin, command),
    });
    const inspection = await updater.inspect({ provider: "codex" });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(await updater.update({ provider: "codex", token: inspection.plan.token })).toEqual({
      success: true,
      version: "codex-cli 1.1.0",
      output: "updated by real child",
      error: null,
    });
  },
);

interface NativeFixtureOptions {
  noChange?: boolean;
  fail?: boolean;
}

async function nativeInstallation(
  provider: "claude" | "opencode" | "cursor",
  options: NativeFixtureOptions = {},
) {
  const home = await mkdtemp(join(tmpdir(), "paseo-native-update-"));
  directories.push(home);
  const name = provider === "cursor" ? "cursor-agent" : provider;
  const root = provider === "opencode" ? join(home, ".opencode") : join(home, ".local/share", name);
  const bin = provider === "opencode" ? join(root, "bin") : join(home, ".local/bin");
  const versions = join(root, "versions");
  await mkdir(bin, { recursive: true });
  await mkdir(versions, { recursive: true });
  const binary = join(bin, name);
  const target = provider === "opencode" ? binary : join(versions, "1.0.0");
  await writeFile(target, "native binary", { mode: 0o755 });
  if (binary !== target) await symlink(target, binary);
  let version = "1.0.0";
  const calls: string[][] = [];
  const updater = new ProviderCliUpdater({
    home,
    isContainer: false,
    resolveBinary: async (command) => (command === name || command === binary ? binary : null),
    execute: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "--version") return { stdout: version, stderr: "" };
      if (options.fail) throw new Error("Official updater failed: network unavailable");
      if (options.noChange) return { stdout: "Already up to date", stderr: "" };
      version = "1.1.0";
      if (provider !== "opencode") {
        const next = join(versions, version);
        await writeFile(next, "updated native binary", { mode: 0o755 });
        await rm(binary);
        await symlink(next, binary);
      }
      return { stdout: "official updater finished", stderr: "" };
    },
  });
  return { updater, home, binary, target, calls };
}

describe.skipIf(process.platform === "win32")("official CLI self-updates", () => {
  it.each(["claude", "opencode", "cursor"] as const)(
    "runs %s's official update command without npm",
    async (provider) => {
      const { updater, binary, calls } = await nativeInstallation(provider);
      const inspection = await updater.inspect({ provider });
      if (inspection.status !== "available") throw new Error(inspection.reason);
      const args = provider === "opencode" ? ["upgrade", "--method", "curl"] : ["update"];
      expect(inspection.plan).toMatchObject({
        binaryPath: binary,
        currentVersion: "1.0.0",
        updateMethod: "native",
        command: [binary, ...args],
      });
      expect(await updater.update({ provider, token: inspection.plan.token })).toEqual({
        success: true,
        version: "1.1.0",
        output: "official updater finished",
        error: null,
      });
      expect(calls).toEqual([
        [binary, "--version"],
        [binary, "--version"],
        [binary, ...args],
        [binary, "--version"],
      ]);
    },
  );

  it("accepts Cursor's standard catalog launch command", async () => {
    const { updater, binary } = await nativeInstallation("cursor");
    const inspection = await updater.inspect({
      provider: "cursor",
      settings: { command: { mode: "replace", argv: ["cursor-agent", "acp"] } },
    });
    expect(inspection).toMatchObject({
      status: "available",
      plan: { command: [binary, "update"] },
    });
  });

  it("updates a configured absolute binary with its provider environment", async () => {
    const { updater, binary, calls } = await nativeInstallation("claude");
    const settings = {
      command: { mode: "replace" as const, argv: [binary, "--verbose"] },
      env: { ANTHROPIC_BASE_URL: "https://example.test" },
    };
    const inspection = await updater.inspect({
      provider: "team-claude",
      baseProvider: "claude",
      settings,
    });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(inspection.plan.command).toEqual([binary, "update"]);
    expect(
      (
        await updater.update({
          provider: "team-claude",
          baseProvider: "claude",
          settings,
          token: inspection.plan.token,
        })
      ).success,
    ).toBe(true);
    expect(calls.some((call) => call[1] === "update")).toBe(true);
  });

  it("refuses native symlinks retargeted after confirmation", async () => {
    const { updater, binary, home, calls } = await nativeInstallation("claude");
    const inspection = await updater.inspect({ provider: "claude" });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    const other = join(home, "other-binary");
    await writeFile(other, "wrapper");
    await rm(binary);
    await symlink(other, binary);
    expect(
      await updater.update({ provider: "claude", token: inspection.plan.token }),
    ).toMatchObject({
      success: false,
      error: "The CLI installation changed. Check for updates again.",
    });
    expect(calls).toEqual([[binary, "--version"]]);
  });

  it("does not treat a Homebrew-managed executable as an official native install", async () => {
    const { updater, binary, home, calls } = await nativeInstallation("cursor");
    const brew = join(home, "Cellar/cursor-agent/1.0.0");
    await mkdir(brew, { recursive: true });
    const managed = join(brew, "cursor-agent");
    await writeFile(managed, "managed");
    await rm(binary);
    await symlink(managed, binary);
    expect((await updater.inspect({ provider: "cursor" })).status).toBe("unavailable");
    expect(calls).toEqual([]);
  });

  it("accepts an official updater's successful no-op", async () => {
    const { updater } = await nativeInstallation("claude", { noChange: true });
    const inspection = await updater.inspect({ provider: "claude" });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(await updater.update({ provider: "claude", token: inspection.plan.token })).toEqual({
      success: true,
      version: "1.0.0",
      output: "Already up to date",
      error: null,
    });
  });

  it("reports official updater failures and permits another inspection", async () => {
    const { updater } = await nativeInstallation("opencode", { fail: true });
    const inspection = await updater.inspect({ provider: "opencode" });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(await updater.update({ provider: "opencode", token: inspection.plan.token })).toEqual({
      success: false,
      version: null,
      output: "",
      error: "Official updater failed: network unavailable",
    });
    expect((await updater.inspect({ provider: "opencode" })).status).toBe("available");
  });

  it("executes an official native update in a real child process and follows the new launcher", async () => {
    const fixture = await nativeInstallation("claude");
    const next = join(fixture.home, ".local/share/claude/versions/1.1.0");
    await writeFile(next, `#!${process.execPath}\nconsole.log('1.1.0 (Claude Code)');\n`, {
      mode: 0o755,
    });
    await writeFile(
      fixture.target,
      `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv[2] === '--version') console.log('1.0.0 (Claude Code)');\nelse if (process.argv[2] === 'update') { fs.unlinkSync(${JSON.stringify(fixture.binary)}); fs.symlinkSync(${JSON.stringify(next)}, ${JSON.stringify(fixture.binary)}); console.log('Official update complete'); } else process.exit(1);\n`,
      { mode: 0o755 },
    );
    const updater = new ProviderCliUpdater({
      home: fixture.home,
      isContainer: false,
      resolveBinary: async () => fixture.binary,
    });
    const inspection = await updater.inspect({ provider: "claude" });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(await updater.update({ provider: "claude", token: inspection.plan.token })).toEqual({
      success: true,
      version: "1.1.0 (Claude Code)",
      output: "Official update complete",
      error: null,
    });
  });
});

describe.skipIf(process.platform === "win32")("installation-aware update methods", () => {
  it("never executes the custom updater during inspection, even to resolve its executable", async () => {
    const { prefix, bin, root } = await installation();
    const marker = join(prefix, "updater-executed");
    const updaterPath = join(bin, "private-updater");
    await writeFile(join(root, "bin/codex.js"), `#!${process.execPath}\nconsole.log('1.0.0');\n`, {
      mode: 0o755,
    });
    await writeFile(
      updaterPath,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\nconsole.log('updated');\n`,
      { mode: 0o755 },
    );
    const updater = new ProviderCliUpdater({ isContainer: false, home: prefix });
    const settings = {
      command: { mode: "replace" as const, argv: [join(bin, "codex")] },
      updateCommand: [updaterPath],
    };
    const inspection = await updater.inspect({ provider: "private-agent", settings });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await updater.update({
          provider: "private-agent",
          settings,
          token: inspection.plan.token,
        })
      ).success,
    ).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("executed");
  });

  it.each(["omp", "goose"])(
    "uses the official %s self-update for standalone installs",
    async (provider) => {
      const home = await mkdtemp(join(tmpdir(), "paseo-official-update-"));
      directories.push(home);
      const bin = join(home, ".local/bin");
      await mkdir(bin, { recursive: true });
      const binary = join(bin, provider);
      await writeFile(binary, "standalone executable", { mode: 0o755 });
      const calls: string[][] = [];
      const updater = new ProviderCliUpdater({
        home,
        isContainer: false,
        resolveBinary: async () => binary,
        execute: async (command, args) => {
          calls.push([command, ...args]);
          return { stdout: "1.0.0", stderr: "" };
        },
      });
      const inspection = await updater.inspect({ provider });
      if (inspection.status !== "available") throw new Error(inspection.reason);
      expect(inspection.plan.command).toEqual([binary, "update"]);
      expect((await updater.update({ provider, token: inspection.plan.token })).success).toBe(true);
      expect(calls).toContainEqual([binary, "update"]);
    },
  );

  it("uses Muse's official synchronous installer entry without downloading or executing an installer script", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-muse-update-"));
    directories.push(home);
    const bin = join(home, ".local/bin");
    await mkdir(bin, { recursive: true });
    const binary = join(bin, "muse");
    const env = join(bin, "env");
    await writeFile(binary, "# MUSE_LAUNCHER_INSTALL update_binary", { mode: 0o755 });
    await writeFile(env, "env", { mode: 0o755 });
    const calls: string[][] = [];
    const updater = new ProviderCliUpdater({
      home,
      isContainer: false,
      resolveBinary: async (name) => (name === "env" ? env : binary),
      execute: async (command, args, options) => {
        calls.push([command, ...args]);
        if (args[0] === "--version") expect(options?.envOverlay?.MUSE_NO_AUTO_UPDATE).toBe("1");
        return { stdout: "Muse 1.4.1", stderr: "" };
      },
    });
    const inspection = await updater.inspect({ provider: "muse" });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(inspection.plan.command).toEqual([env, "MUSE_LAUNCHER_INSTALL=1", binary]);
    expect((await updater.update({ provider: "muse", token: inspection.plan.token })).success).toBe(
      true,
    );
    expect(calls).toContainEqual([env, "MUSE_LAUNCHER_INSTALL=1", binary]);
  });

  it("discovers npm packages for ACP and plugin providers without a provider allowlist", async () => {
    const { updater, root } = await installation();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@openai/codex",
        version: "1.0.0",
        bin: { codex: "bin/codex.js" },
      }),
    );
    const settings = { command: { mode: "replace" as const, argv: ["codex", "--acp"] } };
    const inspection = await updater.inspect({ provider: "custom-acp", settings });
    expect(inspection).toMatchObject({
      status: "available",
      plan: { updateMethod: "npm", latestVersion: "1.1.0" },
    });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(
      (await updater.update({ provider: "custom-acp", settings, token: inspection.plan.token }))
        .success,
    ).toBe(true);
  });

  it("supports explicit update argv for any configured provider and refuses changed config", async () => {
    const { updater, bin, calls } = await installation();
    const settings = {
      command: { mode: "replace" as const, argv: ["codex", "--acp"] },
      updateCommand: ["npm", "custom-update", "literal;not-shell"],
      env: { EXAMPLE: "value" },
    };
    const inspection = await updater.inspect({ provider: "private-agent", settings });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(inspection.plan).toMatchObject({
      updateMethod: "custom",
      command: [join(bin, "npm"), "custom-update", "literal;not-shell"],
    });
    const changed = await updater.update({
      provider: "private-agent",
      token: inspection.plan.token,
      settings: { ...settings, updateCommand: ["npm", "different"] },
    });
    expect(changed).toMatchObject({
      success: false,
      error: "The provider configuration changed. Check for updates again.",
    });
    expect(calls.some((call) => call.includes("custom-update"))).toBe(false);
    const retry = await updater.inspect({ provider: "private-agent", settings });
    if (retry.status !== "available") throw new Error(retry.reason);
    expect(
      (await updater.update({ provider: "private-agent", settings, token: retry.plan.token }))
        .success,
    ).toBe(true);
    expect(calls).toContainEqual([join(bin, "npm"), "custom-update", "literal;not-shell"]);
  });

  it.each(["Cellar", "Caskroom"])(
    "updates the owning Homebrew %s entry instead of using a native updater",
    async (store) => {
      const { prefix, bin } = await installation();
      const root = join(prefix, store, "example-cli", "1.0.0");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "example"), "binary", { mode: 0o755 });
      await symlink(join(root, "example"), join(bin, "example"));
      await writeFile(join(bin, "brew"), "brew", { mode: 0o755 });
      const calls: string[][] = [];
      const updater = new ProviderCliUpdater({
        isContainer: false,
        resolveBinary: async (name) => join(bin, name),
        execute: async (command, args) => {
          calls.push([command, ...args]);
          if (args[0] === "info")
            return {
              stdout: JSON.stringify({
                formulae: [{ full_name: "example-cli", installed: [{}] }],
                casks: [{ token: "example-cli", installed: "1.0.0" }],
              }),
              stderr: "",
            };
          return { stdout: "example 1.0.0", stderr: "" };
        },
      });
      const inspection = await updater.inspect({ provider: "example" });
      if (inspection.status !== "available") throw new Error(inspection.reason);
      expect(inspection.plan.command).toEqual([
        join(bin, "brew"),
        "upgrade",
        store === "Cellar" ? "--formula" : "--cask",
        "example-cli",
      ]);
      expect(
        (await updater.update({ provider: "example", token: inspection.plan.token })).success,
      ).toBe(true);
      expect(calls.some((call) => call[1] === "upgrade")).toBe(true);
    },
  );

  it("updates Bun global packages only when the selected binary belongs to its global root", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-bun-update-"));
    directories.push(home);
    const root = join(home, ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
    const bin = join(home, ".bun/bin");
    await mkdir(root, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@oh-my-pi/pi-coding-agent",
        version: "1.0.0",
        bin: { omp: "cli.js" },
      }),
    );
    await writeFile(join(root, "cli.js"), "binary");
    await symlink(join(root, "cli.js"), join(bin, "omp"));
    await writeFile(join(bin, "bun"), "bun");
    const calls: string[][] = [];
    const updater = new ProviderCliUpdater({
      home,
      isContainer: false,
      resolveBinary: async (name) => join(bin, name),
      execute: async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: args[0] === "pm" ? bin : "omp 1.0.0", stderr: "" };
      },
    });
    const inspection = await updater.inspect({ provider: "omp" });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(inspection.plan.command).toEqual([
      join(bin, "bun"),
      "add",
      "--global",
      "@oh-my-pi/pi-coding-agent@latest",
    ]);
    expect((await updater.update({ provider: "omp", token: inspection.plan.token })).success).toBe(
      true,
    );
    expect(calls.some((call) => call[1] === "add")).toBe(true);
  });

  it("verifies pnpm's shim and updates the same global directory", async () => {
    const { prefix, bin } = await installation();
    const root = join(prefix, "pnpm/global/5/node_modules");
    const packageRoot = join(root, "@example/agent");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@example/agent", version: "1.0.0", bin: { example: "cli.js" } }),
    );
    await writeFile(join(packageRoot, "cli.js"), "binary");
    await writeFile(
      join(bin, "example"),
      '#!/bin/sh\nexec node "$basedir/../pnpm/global/5/node_modules/@example/agent/cli.js" "$@"\n',
    );
    await writeFile(join(bin, "pnpm"), "pnpm");
    const updater = new ProviderCliUpdater({
      isContainer: false,
      resolveBinary: async (name) => join(bin, name),
      execute: async (_command, args) => {
        if (args[0] === "bin") return { stdout: bin, stderr: "" };
        if (args[0] === "root") return { stdout: root, stderr: "" };
        if (args[0] === "list")
          return {
            stdout: JSON.stringify([{ dependencies: { "@example/agent": {} } }]),
            stderr: "",
          };
        return { stdout: "example 1.0.0", stderr: "" };
      },
    });
    const inspection = await updater.inspect({ provider: "example" });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(inspection.plan.command).toEqual([
      join(bin, "pnpm"),
      "add",
      "--global",
      "--global-dir",
      join(prefix, "pnpm/global"),
      "--global-bin-dir",
      bin,
      "@example/agent@latest",
    ]);
    expect(
      (await updater.update({ provider: "example", token: inspection.plan.token })).success,
    ).toBe(true);
  });

  it("warms and persists a catalog's pinned npx version rather than installing a global CLI", async () => {
    const { bin } = await installation();
    await writeFile(join(bin, "npx"), "npx");
    const calls: string[][] = [];
    const updater = new ProviderCliUpdater({
      isContainer: false,
      resolveBinary: async (name) => (name.startsWith("/") ? name : join(bin, name)),
      execute: async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: args[0] === "view" ? '"2.0.0"' : "10.0.0", stderr: "" };
      },
    });
    const settings = {
      command: {
        mode: "replace" as const,
        argv: ["npx", "-y", "@google/gemini-cli@1.0.0", "--acp"],
      },
    };
    const inspection = await updater.inspect({ provider: "gemini", settings });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    expect(inspection.plan).toMatchObject({
      updateMethod: "npx",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
    });
    const persistCommand = vi.fn().mockResolvedValue(undefined);
    expect(
      await updater.update({
        provider: "gemini",
        token: inspection.plan.token,
        settings,
        persistCommand,
      }),
    ).toMatchObject({ success: true, version: "2.0.0" });
    expect(persistCommand).toHaveBeenCalledExactlyOnceWith([
      "npx",
      "-y",
      "@google/gemini-cli@2.0.0",
      "--acp",
    ]);
    expect(calls.filter((call) => call[1] === "view")).toHaveLength(1);
    expect(calls.some((call) => call.includes("--global"))).toBe(false);
  });

  it("does not persist an npx version when package preparation fails", async () => {
    const { bin } = await installation();
    await writeFile(join(bin, "npx"), "npx");
    const updater = new ProviderCliUpdater({
      isContainer: false,
      resolveBinary: async (name) => (name.startsWith("/") ? name : join(bin, name)),
      execute: async (_command, args) => {
        if (args[0] === "exec") throw new Error("package download failed");
        return { stdout: args[0] === "view" ? '"2.0.0"' : "10.0.0", stderr: "" };
      },
    });
    const settings = {
      command: { mode: "replace" as const, argv: ["npx", "-y", "example-agent@1.0.0", "--acp"] },
    };
    const inspection = await updater.inspect({ provider: "example", settings });
    if (inspection.status !== "available") throw new Error(inspection.reason);
    const persistCommand = vi.fn();
    expect(
      await updater.update({
        provider: "example",
        settings,
        token: inspection.plan.token,
        persistCommand,
      }),
    ).toMatchObject({ success: false, error: "package download failed" });
    expect(persistCommand).not.toHaveBeenCalled();
  });
});
