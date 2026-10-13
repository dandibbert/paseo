import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";

interface TerminalSecureInputSheetProps {
  onClose: () => void;
  onSubmit: (secret: string, submitNewline: boolean) => Promise<void>;
  supported: boolean;
}

export function TerminalSecureInputSheet({
  onClose,
  onSubmit,
  supported,
}: TerminalSecureInputSheetProps) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState("");
  const [submitNewline, setSubmitNewline] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const header = useMemo(() => ({ title: t("workspace.terminal.secureInput.title") }), [t]);
  const newlineAccessibilityState = useMemo(() => ({ checked: submitNewline }), [submitNewline]);
  const toggleNewline = useCallback(() => setSubmitNewline((value) => !value), []);

  const close = useCallback(() => {
    if (sending) return;
    setSecret("");
    onClose();
  }, [onClose, sending]);

  const send = useCallback(async () => {
    if (!supported || !secret || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(secret, submitNewline);
      setSecret("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Secure input failed");
    } finally {
      setSending(false);
    }
  }, [onClose, onSubmit, secret, sending, submitNewline, supported]);
  const handleSendPress = useCallback(() => {
    void send();
  }, [send]);

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      desktopMaxWidth={460}
      testID="terminal-secure-input-sheet"
    >
      <View style={styles.body}>
        <Text style={styles.hint}>{t("workspace.terminal.secureInput.hint")}</Text>
        <Text style={styles.warning}>{t("workspace.terminal.secureInput.warning")}</Text>
        {!supported ? (
          <Text style={styles.error}>{t("workspace.terminal.secureInput.upgrade")}</Text>
        ) : (
          <>
            <Text style={styles.label}>{t("workspace.terminal.secureInput.label")}</Text>
            <AdaptiveTextInput
              testID="terminal-secure-input-field"
              accessibilityLabel={t("workspace.terminal.secureInput.label")}
              onChangeText={setSecret}
              secureTextEntry
              contextMenuHidden
              autoComplete="off"
              textContentType="password"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              editable={!sending}
              maxLength={8192}
              placeholder="••••••••"
              style={styles.input}
            />
            <Button
              variant="ghost"
              size="sm"
              onPress={toggleNewline}
              accessibilityRole="checkbox"
              accessibilityState={newlineAccessibilityState}
            >
              {submitNewline ? "☑ " : "☐ "}
              {t("workspace.terminal.secureInput.submitNewline")}
            </Button>
          </>
        )}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button variant="secondary" onPress={close} disabled={sending}>
            {t("workspace.terminal.secureInput.cancel")}
          </Button>
          {supported ? (
            <Button
              variant="default"
              testID="terminal-secure-input-submit"
              disabled={secret.length === 0 || sending}
              loading={sending}
              onPress={handleSendPress}
            >
              {t("workspace.terminal.secureInput.send")}
            </Button>
          ) : null}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  hint: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  warning: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    color: theme.colors.foreground,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    fontSize: theme.fontSize.base,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
