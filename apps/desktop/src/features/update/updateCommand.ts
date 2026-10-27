import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useToast } from "../../components/ToastHost";
import { commandRegistry } from "../commands/CommandRegistry";
import { useUpdateController } from "./UpdateProvider";

export interface UseUpdateCommandOptions {
  /** Hide the command while a close confirmation or install gate owns the UI. */
  blocked: boolean;
  onOpenDialog(): void;
}

/**
 * Registers the single `app.checkForUpdates` command.
 *
 * Idle checks immediately; Available/Ready only opens the dialog (the user
 * decides when to download/install); busy phases explain instead of queueing.
 */
export function useUpdateCommand({ blocked, onOpenDialog }: UseUpdateCommandOptions): void {
  const controller = useUpdateController();
  const toast = useToast();
  const { t } = useTranslation(["update", "errors"]);

  useEffect(() => {
    const disposable = commandRegistry.register({
      id: "app.checkForUpdates",
      titleKey: "commands:update.checkForUpdates",
      category: "commands:category.app",
      when: () => !blocked && controller.getSnapshot()?.phase !== "installing",
      run: async () => {
        const current = controller.getSnapshot();
        if (!current || current.phase === "idle") {
          const next = await controller.check();
          if (!next || next.phase === "idle") {
            toast.push(t("update:toast.upToDate"));
          } else {
            onOpenDialog();
          }
          return;
        }
        if (current.phase === "available" || current.phase === "ready") {
          onOpenDialog();
          return;
        }
        toast.push(t("update:toast.busy"));
      },
    });
    return () => disposable.dispose();
  }, [blocked, controller, onOpenDialog, t, toast]);
}
