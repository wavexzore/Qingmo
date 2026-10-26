import { RouterProvider } from "react-router-dom";

import "../i18n";
import { AppServicesProvider } from "./AppServices";
import { AppErrorBoundary } from "../components/AppErrorBoundary";
import { ToastProvider } from "../components/ToastHost";
import { DocumentSessionProvider } from "../features/editor/DocumentSessionContext";
import { createAppRouter } from "./routes";

const router = createAppRouter();

export function AppShell() {
  return (
    <AppErrorBoundary>
      <ToastProvider>
        <AppServicesProvider>
          <DocumentSessionProvider>
            <RouterProvider router={router} />
          </DocumentSessionProvider>
        </AppServicesProvider>
      </ToastProvider>
    </AppErrorBoundary>
  );
}
