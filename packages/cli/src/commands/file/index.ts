import { Command } from "commander";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  createPaseoApi,
  toDaemonFileLocation,
  type PaseoApi,
  type PaseoFileError,
} from "@getpaseo/client";
import {
  withOutput,
  type CommandOptions,
  type CommandResult,
  type OutputSchema,
} from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import { destinationFilePath, resolveFileEndpoint, type FileEndpoint } from "./endpoint.js";

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

interface CopyOptions extends CommandOptions {
  overwrite?: boolean;
  parents?: boolean;
  maxBytes?: string;
}

interface CopyResult {
  source: string;
  destination: string;
  size: number;
}

const schema: OutputSchema<CopyResult> = {
  idField: "destination",
  columns: [
    { header: "SOURCE", field: "source" },
    { header: "DESTINATION", field: "destination" },
    { header: "BYTES", field: "size" },
  ],
};

function describe(endpoint: FileEndpoint, path: string): string {
  return endpoint.kind === "local" ? path : `${endpoint.label}:${path}`;
}

function expandLocal(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function parseMaxBytes(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw { code: "invalid_option", message: "--max-bytes must be a positive integer" };
  }
  return parsed;
}

function fileFailure(error: unknown, path: string): never {
  const code = (error as Partial<PaseoFileError>)?.code;
  if (code === "exists") {
    throw {
      code: "file_exists",
      message: `${path} already exists`,
      details: "Pass --overwrite to replace it",
    };
  }
  if (code === "unsupported") {
    throw { code: "host_update_required", message: (error as Error).message };
  }
  throw error;
}

async function readLocal(path: string, maxBytes: number): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile()) throw { code: "invalid_path", message: `${path} is not a file` };
  if (info.size > maxBytes) {
    throw {
      code: "file_too_large",
      message: `${path} is ${info.size} bytes, larger than --max-bytes (${maxBytes})`,
    };
  }
  return readFile(path);
}

async function writeLocal(
  path: string,
  bytes: Uint8Array,
  options: { overwrite: boolean; parents: boolean },
): Promise<string> {
  const target = path;
  if (options.parents) await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.paseo-put-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    if (options.overwrite) await rename(temporary, target);
    else
      await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") fileFailure({ code: "exists" }, target);
        throw error;
      });
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return target;
}

async function runCopy(
  sourceArg: string,
  destinationArg: string,
  options: CopyOptions,
): Promise<CommandResult<CopyResult>> {
  const maxBytes = parseMaxBytes(options.maxBytes);
  const flags = { overwrite: options.overwrite === true, parents: options.parents === true };
  const daemon = await connectToDaemon({ target: options.daemonTarget });
  const api = createPaseoApi(daemon);
  const scopes = new Map<string, PaseoApi>();
  const scope = async (endpoint: Extract<FileEndpoint, { kind: "host" }>) => {
    if (endpoint.self) return api;
    const existing = scopes.get(endpoint.serverId);
    if (existing) return existing;
    const created = await api.hosts.client(endpoint.serverId);
    scopes.set(endpoint.serverId, created);
    return created;
  };
  try {
    const directory = await daemon.listHosts();
    const source = resolveFileEndpoint(sourceArg, directory);
    const destination = resolveFileEndpoint(destinationArg, directory);

    let bytes: Uint8Array;
    if (source.kind === "local") {
      bytes = await readLocal(expandLocal(source.path), maxBytes);
    } else {
      const location = toDaemonFileLocation(source.path);
      const file = await (await scope(source)).files.read({ ...location, maxBytes });
      bytes = file.bytes;
    }

    const targetPath = destinationFilePath(destination.path, basename(source.path));
    let written: string;
    if (destination.kind === "local") {
      const localTarget = expandLocal(targetPath);
      const existing = await stat(localTarget).catch(() => null);
      written = await writeLocal(
        existing?.isDirectory() ? join(localTarget, basename(source.path)) : localTarget,
        bytes,
        flags,
      );
    } else {
      const location = toDaemonFileLocation(targetPath);
      const file = await (
        await scope(destination)
      ).files
        .write({
          ...location,
          bytes,
          overwrite: flags.overwrite,
          createParents: flags.parents,
        })
        .catch((error: unknown) => fileFailure(error, describe(destination, targetPath)));
      written = file.absolutePath;
    }

    return {
      type: "single",
      data: {
        source: describe(source, source.path),
        destination: describe(destination, written),
        size: bytes.byteLength,
      },
      schema,
    };
  } finally {
    await Promise.allSettled([...scopes.values()].map((entry) => entry.dispose()));
    await api.dispose().catch(() => undefined);
    await daemon.close();
  }
}

export function createFileCommand(): Command {
  const file = new Command("file").description(
    "Move files between this machine and hosts connected to the selected daemon",
  );
  addJsonAndDaemonHostOptions(
    file
      .command("cp")
      .description(
        "Copy one file. Write host files as <host>:<path>, where <host> is a label, server ID, or registration ID from `paseo host ls`, or `self` for the selected daemon. Unprefixed paths are on this machine. A destination ending in / keeps the source file name.",
      )
      .argument("<source>")
      .argument("<destination>")
      .option("--overwrite", "Replace an existing destination file")
      .option("-p, --parents", "Create missing destination directories")
      .option("--max-bytes <bytes>", `Refuse larger files (default ${DEFAULT_MAX_BYTES})`),
  ).action(
    withOutput((source: string, destination: string, options: CopyOptions, _command: Command) =>
      runCopy(source, destination, options),
    ),
  );
  return file;
}
