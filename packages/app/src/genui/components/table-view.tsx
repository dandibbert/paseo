import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TableData } from "@getpaseo/protocol/genui/render-ui-schema";
import { estimateTableColumnWidths } from "../chart-layout";
import { formatCell } from "../format";
import { withContentKeys } from "../keyed";
import { genuiStyles } from "../styles";
import { GENUI_SPACE, GENUI_TEXT } from "../tokens";

// Static, so it can go straight to contentContainerStyle (see docs/unistyles.md).
const SCROLL_CONTENT_STYLE = { flexGrow: 1 };

function isNumericColumn(data: TableData, field: string): boolean {
  return data.rows.every((row) => {
    const value = row[field];
    return value === null || value === undefined || typeof value === "number";
  });
}

export function TableView({ data }: { data: TableData }) {
  const numeric = data.columns.map((column) => isNumericColumn(data, column.field));
  const lastIndex = data.columns.length - 1;
  const columnStyles = useMemo(() => {
    const widths = estimateTableColumnWidths({
      headers: data.columns.map((column) => column.label),
      rows: data.rows.map((row) => data.columns.map((column) => formatCell(row[column.field]))),
    });
    return widths.map((width) => ({
      flexBasis: width.preferred,
      minWidth: width.min,
      flexGrow: 1,
      flexShrink: 1,
    }));
  }, [data]);
  // Inside a horizontal ScrollView a percentage width resolves against the content, not
  // the card, so the table width is set from the measured card width.
  const [containerWidth, setContainerWidth] = useState(0);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.floor(event.nativeEvent.layout.width);
    setContainerWidth((current) => (current === next ? current : next));
  }, []);
  const tableStyle = useMemo(() => {
    const minWidth = columnStyles.reduce((sum, column) => sum + column.minWidth, 0);
    return { width: Math.max(containerWidth, minWidth) };
  }, [columnStyles, containerWidth]);
  return (
    <View style={styles.root} onLayout={handleLayout}>
      {data.description ? <Text style={genuiStyles.caption}>{data.description}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={SCROLL_CONTENT_STYLE}
      >
        <View style={tableStyle}>
          <View style={styles.row} accessibilityRole="header">
            {data.columns.map((column, index) => (
              <Text
                key={column.field}
                style={[
                  styles.cell,
                  columnStyles[index],
                  styles.headerCell,
                  index === 0 && styles.firstCell,
                  index === lastIndex && styles.lastCell,
                  numeric[index] && styles.numericCell,
                ]}
              >
                {column.label}
              </Text>
            ))}
          </View>
          {withContentKeys(data.rows).map(({ key, item: row }) => (
            <View key={key} style={[styles.row, styles.bodyRow]}>
              {data.columns.map((column, index) => (
                <Text
                  key={column.field}
                  style={[
                    styles.cell,
                    columnStyles[index],
                    index === 0 && styles.firstCell,
                    index === lastIndex && styles.lastCell,
                    numeric[index] && styles.numericCell,
                  ]}
                >
                  {formatCell(row[column.field])}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const colors = theme.genui;
  return {
    root: {
      gap: GENUI_SPACE.sm,
    },
    row: {
      flexDirection: "row",
      minHeight: 36,
      alignItems: "center",
    },
    bodyRow: {
      borderTopWidth: 1,
      borderTopColor: colors.divider,
    },
    cell: {
      ...GENUI_TEXT.sm,
      color: colors.text,
      paddingHorizontal: GENUI_SPACE.sm,
      paddingVertical: GENUI_SPACE.sm,
      fontVariant: ["tabular-nums"],
    },
    headerCell: {
      fontWeight: "600",
    },
    firstCell: {
      paddingLeft: 0,
    },
    lastCell: {
      paddingRight: 0,
    },
    numericCell: {
      textAlign: "right",
    },
  };
});
