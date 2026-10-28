import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { UpdateSnapshot } from "@qingmo/shared";

import { useAppServices } from "../../app/AppServices";
import { isTauriRuntime } from "../../lib/platform/runtime";

import { UpdateController } from "./UpdateController";

const UpdateContext = createContext<UpdateController | null>(null);

export interface UpdateProviderProps {
  children: ReactNode;
  controller?: UpdateController;
  /** Tauri enables the delayed silent check in dev too; tests/E2E pass false. */
  autoCheck?: boolean;
}

function useControllerLifecycle(controller: UpdateController): void {
  useEffect(() => {
    controller.start();
    return () => {
      controller.stop();
    };
  }, [controller]);
}

function ControlledUpdateProvider({
  children,
  controller,
}: {
  children: ReactNode;
  controller: UpdateController;
}) {
  useControllerLifecycle(controller);
  return <UpdateContext.Provider value={controller}>{children}</UpdateContext.Provider>;
}

function DefaultUpdateProvider({
  children,
  autoCheck,
}: {
  children: ReactNode;
  autoCheck?: boolean;
}) {
  const services = useAppServices();
  const [controller] = useState(
    () =>
      new UpdateController(services.updates, {
        autoCheck: autoCheck ?? isTauriRuntime(),
      }),
  );
  useControllerLifecycle(controller);
  return <UpdateContext.Provider value={controller}>{children}</UpdateContext.Provider>;
}

export function UpdateProvider({ children, controller, autoCheck }: UpdateProviderProps) {
  if (controller) {
    return <ControlledUpdateProvider controller={controller}>{children}</ControlledUpdateProvider>;
  }
  if (autoCheck === undefined) {
    return <DefaultUpdateProvider>{children}</DefaultUpdateProvider>;
  }
  return <DefaultUpdateProvider autoCheck={autoCheck}>{children}</DefaultUpdateProvider>;
}

export function useUpdateController(): UpdateController {
  const controller = useContext(UpdateContext);
  if (!controller) {
    throw new Error("useUpdateController must be used inside UpdateProvider");
  }
  return controller;
}

export function useUpdateSnapshot(): UpdateSnapshot | null {
  const controller = useUpdateController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
