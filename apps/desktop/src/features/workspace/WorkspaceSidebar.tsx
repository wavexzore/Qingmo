import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { WorkspaceNavigation } from "./useWorkspaceNavigation";
import { VirtualWorkspaceTree } from "./VirtualWorkspaceTree";
import { workspaceErrorKey } from "./workspaceErrorMessage";

interface WorkspaceSidebarProps {
  navigation: WorkspaceNavigation;
  active: boolean;
  focusRequest: number;
  onOpenFile(segments: string[]): void | Promise<boolean>;
  onDeleteFile?: ((segments: string[]) => void) | undefined;
  onShowTrash?: (() => void) | undefined;
}

export function WorkspaceSidebar({
  navigation,
  active,
  focusRequest,
  onOpenFile,
  onDeleteFile,
  onShowTrash,
}: WorkspaceSidebarProps) {
  const { t } = useTranslation(["workspace"]);
  const containerRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const handledFocusRequest = useRef(0);

  useLayoutEffect(() => {
    if (!active || focusRequest === 0 || focusRequest === handledFocusRequest.current) {
      return;
    }
    handledFocusRequest.current = focusRequest;
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const current = container.querySelector<HTMLElement>('[data-workspace-current="true"]');
    const firstRow = container.querySelector<HTMLElement>("[data-workspace-row]");
    (current ?? firstRow ?? refreshRef.current)?.focus();
  }, [active, focusRequest, navigation.rows]);

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="workspace-sidebar"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-ink">{navigation.workspace?.name}</h2>
          <p className="truncate text-[10px] text-ink-faint" title={navigation.workspace?.root}>
            {navigation.workspace?.root}
          </p>
        </div>
        <button
          ref={refreshRef}
          type="button"
          data-workspace-refresh="true"
          aria-label={t("workspace:header.refresh")}
          title={t("workspace:header.refresh")}
          disabled={navigation.rootLoading}
          onClick={() => {
            void navigation.refresh({ manual: true });
          }}
          className="shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink disabled:opacity-40"
        >
          ↻
        </button>
        <button
          type="button"
          aria-label={t("workspace:header.collapseAll")}
          title={t("workspace:header.collapseAll")}
          onClick={navigation.collapseAll}
          className="shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink"
        >
          ⊟
        </button>
      </header>

      {navigation.rootLoading && navigation.rows.length === 0 ? (
        <p role="status" className="px-3 py-3 text-sm text-ink-muted">
          {t("workspace:header.loading")}
        </p>
      ) : navigation.rootError ? (
        <div role="alert" className="flex flex-col items-start gap-2 px-3 py-3 text-sm text-danger">
          <p>{t(workspaceErrorKey(navigation.rootError))}</p>
          <button
            type="button"
            onClick={() => navigation.retry([])}
            className="rounded border border-danger/40 px-2 py-1 text-xs transition-colors hover:bg-danger/10"
          >
            {t("workspace:header.retry")}
          </button>
        </div>
      ) : navigation.rows.length === 0 ? (
        <p role="status" className="px-3 py-3 text-sm text-ink-muted">
          {t("workspace:header.empty")}
        </p>
      ) : (
        <VirtualWorkspaceTree
          rows={navigation.rows}
          focusedKey={navigation.focusedKey}
          selectedKey={navigation.selectedKey}
          currentKey={navigation.currentKey}
          active={active}
          onFocusKey={navigation.setFocusedKey}
          onSelectKey={navigation.setSelectedKey}
          onToggle={navigation.toggle}
          onOpenFile={onOpenFile}
          onRetry={navigation.retry}
          onDeleteFile={onDeleteFile}
          onShowTrash={onShowTrash}
        />
      )}

      {navigation.rootTruncated ? (
        <p
          role="status"
          className="shrink-0 border-t border-line px-3 py-1.5 text-[11px] text-ink-faint"
        >
          {navigation.rootTruncationReason === "scanned"
            ? t("workspace:truncated.scanned")
            : t("workspace:truncated.listed")}
        </p>
      ) : null}
    </div>
  );
}
