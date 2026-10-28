import { createContext, useContext, useState, type ReactNode } from "react";

import { FakeIpc } from "../lib/ipc/fake";
import type { IpcPort } from "../lib/ipc/port";
import { createTauriIpc } from "../lib/ipc/tauri";
import { FakePlatform } from "../lib/platform/fake";
import type { PlatformPort } from "../lib/platform/port";
import { isTauriRuntime } from "../lib/platform/runtime";
import { createTauriPlatform } from "../lib/platform/tauri";
import { FakeLogPort } from "../lib/log/fake";
import type { LogPort } from "../lib/log/port";
import { createTauriLogPort } from "../lib/log/tauri";
import { FakeUpdatePort } from "../lib/update/fake";
import type { UpdatePort } from "../lib/update/port";
import { createTauriUpdatePort } from "../lib/update/tauri";
import { createE2eServices, isE2eMode } from "../e2e/bridge";

export interface AppServices {
  ipc: IpcPort;
  platform: PlatformPort;
  updates: UpdatePort;
  logs: LogPort;
}

/**
 * Production selects Tauri; a plain browser (vitest, Vite preview) gets the
 * in-memory adapters. T-018 may inject a pre-seeded FakeIpc through the
 * provider or a dedicated test entry; T-008 only needs the boundary.
 */
export function createAppServices(): AppServices {
  if (isE2eMode()) {
    return createE2eServices();
  }

  if (isTauriRuntime()) {
    return {
      ipc: createTauriIpc(),
      platform: createTauriPlatform(),
      updates: createTauriUpdatePort(),
      logs: createTauriLogPort(),
    };
  }

  return {
    ipc: new FakeIpc(),
    platform: new FakePlatform(),
    updates: new FakeUpdatePort(),
    logs: new FakeLogPort(),
  };
}

const AppServicesContext = createContext<AppServices | null>(null);

export function AppServicesProvider({
  children,
  services,
}: {
  children: ReactNode;
  services?: AppServices;
}) {
  const [value] = useState(() => services ?? createAppServices());
  return <AppServicesContext.Provider value={value}>{children}</AppServicesContext.Provider>;
}

export function useAppServices(): AppServices {
  const value = useContext(AppServicesContext);
  if (!value) {
    throw new Error("useAppServices must be used inside AppServicesProvider");
  }
  return value;
}
