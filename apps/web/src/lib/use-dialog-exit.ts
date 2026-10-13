import { useEffect, useRef, type AnimationEvent } from "react";

/** Let Radix finish its exit before discarding the current record or form. */
export function useDialogExit(open: boolean, onExitComplete?: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open || !onExitComplete) return;
    const frame = requestAnimationFrame(() => {
      // Radix removes content immediately when animations are unavailable.
      if (!ref.current) onExitComplete();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, onExitComplete]);
  function onAnimationEnd(event: AnimationEvent<HTMLDivElement>) {
    if (
      event.target === event.currentTarget &&
      event.currentTarget.dataset.state === "closed"
    )
      onExitComplete?.();
  }
  return { ref, onAnimationEnd };
}
