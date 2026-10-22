import { Fragment } from "react";
import { Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { PriorityDecision, PriorityListData } from "@getpaseo/protocol/genui/render-ui-schema";
import { withContentKeys } from "../keyed";
import { genuiStyles } from "../styles";
import { GENUI_SPACE, type GenuiColors } from "../tokens";

const ICON_SIZE = 20;

// Icons differ in shape, not only color: ringed dot (change), solid dot (adjust),
// check circle (keep). Matches reference C.
function DecisionIcon({ decision, colors }: { decision: PriorityDecision; colors: GenuiColors }) {
  const center = ICON_SIZE / 2;
  if (decision === "change") {
    return (
      <Svg width={ICON_SIZE} height={ICON_SIZE}>
        <Circle
          cx={center}
          cy={center}
          r={7.5}
          fill="none"
          stroke={colors.text}
          strokeWidth={1.5}
        />
        <Circle cx={center} cy={center} r={4} fill={colors.text} />
      </Svg>
    );
  }
  if (decision === "adjust") {
    return (
      <Svg width={ICON_SIZE} height={ICON_SIZE}>
        <Circle cx={center} cy={center} r={8} fill={colors.textSecondary} />
      </Svg>
    );
  }
  return (
    <Svg width={ICON_SIZE} height={ICON_SIZE}>
      <Circle
        cx={center}
        cy={center}
        r={7.5}
        fill="none"
        stroke={colors.success}
        strokeWidth={1.5}
      />
      <Path
        d="M6.6 10.2 L9 12.5 L13.4 7.9"
        fill="none"
        stroke={colors.success}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function PriorityListView({
  data,
  colors,
  framed,
}: {
  data: PriorityListData;
  colors: GenuiColors;
  framed: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={framed ? [genuiStyles.outlinedCard, styles.framed] : styles.list}>
      {withContentKeys(data.items).map(({ key, item }, index) => (
        <Fragment key={key}>
          {index > 0 ? <View style={genuiStyles.divider} /> : null}
          <View
            style={styles.item}
            accessible
            accessibilityLabel={[
              t(`genui.decision.${item.decision}`),
              item.priority ? t(`genui.priority.${item.priority}`) : null,
              item.title,
              item.body,
            ]
              .filter((part): part is string => Boolean(part))
              .join(", ")}
          >
            <View style={styles.icon}>
              <DecisionIcon decision={item.decision} colors={colors} />
            </View>
            <View style={styles.content}>
              <Text style={genuiStyles.itemTitle}>{item.title}</Text>
              <Text style={genuiStyles.body}>{item.body}</Text>
            </View>
          </View>
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  framed: {
    paddingHorizontal: GENUI_SPACE.lg,
    gap: 0,
  },
  list: {
    gap: 0,
  },
  item: {
    flexDirection: "row",
    gap: GENUI_SPACE.md,
    paddingVertical: GENUI_SPACE.md,
  },
  icon: {
    paddingTop: 3,
  },
  content: {
    flex: 1,
    gap: GENUI_SPACE.xs,
  },
});
