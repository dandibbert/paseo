import * as Clipboard from "expo-clipboard";
import { Copy, ExternalLink, Share2 } from "lucide-react-native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Dimensions, Share } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import {
  useAssistantFileLinkActions,
  useAssistantFileLinkEnvironment,
  type AssistantFileLinkSource,
} from "@/assistant-file-links";
import { FileActionsContextMenuContent } from "@/components/file-actions-menu";
import { useToast } from "@/contexts/toast-api-context";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  useContextMenu,
} from "@/components/ui/context-menu";
import { isNative } from "@/constants/platform";
import { useFileDownload } from "@/hooks/use-file-download";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { isHttpUrl } from "@/utils/http-url";
import { openExternalUrl } from "@/utils/open-external-url";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { describeMarkdownLink, type MarkdownLinkTarget } from "./link-target";

export interface LinkMenuRequest {
  source: AssistantFileLinkSource;
  /** Where to anchor the menu on wide layouts; compact layouts show a sheet. */
  point: { x: number; y: number } | null;
}

const OpenLinkMenuContext = createContext<((request: LinkMenuRequest) => void) | null>(null);

/** Opens the link menu of the enclosing Markdown surface: right click on web, long press on native. */
export function useOpenLinkMenu(): ((request: LinkMenuRequest) => void) | null {
  return useContext(OpenLinkMenuContext);
}

export function MarkdownLinkMenu({ children }: { children: ReactNode }): ReactElement {
  const [request, setRequest] = useState<LinkMenuRequest | null>(null);
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) setRequest(null);
  }, []);
  return (
    <ContextMenu open={request !== null} onOpenChange={handleOpenChange}>
      <LinkMenuOpener onRequest={setRequest}>{children}</LinkMenuOpener>
      {request ? <LinkMenuContent request={request} /> : null}
    </ContextMenu>
  );
}

function LinkMenuOpener({
  onRequest,
  children,
}: {
  onRequest: (request: LinkMenuRequest) => void;
  children: ReactNode;
}): ReactElement {
  const menu = useContextMenu();
  const open = useCallback(
    (request: LinkMenuRequest) => {
      const window = Dimensions.get("window");
      const point = request.point ?? { x: window.width / 2, y: window.height / 2 };
      menu.setAnchorRect({ x: point.x, y: point.y, width: 0, height: 0 });
      onRequest(request);
    },
    [menu, onRequest],
  );
  return <OpenLinkMenuContext.Provider value={open}>{children}</OpenLinkMenuContext.Provider>;
}

function LinkMenuContent({ request }: { request: LinkMenuRequest }): ReactElement | null {
  const environment = useAssistantFileLinkEnvironment();
  const target = useMemo(
    () =>
      describeMarkdownLink(request.source, {
        workspaceRoot: environment.workspaceRoot,
        relativePathBase: environment.relativePathBase,
      }),
    [environment.relativePathBase, environment.workspaceRoot, request.source],
  );
  if (!target) return null;
  if (target.kind === "url") return <UrlLinkMenu url={target.url} />;
  return <PathLinkMenu source={request.source} target={target} />;
}

const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedCopy = withUnistyles(Copy);
const ThemedShare = withUnistyles(Share2);
const openIcon = <ThemedExternalLink size={ICON_SIZE.sm} uniProps={mutedIcon} />;
const copyIcon = <ThemedCopy size={ICON_SIZE.sm} uniProps={mutedIcon} />;
const shareIcon = <ThemedShare size={ICON_SIZE.sm} uniProps={mutedIcon} />;

function UrlLinkMenu({ url }: { url: string }): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const openInBrowser = useCallback(() => void openExternalUrl(url), [url]);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(url).then(() => toast.copied());
  }, [toast, url]);
  const share = useCallback(() => {
    void Share.share({ url, message: url }).catch(() => undefined);
  }, [url]);
  return (
    <ContextMenuContent align="start" width={260} testID="markdown-link-menu">
      <ContextMenuLabel>{url}</ContextMenuLabel>
      {isHttpUrl(url) ? (
        <ContextMenuItem leading={openIcon} onSelect={openInBrowser}>
          {t("message.links.openInBrowser")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem leading={copyIcon} onSelect={copy} testID="markdown-link-copy">
        {t("message.links.copyLinkAddress")}
      </ContextMenuItem>
      {isNative ? (
        <ContextMenuItem leading={shareIcon} onSelect={share}>
          {t("message.links.share")}
        </ContextMenuItem>
      ) : null}
    </ContextMenuContent>
  );
}

type PathKind = "unknown" | "file" | "directory";

function usePathKind(serverId: string, absolutePath: string): PathKind {
  const client = useHostRuntimeClient(serverId);
  const [kind, setKind] = useState<PathKind>("unknown");
  useEffect(() => {
    if (!client) return;
    let current = true;
    // A folder lists; anything else, including a missing path, is treated as a file.
    client.listDirectory(absolutePath, ".").then(
      () => current && setKind("directory"),
      () => current && setKind("file"),
    );
    return () => {
      current = false;
    };
  }, [absolutePath, client]);
  return kind;
}

function PathLinkMenu({
  source,
  target,
}: {
  source: AssistantFileLinkSource;
  target: Extract<MarkdownLinkTarget, { kind: "path" }>;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const environment = useAssistantFileLinkEnvironment();
  const actions = useAssistantFileLinkActions();
  const serverId = environment.serverId ?? "";
  const workspaceRoot = environment.workspaceRoot ?? "";
  const kind = usePathKind(serverId, target.absolutePath);
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { targets } = useDesktopOpenTargets({ isLocalExecution: isLocalDaemon });
  const fileManager = targets.find((entry) => entry.kind === "file-manager");
  const download = useFileDownload({ serverId, workspaceRoot });

  const open = useCallback(() => actions.open(source, "preferred"), [actions, source]);
  const openToSide = useCallback(() => actions.open(source, "side"), [actions, source]);
  const copyPath = useCallback(() => {
    void Clipboard.setStringAsync(target.absolutePath).then(() => toast.copied());
  }, [target.absolutePath, toast]);
  const copyRelativePath = useCallback(() => {
    if (target.workspacePath) {
      void Clipboard.setStringAsync(target.workspacePath).then(() => toast.copied());
    }
  }, [target.workspacePath, toast]);
  const reveal = useCallback(() => {
    if (!fileManager) return;
    void openDesktopTarget({
      editorId: fileManager.id,
      workspacePath: workspaceRoot || target.absolutePath,
      filePath: target.absolutePath,
    }).catch((cause: unknown) =>
      toast.error(
        cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
      ),
    );
  }, [fileManager, t, target.absolutePath, toast, workspaceRoot]);
  const downloadFile = useCallback(() => {
    if (!target.workspacePath) return;
    const name = target.workspacePath.split("/").pop() ?? target.workspacePath;
    download({ fileName: name, path: target.workspacePath });
  }, [download, target.workspacePath]);

  const inWorkspace = target.workspacePath !== null && target.workspacePath !== ".";
  return (
    <FileActionsContextMenuContent
      header={target.absolutePath}
      fileKind={kind === "directory" ? "directory" : "file"}
      fileExists={kind === "file"}
      onOpenFile={open}
      onOpenFolder={open}
      onOpenToSide={openToSide}
      onCopyPath={copyPath}
      onCopyRelativePath={inWorkspace ? copyRelativePath : undefined}
      onReveal={fileManager ? reveal : undefined}
      revealTargetName={fileManager?.label}
      onDownload={inWorkspace ? downloadFile : undefined}
      testIDPrefix="markdown-path-link"
    />
  );
}
