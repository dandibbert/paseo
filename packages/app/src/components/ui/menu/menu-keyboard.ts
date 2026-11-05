import { useCallback, type RefObject } from "react";
import type { View } from "react-native";
import { useOverlayRegistration, type KeyboardInputEvent } from "@/keyboard";
import { navigateMenuKeyboard } from "./keyboard-navigation";

/** Keyboard behavior is shared by popovers and compact sheets. */
export function useMenuOverlayRegistration({
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
  const handleOverlayKeyDown = useCallback(
    (event: KeyboardInputEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return true;
      }

      return navigateMenuKeyboard(event);
    },
    [onClose],
  );
  return useOverlayRegistration({
    keys: ["Escape"],
    active: visible,
    layer,
    onKeyDown: handleOverlayKeyDown,
    restoreFocusRef,
  });
}
