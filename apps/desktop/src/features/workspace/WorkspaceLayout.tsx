import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate, useOutletContext } from "react-router-dom";

import { useAppServices } from "../../app/AppServices";
import { useToast } from "../../components/ToastHost";
import { commandRegistry } from "../commands/CommandRegistry";
import { useDocumentSession } from "../editor/DocumentSessionContext";
import { EditorSession } from "../editor/EditorSession";
import { openFile } from "./openFile";

export interface WorkspaceActions {
  openDocument(): Promise<void>;
  opening: boolean;
}

/**
 * App-level workspace layout. It owns the single `file.open` registration and
 * the opening state, so the command remains available on both the welcome page
 * and an open document (T-015's palette) without duplicate registrations.
 */
export function WorkspaceLayout() {
  const { t } = useTranslation(["errors"]);
  const toast = useToast();
  const navigate = useNavigate();
  const { ipc } = useAppServices();
  const { setSession } = useDocumentSession();
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);

  const openDocument = useCallback(async () => {
    if (openingRef.current) {
      return;
    }
    openingRef.current = true;
    setOpening(true);
    try {
      const result = await openFile(ipc);
      if (!result.ok) {
        if (result.error.code !== "CANCELLED") {
          toast.push(t(`errors:${result.error.code}`));
        }
        return;
      }
      setSession(EditorSession.create(result.value));
      navigate("/editor");
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }, [ipc, navigate, setSession, t, toast]);

  useEffect(() => {
    const disposable = commandRegistry.register({
      id: "file.open",
      titleKey: "commands:file.open",
      category: "commands:category.file",
      keybinding: "Mod+O",
      run: openDocument,
    });
    return () => disposable.dispose();
  }, [openDocument]);

  return <Outlet context={{ openDocument, opening } satisfies WorkspaceActions} />;
}

export function useWorkspaceActions(): WorkspaceActions {
  return useOutletContext<WorkspaceActions>();
}
