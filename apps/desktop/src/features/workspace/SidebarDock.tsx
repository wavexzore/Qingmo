import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import type { EditorSession } from "../editor/EditorSession";
import { useOutline } from "../editor/outline/useOutline";
import type { SidebarView } from "./sidebarDockStore";

export interface SidebarDockHandle {
  /** Moves focus into the active panel after commands/menu/handle activation. */
  focusActivePanel(): void;
  /** Moves focus to the active tab (used after Escape switches views). */
  focusTab(): void;
}

interface SidebarDockProps {
  open: boolean;
  view: SidebarView;
  hasWorkspace: boolean;
  hasOutline: boolean;
  onSelectView(view: SidebarView): void;
  onClose(): void;
  workspacePanel?: ((state: PanelState) => ReactNode) | undefined;
  outlinePanel?: ((state: PanelState) => ReactNode) | undefined;
  searchPanel?: ((state: PanelState) => ReactNode) | undefined;
  outlineBadge?: ReactNode | undefined;
}

interface PanelState {
  active: boolean;
  focusRequest: number;
}

const ALL_TABS: SidebarView[] = ["workspace", "outline", "search"];

export const SidebarDock = forwardRef<SidebarDockHandle, SidebarDockProps>(function SidebarDock(
  {
    open,
    view,
    hasWorkspace,
    hasOutline,
    onSelectView,
    onClose,
    workspacePanel,
    outlinePanel,
    searchPanel,
    outlineBadge,
  },
  ref,
) {
  const { t } = useTranslation(["workspace"]);
  const availableTabs = ALL_TABS.filter((candidate) => {
    if (candidate === "workspace") return hasWorkspace;
    if (candidate === "outline") return hasOutline;
    return Boolean(searchPanel);
  });
  const [focusRequest, setFocusRequest] = useState(0);
  const [tabFocusRequest, setTabFocusRequest] = useState(0);
  const tabRefs = useRef<Partial<Record<SidebarView, HTMLButtonElement | null>>>({});

  useImperativeHandle(
    ref,
    () => ({
      focusActivePanel() {
        if (!open) {
          return;
        }
        setFocusRequest((current) => current + 1);
      },
      focusTab() {
        setTabFocusRequest((current) => current + 1);
      },
    }),
    [open],
  );

  useLayoutEffect(() => {
    if (tabFocusRequest === 0) {
      return;
    }
    tabRefs.current[view]?.focus();
  }, [tabFocusRequest, view]);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (availableTabs.length < 2) {
      return;
    }
    const index = availableTabs.indexOf(view);
    let next: SidebarView | null = null;
    if (event.key === "ArrowRight") {
      next = availableTabs[(index + 1) % availableTabs.length] ?? null;
    } else if (event.key === "ArrowLeft") {
      next = availableTabs[(index - 1 + availableTabs.length) % availableTabs.length] ?? null;
    } else if (event.key === "Home") {
      next = availableTabs[0] ?? null;
    } else if (event.key === "End") {
      next = availableTabs[availableTabs.length - 1] ?? null;
    }
    if (next) {
      event.preventDefault();
      onSelectView(next);
    }
  };

  const handleEscape = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (view === "workspace") {
      onClose();
      return;
    }
    if (hasWorkspace) {
      onSelectView("workspace");
      setTabFocusRequest((current) => current + 1);
      return;
    }
    onClose();
  };

  const panelClass = (visible: boolean): string =>
    visible ? "flex min-h-0 flex-1 flex-col" : "hidden min-h-0 flex-1 flex-col";

  return (
    <aside
      aria-hidden={!open || undefined}
      inert={!open || undefined}
      data-testid="sidebar-dock"
      data-open={open ? "true" : "false"}
      data-view={view}
      onKeyDown={handleEscape}
      className={`relative flex h-full shrink-0 flex-col overflow-hidden border-line bg-surface/60 transition-[width,opacity] duration-200 ease-out ${
        open ? "w-60 border-r opacity-100" : "w-0 border-r-0 opacity-0"
      }`}
    >
      <div className="flex h-full w-60 flex-col">
        <header className="flex h-10 shrink-0 items-center border-b border-line">
          {availableTabs.length >= 2 ? (
            <div
              role="tablist"
              aria-label={t("workspace:dock.region")}
              onKeyDown={handleTabKeyDown}
              className="flex min-w-0 flex-1 items-center gap-1 px-1.5"
            >
              <DockTab
                id="workspace"
                active={view === "workspace"}
                label={t("workspace:dock.workspaceTab")}
                onSelect={() => onSelectView("workspace")}
                tabRef={(element) => {
                  tabRefs.current.workspace = element;
                }}
              />
              <DockTab
                id="outline"
                active={view === "outline"}
                label={t("workspace:dock.outlineTab")}
                badge={outlineBadge}
                onSelect={() => onSelectView("outline")}
                tabRef={(element) => {
                  tabRefs.current.outline = element;
                }}
              />
              {searchPanel ? (
                <DockTab
                  id="search"
                  active={view === "search"}
                  label={t("workspace:dock.searchTab")}
                  onSelect={() => onSelectView("search")}
                  tabRef={(element) => {
                    tabRefs.current.search = element;
                  }}
                />
              ) : null}
            </div>
          ) : (
            <h2 className="min-w-0 flex-1 truncate px-3 text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
              {view === "search"
                ? t("workspace:dock.searchTab")
                : hasWorkspace
                  ? t("workspace:dock.workspaceTab")
                  : t("workspace:dock.outlineTab")}
            </h2>
          )}
          <button
            type="button"
            aria-label={t("workspace:dock.hide")}
            title={t("workspace:dock.hide")}
            onClick={onClose}
            className="mx-1.5 shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink"
          >
            ×
          </button>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col">
          {hasWorkspace ? (
            <div
              role="tabpanel"
              id="sidebar-dock-panel-workspace"
              aria-labelledby={hasOutline ? "sidebar-dock-tab-workspace" : undefined}
              hidden={view !== "workspace"}
              inert={view !== "workspace" || undefined}
              className={panelClass(view === "workspace")}
            >
              {workspacePanel?.({
                active: open && view === "workspace",
                focusRequest: open && view === "workspace" ? focusRequest : 0,
              })}
            </div>
          ) : null}
          {hasOutline ? (
            <div
              role="tabpanel"
              id="sidebar-dock-panel-outline"
              aria-labelledby={availableTabs.length >= 2 ? "sidebar-dock-tab-outline" : undefined}
              hidden={view !== "outline"}
              inert={view !== "outline" || undefined}
              className={panelClass(view === "outline")}
            >
              {outlinePanel?.({
                active: open && view === "outline",
                focusRequest: open && view === "outline" ? focusRequest : 0,
              })}
            </div>
          ) : null}
          {searchPanel ? (
            <div
              role="tabpanel"
              id="sidebar-dock-panel-search"
              aria-labelledby={availableTabs.length >= 2 ? "sidebar-dock-tab-search" : undefined}
              hidden={view !== "search"}
              inert={view !== "search" || undefined}
              className={panelClass(view === "search")}
            >
              {searchPanel({
                active: open && view === "search",
                focusRequest: open && view === "search" ? focusRequest : 0,
              })}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
});

interface DockTabProps {
  id: SidebarView;
  active: boolean;
  label: string;
  badge?: ReactNode;
  onSelect(): void;
  tabRef(element: HTMLButtonElement | null): void;
}

function DockTab({ id, active, label, badge, onSelect, tabRef }: DockTabProps) {
  return (
    <button
      ref={tabRef}
      type="button"
      role="tab"
      id={`sidebar-dock-tab-${id}`}
      aria-selected={active}
      aria-controls={`sidebar-dock-panel-${id}`}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      className={`flex min-w-0 items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-surface-raised text-ink"
          : "text-ink-muted hover:bg-surface-raised hover:text-ink"
      }`}
    >
      <span className="truncate">{label}</span>
      {badge}
    </button>
  );
}

interface SidebarReopenHandleProps {
  onClick(): void;
}

export const SidebarReopenHandle = forwardRef<HTMLButtonElement, SidebarReopenHandleProps>(
  function SidebarReopenHandle({ onClick }, ref) {
    const { t } = useTranslation(["workspace"]);
    return (
      <button
        ref={ref}
        type="button"
        aria-label={t("workspace:dock.reopen")}
        title={t("workspace:dock.reopen")}
        onClick={onClick}
        className="absolute left-0 top-1/2 z-10 flex h-[52px] w-5 -translate-y-1/2 items-center justify-center rounded-r border border-l-0 border-line bg-surface text-xs text-ink-muted shadow-sm transition-colors hover:bg-surface-raised hover:text-ink"
      >
        <span aria-hidden="true">›</span>
      </button>
    );
  },
);

/** Uses the outline channel only to display the tab count. */
export function OutlineCountBadge({ session }: { session: EditorSession }) {
  const outline = useOutline(session);
  return (
    <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
      {outline.entries.length}
    </span>
  );
}
