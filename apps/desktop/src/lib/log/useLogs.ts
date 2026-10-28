import { useAppServices } from "../../app/AppServices";
import type { LogPort } from "./port";

/** The active log port; browser harnesses and Tauri share the same shape. */
export function useLogs(): LogPort {
  return useAppServices().logs;
}
