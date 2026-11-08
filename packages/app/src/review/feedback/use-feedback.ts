import { createElement, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  useReviewDraftComments,
  getReviewDraftComments,
  clearSentReviewDraftComments,
} from "../store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { deriveWorkspaceTabModel } from "@/screens/workspace/workspace-tab-model";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useAppSettings } from "@/hooks/use-settings";
import { dispatchComposerAgentMessage, queueComposerMessage } from "@/composer/actions";
import type { SendBehavior } from "@/composer/input/state";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useSessionStore, selectAgentTurnPresentation } from "@/stores/session-store";
import { FLOATING_ACTION_BUTTON_CLEARANCE } from "@/components/ui/floating-action-button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { controlHeightForLayout } from "@/components/ui/control-geometry";
import { SPACING } from "@/styles/theme";
import { i18n } from "@/i18n/i18next";
import {
  createReviewFeedbackScope,
  type FeedbackAttachment,
  type FeedbackRecipient,
} from "./index";
import { useToast } from "@/contexts/toast-context";
import { FeedbackSentMessage } from "./surface";

const feedbackScope = createReviewFeedbackScope();

export function useReviewFeedback(input: {
  reviewDraftKey: string;
  serverId: string;
  workspaceId?: string;
  attachment: FeedbackAttachment | null;
}) {
  const { serverId, reviewDraftKey, workspaceId } = input;
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const { settings } = useAppSettings();
  const comments = useReviewDraftComments(reviewDraftKey);
  const layout = useWorkspaceLayoutStore((store) =>
    workspaceKey ? store.layoutByWorkspace[workspaceKey] : undefined,
  );
  // The adapter keeps live host and diff inputs available to commands without reconstructing the workflow.
  const live = useRef({
    client,
    connected,
    attachment: input.attachment,
    sendBehavior: settings.sendBehavior,
    toast,
  });
  live.current = {
    client,
    connected,
    attachment: input.attachment,
    sendBehavior: settings.sendBehavior,
    toast,
  };
  const model = useMemo(
    () =>
      feedbackScope.connect(reviewDraftKey, {
        read: () => ({
          comments: getReviewDraftComments(reviewDraftKey) ?? [],
          attachment: live.current.attachment,
          connected: live.current.connected,
          recipients: readRecipients(workspaceKey),
        }),
        send: async (recipient, attachment) => {
          const { client: targetClient, sendBehavior } = live.current;
          if (!targetClient) throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
          const session = useSessionStore.getState().sessions[serverId];
          const turn = selectAgentTurnPresentation(session, recipient.agentId);
          const delivery = feedbackDelivery(sendBehavior, turn.isActive);
          if (delivery === "queue") {
            // The same per-agent queue the composer uses: sent once the agent's turn ends.
            queueComposerMessage({
              agentId: recipient.agentId,
              text: i18n.t("review.feedback.prompt"),
              attachments: [attachment],
              queue: {
                read: (id) =>
                  useSessionStore.getState().sessions[serverId]?.queuedMessages?.get(id) ?? [],
                write: (updater) => useSessionStore.getState().setQueuedMessages(serverId, updater),
              },
            });
            live.current.toast.show(
              createElement(FeedbackSentMessage, {
                recipient,
                serverId,
                workspaceId: workspaceId ?? "",
              }),
              { variant: "success" },
            );
            return;
          }
          const activeTurnBehavior = delivery;
          await dispatchComposerAgentMessage({
            client: targetClient,
            agentId: recipient.agentId,
            text: i18n.t("review.feedback.prompt"),
            attachments: [attachment],
            encodeImages: async () => [],
            submission: createMessageSubmissionWriter(serverId),
            activeTurnBehavior,
            activeTurnId: activeTurnBehavior === "steer" ? (turn.turnId ?? undefined) : undefined,
          });
          live.current.toast.show(
            createElement(FeedbackSentMessage, {
              recipient,
              serverId,
              workspaceId: workspaceId ?? "",
            }),
            { variant: "success" },
          );
        },
        clearSent: (sentComments) =>
          clearSentReviewDraftComments({ key: reviewDraftKey, comments: sentComments }),
        failedMessage: () => i18n.t("review.feedback.failed"),
      }),
    [reviewDraftKey, serverId, workspaceKey, workspaceId],
  );
  useEffect(() => {
    model.refresh();
  }, [model, comments, layout, connected, input.attachment]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return {
    model,
    state,
    clearance:
      state.commentCount > 0
        ? (isCompact
            ? FLOATING_ACTION_BUTTON_CLEARANCE
            : controlHeightForLayout("md", isCompact) + SPACING[4]) + 44
        : 0,
  };
}

/**
 * How feedback reaches an agent: the user's send setting decides only while the agent is mid-turn.
 * Queue waits for the turn to end, like the composer; it used to interrupt instead.
 */
export function feedbackDelivery(
  sendBehavior: SendBehavior,
  agentIsActive: boolean,
): "queue" | "steer" | "interrupt" {
  if (sendBehavior === "queue") return agentIsActive ? "queue" : "interrupt";
  return sendBehavior;
}

function readRecipients(workspaceKey: string | null): FeedbackRecipient[] {
  const tabs = workspaceKey
    ? useWorkspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)
    : [];
  const descriptors = deriveWorkspaceTabModel({ tabs }).tabs;
  const recipients: FeedbackRecipient[] = [];
  for (const { descriptor } of descriptors) {
    if (descriptor.target.kind === "agent")
      recipients.push({ agentId: descriptor.target.agentId, tab: descriptor });
  }
  return recipients;
}
