import { useEffect, useRef, useState } from "react";

export const OUTLINE_PANEL_ANIMATION_MS = 200;

export interface OutlinePanelPresence {
  /** Keeps the panel mounted through the closing transition. */
  mounted: boolean;
  /** Drives the open/closed width and opacity classes. */
  visible: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Mounts immediately when opening so the first render is collapsed, then
 * flips `visible` on the next frame to run the CSS width transition. Closing
 * keeps the panel mounted for one transition and then unmounts it, so the
 * editor never sees a half-laid-out shell.
 */
export function usePanelPresence(open: boolean): OutlinePanelPresence {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  const frame = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const duration = prefersReducedMotion() ? 0 : OUTLINE_PANEL_ANIMATION_MS;

    if (open) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setMounted(true);
      if (duration === 0) {
        setVisible(true);
        return;
      }
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setVisible(true);
      });
      return () => {
        if (frame.current !== null) {
          cancelAnimationFrame(frame.current);
          frame.current = null;
        }
      };
    }

    setVisible(false);
    if (!mounted) {
      return;
    }
    if (duration === 0) {
      setMounted(false);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      setMounted(false);
    }, duration);
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [open, mounted]);

  return { mounted, visible };
}
