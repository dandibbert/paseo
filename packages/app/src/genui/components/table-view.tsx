import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TableData } from "@getpaseo/protocol/genui/render-ui-schema";
import { formatCell } from "../format";
import { withContentKeys } from "../keyed";
import { genuiStyles } from "../styles";
import { GENUI_SPACE, GENUI_TEXT, getGenuiColors } from "../tokens";

const MIN_COLUMN_WIDTH = 96;
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
  return (
    <View style={styles.root}>
      {data.description ? <Text style={genuiStyles.caption}>{data.description}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={SCROLL_CONTENT_STYLE}
      >
        <View style={[styles.table, { minWidth: data.columns.length * MIN_COLUMN_WIDTH }]}>
          <View style={styles.row} accessibilityRole="header">
            {data.columns.map((column, index) => (
              <Text
                key={column.field}
                style={[
                  styles.cell,
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
  const colors = getGenuiColors(theme.colorScheme);
  return {
    root: {
      gap: GENUI_SPACE.sm,
    },
    table: {
      width: "100%",
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
      flex: 1,
      minWidth: MIN_COLUMN_WIDTH,
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
