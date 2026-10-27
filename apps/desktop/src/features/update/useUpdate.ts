import { useUpdateController, useUpdateSnapshot } from "./UpdateProvider";

export { UpdateProvider, useUpdateController, useUpdateSnapshot } from "./UpdateProvider";
export type { UpdateProviderProps } from "./UpdateProvider";
export { UpdateController } from "./UpdateController";
export type { PrepareInstall, UpdateControllerOptions } from "./UpdateController";

/** Convenience hook for components that only need the mirror and actions. */
export function useUpdate() {
  const controller = useUpdateController();
  const snapshot = useUpdateSnapshot();
  return { controller, snapshot };
}
