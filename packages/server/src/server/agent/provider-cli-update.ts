import { gt } from "semver";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute, basename } from "node:path";
import { z } from "zod";
import type {
  ProviderCliUpdateInspection,
  ProviderCliUpdatePlan,
  ProviderCliUpdateResult,
} from "@getpaseo/protocol/provider-cli-update";
import {
  findExecutable,
  findExecutableWithoutProbing,
} from "../../executable-resolution/executable-resolution.js";
import { execCommand, spawnProcess } from "../../utils/spawn.js";
import { toDiagnosticErrorMessage } from "./providers/diagnostic-utils.js";
import {
  createProviderEnv,
  createProviderEnvSpec,
  type ProviderRuntimeSettings,
} from "./provider-launch-config.js";

const PackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]),
});
const NpmSchema = z.object({ name: z.literal("npm") });
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/);
const PLAN_LIFETIME_MS = 10 * 60 * 1000;
const PackageNameSchema = z.string().regex(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/);
const BrewInfoSchema = z.object({
  formulae: z.array(z.object({ full_name: z.string(), installed: z.array(z.unknown()) })),
  casks: z.array(z.object({ token: z.string(), installed: z.unknown() })),
});

export class ProviderCliUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderCliUpdateError";
  }
}

function executeUpdate(
  command: string,
  args: string[],
  prefix: string,
  settings?: ProviderRuntimeSettings,
): Promise<string> {
  return new Promise((resolveUpdate, reject) => {
    const child = spawnProcess(command, args, {
      ...createProviderEnvSpec({ runtimeSettings: settings }),
      cwd: prefix,
      detached: true,
      envOverlay: {
        ...createProviderEnvSpec({ runtimeSettings: settings }).envOverlay,
        PATH: `${dirname(command)}:${createProviderEnv({ runtimeSettings: settings }).PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    function append(chunk: Buffer) {
      output = (output + chunk.toString("utf8")).slice(-64 * 1024);
    }
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      // npm can own lifecycle-script children. Stop the entire update group before unlocking.
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
            child.kill("SIGKILL");
        }
      }
    }, 300000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolveUpdate(output.trim());
      else
        reject(
          new ProviderCliUpdateError(
            `${timedOut ? "CLI update timed out" : `CLI update exited with code ${code}`}\n${output}`.trim(),
          ),
        );
    });
  });
}

interface InspectionInput {
  provider: string;
  settings?: ProviderRuntimeSettings;
  baseProvider?: string;
  defaultCommand?: string;
}

interface UpdateInput {
  provider: string;
  token: string;
  settings?: ProviderRuntimeSettings;
  baseProvider?: string;
  defaultCommand?: string;
  persistCommand?: (command: string[]) => Promise<void>;
}

interface Installation {
  kind: "npm";
  binaryPath: string;
  binaryTarget: string;
  packageRoot: string;
  prefix: string;
  npm: string;
  npmTarget: string;
  packageName: string;
  version: string;
}

interface NativeInstallation {
  kind: "managed";
  method: string;
  binaryPath: string;
  binaryTarget: string;
  version: string;
  cwd: string;
  command: string[];
  modifiedAt: number;
  size: number;
  updaterTarget: string;
  nextCommand?: string[];
}

const NATIVE_COMMANDS: Readonly<Record<string, string>> = {
  claude: "claude",
  opencode: "opencode",
  cursor: "cursor-agent",
  goose: "goose",
  omp: "omp",
  muse: "muse",
};

interface PreparedUpdate {
  plan: ProviderCliUpdatePlan;
  installation: Installation | NativeInstallation;
  input: InspectionInput;
  expiresAt: number;
}

interface UpdaterOptions {
  resolveBinary?: typeof findExecutable;
  execute?: typeof execCommand;
  isContainer?: boolean;
  home?: string;
}

export class ProviderCliUpdater {
  private readonly plans = new Map<string, PreparedUpdate>();
  private readonly resolveBinary: typeof findExecutable;
  private readonly lookupUpdater: (
    command: string,
    input: InspectionInput,
  ) => Promise<string | null>;
  private readonly execute: typeof execCommand;
  private readonly install: (
    command: string,
    args: string[],
    prefix: string,
    settings?: ProviderRuntimeSettings,
  ) => Promise<string>;
  private readonly isContainer: Promise<boolean>;
  private readonly home: string;
  private updating = false;

  constructor(options: UpdaterOptions = {}) {
    this.resolveBinary = options.resolveBinary ?? findExecutable;
    this.lookupUpdater = options.resolveBinary
      ? (command, input) =>
          this.resolveBinary(command, {
            env: createProviderEnv({ runtimeSettings: input.settings }),
          })
      : (command, input) =>
          findExecutableWithoutProbing(command, {
            cwd: this.home,
            path: createProviderEnv({ runtimeSettings: input.settings }).PATH,
          });
    this.execute = options.execute ?? execCommand;
    this.install = options.execute
      ? async (command, args, prefix, settings) => {
          const result = await this.execute(command, args, {
            ...createProviderEnvSpec({ runtimeSettings: settings }),
            cwd: prefix,
            timeout: 300000,
            killSignal: "SIGKILL",
            maxBuffer: 512 * 1024,
          });
          return `${result.stdout}\n${result.stderr}`.trim();
        }
      : executeUpdate;
    this.isContainer =
      options.isContainer === undefined
        ? access("/.dockerenv").then(
            () => true,
            () => false,
          )
        : Promise.resolve(options.isContainer);
    this.home = options.home ?? homedir();
  }

  async inspect(input: InspectionInput): Promise<ProviderCliUpdateInspection> {
    if (process.platform === "win32" || (await this.isContainer)) {
      return {
        status: "unavailable",
        reason:
          "Update this CLI using its installer or container image. In-app updates currently run on macOS and Linux hosts outside containers.",
      };
    }
    try {
      const managed = await this.managedInstallation(input);
      if (managed) return this.prepareManaged(input, managed);
      const installation = await this.installation(input);
      const { stdout } = await this.execute(
        installation.npm,
        ["view", `${installation.packageName}@latest`, "version", "--json"],
        {
          ...createProviderEnvSpec({ runtimeSettings: input.settings }),
          cwd: installation.prefix,
          timeout: 30000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        },
      );
      const latestVersion = VersionSchema.parse(JSON.parse(stdout));
      if (!gt(latestVersion, VersionSchema.parse(installation.version))) {
        return {
          status: "unavailable",
          reason: `This CLI is up to date (${installation.version}).`,
        };
      }
      const plan: ProviderCliUpdatePlan = {
        token: randomUUID(),
        provider: input.provider,
        hostname: hostname(),
        binaryPath: installation.binaryPath,
        currentVersion: installation.version,
        latestVersion,
        updateMethod: "npm",
        command: [
          installation.npm,
          "install",
          "--global",
          "--prefix",
          installation.prefix,
          "--no-audit",
          "--no-fund",
          `${installation.packageName}@${latestVersion}`,
        ],
      };
      this.prunePlans();
      // Inspections are unprivileged; keep their retained state bounded.
      if (this.plans.size >= 64) this.plans.clear();
      this.plans.set(plan.token, {
        plan,
        installation,
        input: structuredClone(input),
        expiresAt: Date.now() + PLAN_LIFETIME_MS,
      });
      return { status: "available", plan };
    } catch (error) {
      return { status: "unavailable", reason: toDiagnosticErrorMessage(error) };
    }
  }

  async update(input: UpdateInput): Promise<ProviderCliUpdateResult> {
    this.prunePlans();
    const prepared = this.plans.get(input.token);
    if (!prepared || prepared.plan.provider !== input.provider) {
      throw new ProviderCliUpdateError("Check for updates again before updating this CLI.");
    }
    if (this.updating)
      throw new ProviderCliUpdateError("Another CLI update is in progress. Wait for it to finish.");
    this.updating = true;
    this.plans.delete(input.token);
    let output = "";
    try {
      const configuration = {
        provider: input.provider,
        settings: input.settings,
        baseProvider: input.baseProvider,
        defaultCommand: input.defaultCommand,
      };
      if (
        JSON.stringify(configuration) !==
        JSON.stringify({
          provider: prepared.input.provider,
          settings: prepared.input.settings,
          baseProvider: prepared.input.baseProvider,
          defaultCommand: prepared.input.defaultCommand,
        })
      )
        throw new ProviderCliUpdateError(
          "The provider configuration changed. Check for updates again.",
        );
      if (prepared.installation.kind === "managed")
        return await this.updateManaged(prepared, input.persistCommand);
      const current = await this.installation(prepared.input);
      if (JSON.stringify(current) !== JSON.stringify(prepared.installation)) {
        throw new ProviderCliUpdateError("The CLI installation changed. Check for updates again.");
      }
      const [command, ...args] = prepared.plan.command;
      output = await this.install(command, args, current.prefix, prepared.input.settings);
      const updated = await this.installation(prepared.input);
      if (
        updated.binaryPath !== current.binaryPath ||
        updated.prefix !== current.prefix ||
        updated.version !== prepared.plan.latestVersion
      ) {
        throw new ProviderCliUpdateError(
          "The command finished, but the selected CLI did not resolve to the requested version. Check its installation manually.",
        );
      }
      const version = await this.execute(updated.binaryPath, ["--version"], {
        ...createProviderEnvSpec({ runtimeSettings: input.settings }),
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024,
      });
      const reportedVersion = version.stdout.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?/)?.[0];
      if (reportedVersion !== prepared.plan.latestVersion) {
        throw new ProviderCliUpdateError(
          "The CLI version probe did not report the requested version. Check the installation manually.",
        );
      }
      return { success: true, version: version.stdout.trim(), output, error: null };
    } catch (error) {
      return { success: false, version: null, output, error: toDiagnosticErrorMessage(error) };
    } finally {
      this.updating = false;
    }
  }

  private prepareManaged(
    input: InspectionInput,
    installation: NativeInstallation,
  ): ProviderCliUpdateInspection {
    const plan: ProviderCliUpdatePlan = {
      token: randomUUID(),
      provider: input.provider,
      hostname: hostname(),
      binaryPath: installation.binaryPath,
      currentVersion: installation.version,
      latestVersion:
        installation.nextCommand
          ?.find((argument) => /@\d+\.\d+\.\d+/.test(argument))
          ?.split("@")
          .at(-1) ?? "unknown",
      updateMethod: installation.method,
      command: installation.command,
      updatedCommand: installation.nextCommand,
    };
    this.prunePlans();
    if (this.plans.size >= 64) this.plans.clear();
    this.plans.set(plan.token, {
      plan,
      installation,
      input: structuredClone(input),
      expiresAt: Date.now() + PLAN_LIFETIME_MS,
    });
    return { status: "available", plan };
  }

  private commandName(input: InspectionInput): string {
    if (input.settings?.command?.mode === "replace") return input.settings.command.argv[0];
    return (
      input.defaultCommand ??
      NATIVE_COMMANDS[input.baseProvider ?? input.provider] ??
      input.baseProvider ??
      input.provider
    );
  }

  private async resolveCommand(command: string, input: InspectionInput): Promise<string> {
    const binary = await this.resolveBinary(command, {
      env: {
        ...createProviderEnv({ runtimeSettings: input.settings }),
        MUSE_NO_AUTO_UPDATE: "1",
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      },
    });
    if (!binary)
      throw new ProviderCliUpdateError(
        `The CLI executable ${command} was not found on the daemon's PATH.`,
      );
    return binary;
  }

  private async probe(binary: string, input: InspectionInput): Promise<string> {
    const result = await this.execute(binary, ["--version"], {
      ...createProviderEnvSpec({ runtimeSettings: input.settings }),
      envOverlay: {
        ...createProviderEnvSpec({ runtimeSettings: input.settings }).envOverlay,
        MUSE_NO_AUTO_UPDATE: "1",
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      },
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024,
    });
    if (!result.stdout.trim())
      throw new ProviderCliUpdateError("The CLI did not report its version.");
    return result.stdout.trim();
  }

  private async resolveUpdater(command: string, input: InspectionInput): Promise<string> {
    // Inspection is daemon.read: resolving a configured updater must not execute it.
    const binary = await this.lookupUpdater(command, input);
    if (!binary)
      throw new ProviderCliUpdateError(
        `The updater ${command} was not found on the daemon's PATH.`,
      );
    return binary;
  }

  private async managedSnapshot(
    input: InspectionInput,
    binaryPath: string,
    method: string,
    command: string[],
    cwd: string,
  ): Promise<NativeInstallation> {
    const binaryTarget = await realpath(binaryPath);
    const binary = await stat(binaryTarget);
    if (!binary.isFile())
      throw new ProviderCliUpdateError("The selected CLI is not a regular file.");
    return {
      kind: "managed",
      method,
      binaryPath,
      binaryTarget,
      version: await this.probe(binaryPath, input),
      cwd,
      command,
      modifiedAt: binary.mtimeMs,
      size: binary.size,
      updaterTarget: await realpath(command[0]),
    };
  }

  private async managedInstallation(
    input: InspectionInput,
    pinnedCatalogCommand?: string[],
  ): Promise<NativeInstallation | null> {
    const binaryPath = await this.resolveCommand(this.commandName(input), input);
    if (input.settings?.updateCommand) {
      const [executable, ...args] = input.settings.updateCommand;
      const updater = await this.resolveUpdater(executable, input);
      return this.managedSnapshot(input, binaryPath, "custom", [updater, ...args], this.home);
    }
    const catalog = await this.catalogInstallation(input, binaryPath, pinnedCatalogCommand);
    if (catalog) return catalog;
    const binaryTarget = await realpath(binaryPath);
    const brew = await this.brewInstallation(input, binaryPath, binaryTarget);
    if (brew) return brew;
    const manager = await this.packageManagerInstallation(input, binaryPath, binaryTarget);
    if (manager) return manager;
    if ((input.baseProvider ?? input.provider) === "antigravity")
      throw new ProviderCliUpdateError(
        "Antigravity's native CLI updates itself in the background. No standalone update command is documented. Configure updateCommand for your installer if needed.",
      );
    return this.nativeInstallation(input, binaryPath, binaryTarget);
  }

  private async nativeInstallation(
    input: InspectionInput,
    binaryPath: string,
    binaryTarget: string,
  ): Promise<NativeInstallation | null> {
    const provider = input.baseProvider ?? input.provider;
    if (provider === "muse") return this.museInstallation(input, binaryPath, binaryTarget);
    if (!Object.hasOwn(NATIVE_COMMANDS, provider)) return null;
    const name = NATIVE_COMMANDS[provider];
    let ownedRoot: string;
    let command: string[];
    if (provider === "opencode") {
      ownedRoot = join(this.home, ".opencode");
      if (binaryPath !== join(ownedRoot, "bin", name) || binaryTarget !== binaryPath) return null;
      command = [binaryPath, "upgrade", "--method", "curl"];
    } else if (provider === "goose" || provider === "omp") {
      ownedRoot = join(this.home, ".local", "bin");
      if (binaryPath !== join(ownedRoot, name) || binaryTarget !== binaryPath) return null;
      command = [binaryPath, "update"];
    } else {
      ownedRoot = join(this.home, ".local", "share", name);
      const target = relative(join(ownedRoot, "versions"), binaryTarget);
      const outsideVersions = !target || target.startsWith("..") || isAbsolute(target);
      const isLauncher =
        binaryPath === join(this.home, ".local", "bin", name) ||
        (provider === "cursor" && binaryPath === join(this.home, ".local", "bin", "agent"));
      if (!isLauncher || outsideVersions) return null;
      command = [binaryPath, "update"];
    }
    await access(ownedRoot, constants.W_OK);
    await access(dirname(binaryPath), constants.W_OK);
    return this.managedSnapshot(input, binaryPath, "native", command, ownedRoot);
  }

  private async museInstallation(
    input: InspectionInput,
    binaryPath: string,
    binaryTarget: string,
  ): Promise<NativeInstallation | null> {
    const ownedRoot = join(this.home, ".local", "bin");
    if (binaryPath !== join(ownedRoot, "muse") || binaryTarget !== binaryPath) return null;
    const launcher = await readFile(binaryPath, "utf8");
    if (!launcher.includes("MUSE_LAUNCHER_INSTALL") || !launcher.includes("update_binary"))
      return null;
    await access(ownedRoot, constants.W_OK);
    const env = await this.resolveUpdater("env", input);
    // This is the synchronous mode used by Meta's installer, not a background update.
    return this.managedSnapshot(
      input,
      binaryPath,
      "native",
      [env, "MUSE_LAUNCHER_INSTALL=1", binaryPath],
      ownedRoot,
    );
  }

  private async updateManaged(
    prepared: PreparedUpdate,
    persistCommand?: (command: string[]) => Promise<void>,
  ): Promise<ProviderCliUpdateResult> {
    const expected = prepared.installation;
    const pinned = expected.kind === "managed" ? expected.nextCommand : undefined;
    const current = await this.managedInstallation(prepared.input, pinned);
    if (!current || JSON.stringify(current) !== JSON.stringify(prepared.installation))
      throw new ProviderCliUpdateError("The CLI installation changed. Check for updates again.");
    const [command, ...args] = current.command;
    if (current.nextCommand && !persistCommand)
      throw new ProviderCliUpdateError("This host cannot persist updated launcher versions.");
    const output = await this.install(command, args, current.cwd, prepared.input.settings);
    if (current.nextCommand) {
      if (!persistCommand)
        throw new ProviderCliUpdateError("This host cannot persist updated launcher versions.");
      await persistCommand(current.nextCommand);
      return { success: true, version: prepared.plan.latestVersion, output, error: null };
    }
    // Do not query a moving latest tag again: inspect the selected executable after updating.
    const updated = await this.managedInstallation(prepared.input);
    if (!updated || updated.binaryPath !== current.binaryPath || updated.method !== current.method)
      throw new ProviderCliUpdateError(
        `The updater changed the selected installation method or executable path. Check its installation.\n${output}`,
      );
    const version = updated.version;
    const before = current.version.match(/\d+\.\d+\.\d+/)?.[0];
    const after = version.match(/\d+\.\d+\.\d+/)?.[0];
    if (before && after && gt(before, after))
      throw new ProviderCliUpdateError(
        `The updater reported an older CLI version. Check its release channel.\n${output}`,
      );
    return { success: true, version, output, error: null };
  }

  private async brewInstallation(
    input: InspectionInput,
    binary: string,
    target: string,
  ): Promise<NativeInstallation | null> {
    // A global npm CLI can live beneath Homebrew's Node formula; upgrading Node
    // would leave that CLI unchanged and mutate an unrelated runtime.
    if (target.includes("/node_modules/")) return null;
    const match = /^(.*)\/(Cellar|Caskroom)\/([^/]+)\//.exec(target);
    if (!match) return null;
    const [, prefix, store, name] = match;
    const brew = join(prefix, "bin", "brew");
    await access(brew, constants.X_OK);
    const kind = store === "Cellar" ? "--formula" : "--cask";
    const info = await this.execute(brew, ["info", "--json=v2", kind, name], {
      ...createProviderEnvSpec({ runtimeSettings: input.settings }),
      envOverlay: {
        ...createProviderEnvSpec({ runtimeSettings: input.settings }).envOverlay,
        HOMEBREW_NO_AUTO_UPDATE: "1",
      },
      timeout: 30000,
      maxBuffer: 512 * 1024,
    });
    const parsed = BrewInfoSchema.parse(JSON.parse(info.stdout));
    const owned =
      store === "Cellar"
        ? parsed.formulae.some(
            (formula) =>
              formula.full_name.split("/").at(-1) === name && formula.installed.length > 0,
          )
        : parsed.casks.some((cask) => cask.token === name && Boolean(cask.installed));
    if (!owned)
      throw new ProviderCliUpdateError(
        "Homebrew did not confirm ownership of this CLI installation.",
      );
    await access(join(prefix, store), constants.W_OK);
    return this.managedSnapshot(input, binary, "brew", [brew, "upgrade", kind, name], prefix);
  }

  private async findPackageName(binary: string): Promise<string> {
    const target = await realpath(binary);
    let directory = dirname(target);
    while (directory !== dirname(directory)) {
      try {
        const manifest = PackageSchema.parse(
          JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
        );
        const entries =
          typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin);
        if (entries.some((entry) => resolve(directory, entry) === target))
          return PackageNameSchema.parse(manifest.name);
      } catch (error) {
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
        if (!(error instanceof z.ZodError) && !(error instanceof SyntaxError) && !missing)
          throw error;
      }
      directory = dirname(directory);
    }
    throw new ProviderCliUpdateError(
      "Could not identify this CLI's installer. Configure updateCommand for this provider on the host.",
    );
  }

  private async packageManagerInstallation(
    input: InspectionInput,
    binary: string,
    target: string,
  ): Promise<NativeInstallation | null> {
    const env = createProviderEnv({ runtimeSettings: input.settings });
    const bunRoot =
      env.BUN_INSTALL_GLOBAL_DIR ??
      join(env.BUN_INSTALL ?? join(this.home, ".bun"), "install", "global");
    const bunRelative = relative(join(bunRoot, "node_modules"), target);
    if (bunRelative.startsWith("..") || isAbsolute(bunRelative))
      return this.pnpmInstallation(input, binary, target);
    const packageName = await this.findPackageName(binary);
    const manifest = PackageSchema.parse(
      JSON.parse(
        await readFile(join(bunRoot, "node_modules", packageName, "package.json"), "utf8"),
      ),
    );
    const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin[basename(binary)];
    if (!entry || (await realpath(resolve(bunRoot, "node_modules", packageName, entry))) !== target)
      throw new ProviderCliUpdateError(
        "Could not verify Bun's global package ownership for this CLI.",
      );
    const bun = await this.resolveUpdater("bun", input);
    const { stdout } = await this.execute(bun, ["pm", "bin", "--global"], {
      ...createProviderEnvSpec({ runtimeSettings: input.settings }),
      timeout: 10000,
      maxBuffer: 64 * 1024,
    });
    if (dirname(binary) !== stdout.trim()) return null;
    await access(bunRoot, constants.W_OK);
    return this.managedSnapshot(
      input,
      binary,
      "bun",
      [bun, "add", "--global", `${packageName}@latest`],
      this.home,
    );
  }

  private async pnpmInstallation(
    input: InspectionInput,
    binary: string,
    target: string,
  ): Promise<NativeInstallation | null> {
    // pnpm exposes generated shell shims as well as symlinks, so verify both its bin and package roots.
    const size = (await stat(binary)).size;
    const text = size < 64 * 1024 ? await readFile(binary, "utf8") : "";
    const isGlobalShim = text.includes("$basedir/") && text.includes("/global/");
    const looksLikePnpm = target.includes("/pnpm/") || isGlobalShim;
    if (!looksLikePnpm) return null;
    const pnpm = await this.resolveUpdater("pnpm", input);
    const options = {
      ...createProviderEnvSpec({ runtimeSettings: input.settings }),
      timeout: 10000,
      maxBuffer: 64 * 1024,
    };
    const bin = (await this.execute(pnpm, ["bin", "--global"], options)).stdout.trim();
    const root = (await this.execute(pnpm, ["root", "--global"], options)).stdout.trim();
    if (!isAbsolute(root) || dirname(binary) !== bin) return null;
    const listing = await this.execute(
      pnpm,
      ["list", "--global", "--depth", "0", "--json"],
      options,
    );
    const packages = z
      .array(z.object({ dependencies: z.record(z.string(), z.unknown()).optional() }))
      .parse(JSON.parse(listing.stdout));
    for (const name of Object.keys(packages[0]?.dependencies ?? {})) {
      const packageName = PackageNameSchema.parse(name);
      const packageRoot = join(root, packageName);
      const manifest = PackageSchema.parse(
        JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
      );
      const entry =
        typeof manifest.bin === "string" ? manifest.bin : manifest.bin[basename(binary)];
      if (!entry || manifest.name !== packageName) continue;
      const expected = resolve(packageRoot, entry);
      const shimEntry = `"$basedir/${relative(bin, expected)}"`;
      if (target !== (await realpath(expected)) && !text.includes(shimEntry)) continue;
      await access(packageRoot, constants.W_OK);
      await access(bin, constants.W_OK);
      return this.managedSnapshot(
        input,
        binary,
        "pnpm",
        [
          pnpm,
          "add",
          "--global",
          "--global-dir",
          dirname(dirname(root)),
          "--global-bin-dir",
          bin,
          `${packageName}@latest`,
        ],
        this.home,
      );
    }
    throw new ProviderCliUpdateError("Could not verify the package behind this pnpm launcher.");
  }

  private async catalogInstallation(
    input: InspectionInput,
    binary: string,
    pinned?: string[],
  ): Promise<NativeInstallation | null> {
    const configured = input.settings?.command;
    if (configured?.mode !== "replace" || basename(binary) !== "npx") return null;
    const argv = configured.argv;
    const specIndex = argv[1] === "-y" || argv[1] === "--yes" ? 2 : 1;
    const match = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(
      argv[specIndex] ?? "",
    );
    if (!match)
      throw new ProviderCliUpdateError(
        "This npx launcher is not pinned to a package version. Configure updateCommand for this provider.",
      );
    const [, name, current] = match;
    const npm = await this.resolveUpdater(join(dirname(binary), "npm"), input);
    const latest = pinned
      ? VersionSchema.parse(pinned[specIndex].slice(name.length + 1))
      : VersionSchema.parse(
          JSON.parse(
            (
              await this.execute(npm, ["view", `${name}@latest`, "version", "--json"], {
                ...createProviderEnvSpec({ runtimeSettings: input.settings }),
                timeout: 30000,
                maxBuffer: 64 * 1024,
              })
            ).stdout,
          ),
        );
    if (!gt(latest, current))
      throw new ProviderCliUpdateError(`This CLI is up to date (${current}).`);
    const next = [...argv];
    next[specIndex] = `${name}@${latest}`;
    const snapshot = await this.managedSnapshot(
      input,
      binary,
      "npx",
      [npm, "exec", "--yes", `--package=${name}@${latest}`, "--", "node", "-e", ""],
      this.home,
    );
    // Warm the pinned package without launching an ACP server, then persist only after success.
    return { ...snapshot, version: current, nextCommand: next };
  }

  private prunePlans(): void {
    for (const [token, prepared] of this.plans) {
      if (prepared.expiresAt <= Date.now()) this.plans.delete(token);
    }
  }

  private async installation(input: InspectionInput): Promise<Installation> {
    const binaryPath = await this.resolveCommand(this.commandName(input), input);
    const packageName = await this.findPackageName(binaryPath);
    const prefix = dirname(dirname(binaryPath));
    if (dirname(binaryPath) !== join(prefix, "bin")) {
      throw new ProviderCliUpdateError(
        "This CLI is not a supported npm global installation. Update it with its original installer.",
      );
    }
    const packageRoot = join(prefix, "lib", "node_modules", packageName);
    const binaryTarget = await realpath(binaryPath);
    let manifest: z.infer<typeof PackageSchema>;
    try {
      manifest = PackageSchema.parse(
        JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
      );
    } catch {
      throw new ProviderCliUpdateError(
        "Could not verify an npm global installation for this CLI. Use its original installer (for example Homebrew or the native installer).",
      );
    }
    const entry =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin[basename(binaryPath)];
    const matchesPackage =
      manifest.name === packageName && entry && binaryTarget === resolve(packageRoot, entry);
    if (!matchesPackage)
      throw new ProviderCliUpdateError(
        "The CLI does not point to the expected npm package. Update it manually.",
      );
    const npm = join(prefix, "bin", "npm");
    const npmTarget = await realpath(npm);
    const npmRoot = join(prefix, "lib", "node_modules", "npm");
    NpmSchema.parse(JSON.parse(await readFile(join(npmRoot, "package.json"), "utf8")));
    if (npmTarget !== join(npmRoot, "bin", "npm-cli.js")) {
      throw new ProviderCliUpdateError(
        "Could not verify npm for this CLI's installation prefix. Update the CLI manually.",
      );
    }
    await access(packageRoot, constants.W_OK);
    await access(dirname(packageRoot), constants.W_OK);
    await access(dirname(binaryPath), constants.W_OK);
    return {
      kind: "npm",
      binaryPath,
      binaryTarget,
      packageRoot,
      prefix,
      npm,
      npmTarget,
      packageName,
      version: manifest.version,
    };
  }
}
