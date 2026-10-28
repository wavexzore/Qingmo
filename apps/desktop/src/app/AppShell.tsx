import { RouterProvider } from "react-router-dom";

import "../i18n";
import { AppServicesProvider } from "./AppServices";
import { LocaleHost } from "./LocaleHost";
import { AppErrorBoundary } from "../components/AppErrorBoundary";
import { ToastProvider } from "../components/ToastHost";
import { DocumentSessionProvider } from "../features/editor/DocumentSessionContext";
import { UpdateProvider } from "../features/update/UpdateProvider";
import { createAppRouter } from "./routes";

const router = createAppRouter();

export function AppShell() {
  return (
    <AppErrorBoundary>
      <ToastProvider>
        <AppServicesProvider>
          <LocaleHost />
          <UpdateProvider>
            <DocumentSessionProvider>
              <RouterProvider router={router} />
            </DocumentSessionProvider>
          </UpdateProvider>
        </AppServicesProvider>
      </ToastProvider>
    </AppErrorBoundary>
  );
}
