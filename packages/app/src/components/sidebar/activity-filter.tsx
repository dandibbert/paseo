import { ScrollView } from "react-native";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import type { SidebarActivityFilter } from "./sidebar-order";

export function SidebarActivityFilterControl() {
  const { t } = useTranslation();
  const selected = useSidebarViewStore((state) => state.activityFilter);
  const setValue = useSidebarViewStore((state) => state.setActivityFilter);
  const options = useMemo<SegmentedControlOption<SidebarActivityFilter>[]>(
    () =>
      (["all", "running", "attention"] as const).map((value) => ({
        value,
        label: t(`sidebar.activityFilter.${value}`),
        testID: `sidebar-activity-filter-${value}`,
      })),
    [t],
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <SegmentedControl
        size="xs"
        value={selected}
        onValueChange={setValue}
        options={options}
        testID="sidebar-activity-filter"
      />
    </ScrollView>
  );
}
