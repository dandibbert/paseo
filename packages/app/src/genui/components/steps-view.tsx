import { Text, View } from "react-native";
import Svg, { Circle, Path, Text as SvgText } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { StepStatus, StepsData } from "@getpaseo/protocol/genui/render-ui-schema";
import { withContentKeys } from "../keyed";
import { genuiStyles } from "../styles";
import { GENUI_SPACE, GENUI_TEXT, type GenuiColors } from "../tokens";

const MARKER_SIZE = 22;
const RAIL_WIDTH = 2;

// Markers differ in shape as well as color: filled check (done), ring with a filled
// center (current), hollow ring with the step number (todo or no status), and a ring
// with an exclamation mark (blocked).
function StepMarker({
  status,
  number,
  colors,
}: {
  status: StepStatus | undefined;
  number: number;
  colors: GenuiColors;
}) {
  const center = MARKER_SIZE / 2;
  if (status === "done") {
    return (
      <Svg width={MARKER_SIZE} height={MARKER_SIZE}>
        <Circle cx={center} cy={center} r={center} fill={colors.success} />
        <Path
          d="M6.8 11.3 L9.8 14.2 L15.2 8.6"
          fill="none"
          stroke={colors.surfaceSecondary}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  }
  if (status === "current") {
    return (
      <Svg width={MARKER_SIZE} height={MARKER_SIZE}>
        <Circle
          cx={center}
          cy={center}
          r={center - 1}
          fill="none"
          stroke={colors.text}
          strokeWidth={2}
        />
        <Circle cx={center} cy={center} r={5} fill={colors.text} />
      </Svg>
    );
  }
  if (status === "blocked") {
    return (
      <Svg width={MARKER_SIZE} height={MARKER_SIZE}>
        <Circle
          cx={center}
          cy={center}
          r={center - 1}
          fill="none"
          stroke={colors.danger}
          strokeWidth={1.5}
        />
        <Path d="M11 6.5 L11 12.5" stroke={colors.danger} strokeWidth={2} strokeLinecap="round" />
        <Circle cx={center} cy={15.6} r={1.2} fill={colors.danger} />
      </Svg>
    );
  }
  return (
    <Svg width={MARKER_SIZE} height={MARKER_SIZE}>
      <Circle
        cx={center}
        cy={center}
        r={center - 1}
        fill="none"
        stroke={colors.border}
        strokeWidth={1.5}
      />
      <SvgText
        x={center}
        y={center + 4}
        fontSize={GENUI_TEXT.xs.fontSize}
        fontWeight="500"
        fill={colors.textSecondary}
        textAnchor="middle"
      >
        {String(number)}
      </SvgText>
    </Svg>
  );
}

export function StepsView({ data, colors }: { data: StepsData; colors: GenuiColors }) {
  const { t } = useTranslation();
  const lastIndex = data.items.length - 1;
  return (
    <View style={styles.list}>
      {withContentKeys(data.items).map(({ key, item }, index) => (
        <View
          key={key}
          style={styles.step}
          accessible
          accessibilityLabel={[
            t("genui.step", { number: index + 1 }),
            item.status ? t(`genui.stepStatus.${item.status}`) : null,
            item.meta,
            item.title,
            item.body,
          ]
            .filter((part): part is string => Boolean(part))
            .join(", ")}
        >
          <View style={styles.markerColumn}>
            <StepMarker status={item.status} number={index + 1} colors={colors} />
            {index < lastIndex ? (
              <View style={[styles.rail, item.status === "done" ? styles.railDone : null]} />
            ) : null}
          </View>
          <View style={[styles.content, index < lastIndex ? styles.contentSpaced : null]}>
            {item.meta ? <Text style={genuiStyles.label}>{item.meta}</Text> : null}
            <Text style={[genuiStyles.itemTitle, item.status === "todo" ? styles.titleTodo : null]}>
              {item.title}
            </Text>
            {item.body ? <Text style={genuiStyles.secondarySmall}>{item.body}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const colors = theme.genui;
  return {
    list: {
      gap: 0,
    },
    step: {
      flexDirection: "row",
      gap: GENUI_SPACE.md,
    },
    markerColumn: {
      width: MARKER_SIZE,
      alignItems: "center",
      paddingTop: 2,
    },
    rail: {
      flex: 1,
      width: RAIL_WIDTH,
      minHeight: GENUI_SPACE.md,
      marginVertical: GENUI_SPACE.xs,
      borderRadius: RAIL_WIDTH / 2,
      backgroundColor: colors.border,
    },
    railDone: {
      backgroundColor: colors.success,
    },
    content: {
      flex: 1,
      gap: 2,
    },
    contentSpaced: {
      paddingBottom: GENUI_SPACE.lg,
    },
    titleTodo: {
      color: colors.textSecondary,
    },
  };
});
