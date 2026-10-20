import { StyleSheet } from "react-native-unistyles";
import { GENUI_RADIUS, GENUI_SPACE, GENUI_TEXT } from "./tokens";

// Text and surface styles shared by GenUI components. Colors come from the GenUI
// tokens for the active scheme, never from the Paseo palette.
export const genuiStyles = StyleSheet.create((theme) => {
  const colors = theme.genui;
  return {
    caption: {
      ...GENUI_TEXT.sm,
      color: colors.textSecondary,
    },
    label: {
      ...GENUI_TEXT.xs,
      color: colors.textSecondary,
      fontWeight: "500",
    },
    body: {
      ...GENUI_TEXT.md,
      color: colors.text,
    },
    bodySmall: {
      ...GENUI_TEXT.sm,
      color: colors.text,
    },
    secondarySmall: {
      ...GENUI_TEXT.sm,
      color: colors.textSecondary,
    },
    itemTitle: {
      ...GENUI_TEXT.md,
      color: colors.text,
      fontWeight: "500",
    },
    metricValue: {
      ...GENUI_TEXT.title2xl,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    numberSmall: {
      ...GENUI_TEXT.sm,
      color: colors.text,
      fontWeight: "500",
      fontVariant: ["tabular-nums"],
    },
    outlinedCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: GENUI_RADIUS.xl,
      padding: GENUI_SPACE.md,
      gap: GENUI_SPACE.md,
    },
    subBlock: {
      backgroundColor: colors.surfaceSecondary,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: GENUI_RADIUS.lg,
      padding: GENUI_SPACE.md,
      gap: GENUI_SPACE.xs,
    },
    track: {
      height: 7,
      borderRadius: GENUI_RADIUS.full,
      backgroundColor: colors.track,
      overflow: "hidden",
    },
    divider: {
      height: 1,
      backgroundColor: colors.divider,
    },
    wrapRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: GENUI_SPACE.sm,
    },
    wrapItem: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 220,
      minWidth: 0,
    },
  };
});
