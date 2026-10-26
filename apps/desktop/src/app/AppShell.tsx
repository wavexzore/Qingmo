import { RouterProvider } from "react-router-dom";

import "../i18n";
import { AppErrorBoundary } from "../components/AppErrorBoundary";
import { ToastProvider } from "../components/ToastHost";
import { createAppRouter } from "./routes";

const router = createAppRouter();

export function AppShell() {
  return (
    <AppErrorBoundary>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </AppErrorBoundary>
  );
}
