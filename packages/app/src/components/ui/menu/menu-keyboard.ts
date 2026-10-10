import { useCallback, type RefObject } from "react";
import type { View } from "react-native";
import { isWeb } from "@/constants/platform";
import { useWebOverlayRegistration } from "@/lib/overlay-root";

/** Keyboard behavior is shared by popovers and compact web sheets. */
export function useMenuWebOverlayRegistration({
  visible,
  layer,
  onClose,
  restoreFocusRef,
}: {
  visible: boolean;
  layer: number;
  onClose: () => void;
  restoreFocusRef?: RefObject<View | null>;
}) {
  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return true;
      }

      const target = event.target instanceof Element ? event.target : null;
      const surface = target?.closest<HTMLElement>('[data-menu-surface="true"]');
      if (!surface) return false;
      const items = Array.from(
        surface.querySelectorAll<HTMLElement>(
          '[data-menu-item="true"]:not([data-menu-disabled="true"])',
        ),
      );
      if (items.length === 0) return false;
      const currentIndex = items.findIndex((item) => item === document.activeElement);
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown")
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
      if (event.key === "ArrowUp")
        nextIndex =
          currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = items.length - 1;
      if (nextIndex !== null) {
        event.preventDefault();
        event.stopPropagation();
        items[nextIndex]?.focus();
        return true;
      }
      if ((event.key === "Enter" || event.key === " ") && currentIndex >= 0) {
        event.preventDefault();
        event.stopPropagation();
        items[currentIndex]?.click();
        return true;
      }
      return false;
    },
    [onClose],
  );
  return useWebOverlayRegistration({
    active: isWeb && visible,
    layer,
    onKeyDown: handleWebOverlayKeyDown,
    restoreFocusRef,
  });
}
