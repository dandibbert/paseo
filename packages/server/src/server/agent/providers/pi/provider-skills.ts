import { promises as fs, type Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ProviderSkill } from "@getpaseo/protocol/messages";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import type { PiRpcSlashCommand } from "./rpc-types.js";

// Mirrors Pi's top-level skill discovery and `pi config` override format
// (pi-mono packages/coding-agent/src/core/package-manager.ts). Pi exposes no
// RPC for resource settings, so Paseo reads and writes settings.json directly.

type PiSkillScope = "user" | "project";
type PiSkillDiscoveryMode = "pi" | "agents";

interface PiSkillLocation {
  scope: PiSkillScope;
  mode: PiSkillDiscoveryMode;
  skillsDir: string;
  baseDir: string;
  settingsPath: string;
  source: string;
}

export interface PiSkillPaths {
  cwd: string;
  agentDir: string;
  homeDir?: string;
}

interface PiSkillFile {
  location: PiSkillLocation;
  filePath: string;
}

interface PiSkillHeader {
  name: string;
  description: string;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function findGitRepoRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const isGitRoot = await fs.access(path.join(current, ".git")).then(
      () => true,
      () => false,
    );
    if (isGitRoot) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function ancestorAgentsSkillDirs(cwd: string): Promise<string[]> {
  const dirs: string[] = [];
  const start = path.resolve(cwd);
  const gitRoot = await findGitRepoRoot(start);
  let dir = start;
  while (true) {
    dirs.push(path.join(dir, ".agents", "skills"));
    if (gitRoot && dir === gitRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

async function piSkillLocations(paths: PiSkillPaths): Promise<PiSkillLocation[]> {
  const home = paths.homeDir ?? homedir();
  const projectBaseDir = path.join(path.resolve(paths.cwd), ".pi");
  const projectSettingsPath = path.join(projectBaseDir, "settings.json");
  const userSettingsPath = path.join(paths.agentDir, "settings.json");
  const userAgentsSkillsDir = path.join(home, ".agents", "skills");

  const locations: PiSkillLocation[] = [
    {
      scope: "project",
      mode: "pi",
      skillsDir: path.join(projectBaseDir, "skills"),
      baseDir: projectBaseDir,
      settingsPath: projectSettingsPath,
      source: ".pi/skills",
    },
  ];
  for (const skillsDir of await ancestorAgentsSkillDirs(paths.cwd)) {
    if (path.resolve(skillsDir) === path.resolve(userAgentsSkillsDir)) continue;
    locations.push({
      scope: "project",
      mode: "agents",
      skillsDir,
      baseDir: path.dirname(skillsDir),
      settingsPath: projectSettingsPath,
      source: ".agents/skills",
    });
  }
  locations.push(
    {
      scope: "user",
      mode: "pi",
      skillsDir: path.join(paths.agentDir, "skills"),
      baseDir: paths.agentDir,
      settingsPath: userSettingsPath,
      source: "~/.pi/agent/skills",
    },
    {
      scope: "user",
      mode: "agents",
      skillsDir: userAgentsSkillsDir,
      baseDir: path.dirname(userAgentsSkillsDir),
      settingsPath: userSettingsPath,
      source: "~/.agents/skills",
    },
  );
  return locations;
}

async function entryKind(dir: string, entry: Dirent): Promise<"file" | "dir" | null> {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "dir";
  if (!entry.isSymbolicLink()) return null;
  const stats = await fs.stat(path.join(dir, entry.name)).catch(() => null);
  if (stats?.isFile()) return "file";
  if (stats?.isDirectory()) return "dir";
  return null;
}

async function collectSkillFiles(
  dir: string,
  root: string,
  mode: PiSkillDiscoveryMode,
): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  for (const entry of entries) {
    if (entry.name === "SKILL.md" && (await entryKind(dir, entry)) === "file") {
      return [path.join(dir, entry.name)];
    }
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const kind = await entryKind(dir, entry);
    const fullPath = path.join(dir, entry.name);
    const includeMarkdown =
      kind === "file" &&
      entry.name.endsWith(".md") &&
      ((mode === "pi" && dir === root) || (mode === "agents" && dir !== root));
    if (includeMarkdown) {
      files.push(fullPath);
      continue;
    }
    if (kind === "dir") {
      files.push(...(await collectSkillFiles(fullPath, root, mode)));
    }
  }
  return files;
}

function parseSkillHeader(markdown: string, filePath: string): PiSkillHeader | null {
  const fallbackName = path.basename(path.dirname(filePath));
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  let frontmatter: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed: unknown = parseYaml(match[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  // Pi skips skills without a description.
  if (!description.trim()) return null;
  const name =
    typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : fallbackName;
  return { name, description };
}

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(settingsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null || !raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Pi settings must contain a JSON object: ${settingsPath}`);
  }
  return parsed as Record<string, unknown>;
}

function readSkillEntries(settings: Record<string, unknown>): string[] {
  const value = settings.skills;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function expandTilde(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

interface PatternTargets {
  rel: string;
  name: string;
  absolute: string;
  parentRel: string | null;
  parentName: string | null;
  parentAbsolute: string | null;
}

function patternTargets(filePath: string, baseDir: string): PatternTargets {
  const isSkillFile = path.basename(filePath) === "SKILL.md";
  const parentDir = path.dirname(filePath);
  return {
    rel: toPosixPath(path.relative(baseDir, filePath)),
    name: path.basename(filePath),
    absolute: toPosixPath(filePath),
    parentRel: isSkillFile ? toPosixPath(path.relative(baseDir, parentDir)) : null,
    parentName: isSkillFile ? path.basename(parentDir) : null,
    parentAbsolute: isSkillFile ? toPosixPath(parentDir) : null,
  };
}

function matchesGlob(targets: PatternTargets, pattern: string, home: string): boolean {
  const normalized = toPosixPath(expandTilde(pattern, home));
  const candidates = [
    targets.rel,
    targets.name,
    targets.absolute,
    targets.parentRel,
    targets.parentName,
    targets.parentAbsolute,
  ];
  return candidates.some((candidate) => candidate !== null && minimatch(candidate, normalized));
}

function normalizeExactPattern(pattern: string, home: string): string {
  const stripped = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  return toPosixPath(path.normalize(expandTilde(stripped, home)));
}

function matchesExact(targets: PatternTargets, pattern: string, home: string): boolean {
  const normalized = normalizeExactPattern(pattern, home);
  return [targets.rel, targets.absolute, targets.parentRel, targets.parentAbsolute].some(
    (candidate) => candidate === normalized,
  );
}

function isEnabledByOverrides(
  filePath: string,
  entries: readonly string[],
  baseDir: string,
  home: string,
): boolean {
  const targets = patternTargets(filePath, baseDir);
  let enabled = true;
  if (
    entries.some((entry) => entry.startsWith("!") && matchesGlob(targets, entry.slice(1), home))
  ) {
    enabled = false;
  }
  if (
    entries.some((entry) => entry.startsWith("+") && matchesExact(targets, entry.slice(1), home))
  ) {
    enabled = true;
  }
  if (
    entries.some((entry) => entry.startsWith("-") && matchesExact(targets, entry.slice(1), home))
  ) {
    enabled = false;
  }
  return enabled;
}

async function discoverPiSkillFiles(paths: PiSkillPaths): Promise<PiSkillFile[]> {
  const files: PiSkillFile[] = [];
  const seen = new Set<string>();
  for (const location of await piSkillLocations(paths)) {
    for (const filePath of await collectSkillFiles(
      location.skillsDir,
      location.skillsDir,
      location.mode,
    )) {
      const key = path.resolve(filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ location, filePath });
    }
  }
  return files;
}

function loadedSkillPath(command: PiRpcSlashCommand): string | null {
  const value = command.sourceInfo?.path;
  return typeof value === "string" && value ? path.resolve(value) : null;
}

function loadedSkillSource(command: PiRpcSlashCommand): string {
  const source = command.sourceInfo?.source;
  return typeof source === "string" && source ? source : "pi";
}

function loadedSkillScope(command: PiRpcSlashCommand): string | null {
  const scope = command.sourceInfo?.scope;
  return typeof scope === "string" && scope ? scope : null;
}

export async function listPiProviderSkills(
  input: PiSkillPaths & { loadedCommands: readonly PiRpcSlashCommand[] },
): Promise<ProviderSkill[]> {
  const home = input.homeDir ?? homedir();
  const settingsCache = new Map<string, string[]>();
  const skillEntriesFor = async (settingsPath: string): Promise<string[]> => {
    const cached = settingsCache.get(settingsPath);
    if (cached) return cached;
    const entries = readSkillEntries(await readSettings(settingsPath));
    settingsCache.set(settingsPath, entries);
    return entries;
  };

  const skills: ProviderSkill[] = [];
  const discoveredPaths = new Set<string>();
  for (const { location, filePath } of await discoverPiSkillFiles(input)) {
    const raw = await fs.readFile(filePath, "utf8").catch(() => null);
    if (raw === null) continue;
    const header = parseSkillHeader(raw, filePath);
    if (!header) continue;
    discoveredPaths.add(path.resolve(filePath));
    const entries = await skillEntriesFor(location.settingsPath);
    skills.push({
      name: `skill:${header.name}`,
      description: header.description,
      enabled: isEnabledByOverrides(filePath, entries, location.baseDir, home),
      path: filePath,
      scope: location.scope,
      source: location.source,
      pluginId: null,
      toggleSupported: true,
      visibilityCycleSupported: false,
    });
  }

  // Skills from Pi packages, `skills` path entries, or CLI flags are loaded by
  // Pi but owned by that source; list them without a toggle.
  for (const command of input.loadedCommands) {
    if (command.source !== "skill") continue;
    const loadedPath = loadedSkillPath(command);
    if (loadedPath && discoveredPaths.has(loadedPath)) continue;
    skills.push({
      name: command.name,
      description: command.description ?? "",
      enabled: true,
      path: loadedPath,
      scope: loadedSkillScope(command),
      source: loadedSkillSource(command),
      pluginId: null,
      toggleSupported: false,
      visibilityCycleSupported: false,
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function setPiProviderSkillEnabled(
  input: PiSkillPaths & { path: string; enabled: boolean },
): Promise<void> {
  const target = path.resolve(input.path);
  const match = (await discoverPiSkillFiles(input)).find(
    (file) => path.resolve(file.filePath) === target,
  );
  if (!match) {
    throw new Error(`Pi skill is not in a Pi skills directory: ${input.path}`);
  }
  const { location } = match;
  const pattern = toPosixPath(path.relative(location.baseDir, match.filePath));
  const settings = await readSettings(location.settingsPath);
  const entries = readSkillEntries(settings).filter((entry) => {
    const isOverride = entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!");
    const stripped = isOverride ? entry.slice(1) : entry;
    return stripped !== pattern;
  });
  entries.push(`${input.enabled ? "+" : "-"}${pattern}`);
  settings.skills = entries;

  await fs.mkdir(path.dirname(location.settingsPath), { recursive: true });
  const tempPath = `${location.settingsPath}.paseo-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, location.settingsPath);
}
