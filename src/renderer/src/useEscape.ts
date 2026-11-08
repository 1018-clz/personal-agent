import { useEffect } from "react";

/** Esc closes a dialog that holds nothing to lose: charts, comparisons, the setup checks. */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
}
