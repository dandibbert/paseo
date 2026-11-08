import type { AssistantFileLinkSource } from "@/assistant-file-links";
import { classifyForResolution } from "@/assistant-file-links/resolver";
import { isAbsolutePath } from "@/utils/path";

/** What a Markdown link points at, for its context menu. */
export type MarkdownLinkTarget =
  | { kind: "url"; url: string }
  | {
      kind: "path";
      /** The path as the link wrote it, line suffix removed. */
      path: string;
      /** Absolute on the host, for copying and revealing; the written path when not resolvable. */
      absolutePath: string;
      /** Relative to the workspace root when inside it, for workspace file operations. */
      workspacePath: string | null;
    };

function trimTrailingSeparators(value: string): string {
  return value.length > 1 ? value.replace(/[\\/]+$/, "") : value;
}

function joinPath(base: string, relative: string): string {
  const cleanBase = trimTrailingSeparators(base);
  const cleanRelative = relative.replace(/^\.\//, "");
  if (!cleanRelative || cleanRelative === ".") return cleanBase;
  return `${cleanBase}/${cleanRelative}`;
}

function workspaceRelative(absolutePath: string, workspaceRoot: string | undefined): string | null {
  const root = workspaceRoot?.trim();
  if (!root) return null;
  const cleanRoot = trimTrailingSeparators(root.replace(/\\/g, "/"));
  const normalized = trimTrailingSeparators(absolutePath.replace(/\\/g, "/"));
  if (normalized === cleanRoot) return ".";
  return normalized.startsWith(`${cleanRoot}/`) ? normalized.slice(cleanRoot.length + 1) : null;
}

export function describeMarkdownLink(
  source: AssistantFileLinkSource,
  context: { workspaceRoot?: string; relativePathBase?: string },
): MarkdownLinkTarget | null {
  const resolution = classifyForResolution(source, context);
  let path: string;
  if (resolution.kind === "needsLookup") {
    path = resolution.target.path;
  } else if (resolution.value.kind === "external") {
    return { kind: "url", url: resolution.value.url };
  } else if (resolution.value.kind === "file") {
    path = resolution.value.target.path;
  } else {
    return null;
  }
  const base = context.relativePathBase?.trim() || context.workspaceRoot?.trim();
  const absolutePath = isAbsolutePath(path) || !base ? path : joinPath(base, path);
  return {
    kind: "path",
    path,
    absolutePath,
    workspacePath: isAbsolutePath(absolutePath)
      ? workspaceRelative(absolutePath, context.workspaceRoot)
      : null,
  };
}
