import { Clock } from "lucide-react-native";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";

const ThemedClock = withUnistyles(Clock);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function formatResumeTime(dueAt: string): string {
  return new Date(dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Shown while the host waits to send a continue message after a rate-limited turn. Sending a
 * message yourself also cancels it; the button cancels it without sending anything.
 */
export function RateLimitResumeBar({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const resume = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.rateLimitResume ?? null,
  );
  const [isCancelling, setIsCancelling] = useState(false);

  const handleCancel = useCallback(async () => {
    if (!client) return;
    setIsCancelling(true);
    try {
      const result = await client.cancelRateLimitResume(agentId);
      if (result.error) toast.error(result.error);
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setIsCancelling(false);
    }
  }, [agentId, client, toast]);

  if (!resume) return null;

  return (
    <View style={styles.container} testID="composer-rate-limit-resume">
      <ThemedClock size={14} uniProps={mutedIcon} />
      <Text style={styles.text} numberOfLines={2}>
        {t("rateLimitResume.scheduled", {
          time: formatResumeTime(resume.dueAt),
          attempt: resume.attempt,
        })}
      </Text>
      <Button
        size="sm"
        variant="ghost"
        onPress={handleCancel}
        disabled={isCancelling || !client}
        testID="composer-rate-limit-resume-cancel"
      >
        {t("rateLimitResume.cancel")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  text: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
