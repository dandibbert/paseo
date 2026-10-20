import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { RenderUiNode } from "@getpaseo/protocol/genui/render-ui-validate";
import { CartesianChartView } from "./components/cartesian-chart-view";
import { MetricComparisonView, MetricView, ProgressView } from "./components/metric-views";
import { PieChartView } from "./components/pie-chart-view";
import { PriorityListView } from "./components/priority-list-view";
import { TableView } from "./components/table-view";
import { withContentKeys } from "./keyed";
import { genuiStyles } from "./styles";
import { GENUI_SPACE, type GenuiColors } from "./tokens";

interface NodeProps {
  node: RenderUiNode;
  colors: GenuiColors;
  // Top-level leaves draw their own frame (priorityList); nested ones sit inside a card.
  nested: boolean;
}

function NodeContent({ node, colors, nested }: NodeProps) {
  switch (node.type) {
    case "metricComparison":
      return <MetricComparisonView data={node.data} colors={colors} />;
    case "metric":
      return <MetricView data={node.data} />;
    case "progress":
      return <ProgressView data={node.data} colors={colors} />;
    case "chart.bar":
      return <CartesianChartView kind="bar" data={node.data} colors={colors} />;
    case "chart.line":
      return <CartesianChartView kind="line" data={node.data} colors={colors} />;
    case "chart.pie":
      return <PieChartView data={node.data} colors={colors} />;
    case "table":
      return <TableView data={node.data} />;
    case "priorityList":
      return <PriorityListView data={node.data} colors={colors} framed={!nested} />;
    case "card":
      return (
        <View style={genuiStyles.outlinedCard}>
          {withContentKeys(node.data.children).map(({ key, item }) => (
            <RenderUiNodeView key={key} node={item} colors={colors} nested />
          ))}
        </View>
      );
    case "grid":
      return (
        <View style={genuiStyles.wrapRow}>
          {withContentKeys(node.data.children).map(({ key, item }) => (
            <View key={key} style={genuiStyles.wrapItem}>
              <GridCell node={item} colors={colors} />
            </View>
          ))}
        </View>
      );
  }
}

// Metric tiles are already blocks; anything else in a grid gets its own outlined card so
// the columns read as peers.
function GridCell({ node, colors }: { node: RenderUiNode; colors: GenuiColors }) {
  if (node.type === "metric" || node.type === "card") {
    return <RenderUiNodeView node={node} colors={colors} nested />;
  }
  return (
    <View style={genuiStyles.outlinedCard}>
      <RenderUiNodeView node={node} colors={colors} nested />
    </View>
  );
}

export function RenderUiNodeView({ node, colors, nested }: NodeProps) {
  const title = node.type === "card" ? null : node.title;
  if (node.type === "card" && node.title) {
    return (
      <View style={genuiStyles.outlinedCard}>
        <Text style={genuiStyles.itemTitle} accessibilityRole="header">
          {node.title}
        </Text>
        {withContentKeys(node.data.children).map(({ key, item }) => (
          <RenderUiNodeView key={key} node={item} colors={colors} nested />
        ))}
      </View>
    );
  }
  return (
    <View style={styles.node}>
      {title ? (
        <Text style={genuiStyles.caption} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      <NodeContent node={node} colors={colors} nested={nested} />
    </View>
  );
}

const styles = StyleSheet.create({
  node: {
    gap: GENUI_SPACE.sm,
  },
});
