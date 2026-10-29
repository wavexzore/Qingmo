import { useTranslation } from "react-i18next";

import type { DraftMeta } from "@qingmo/shared";

/** Top-of-editor entry point for the main window's crash drafts. */
export function RecoveryBanner({ drafts, onOpen }: { drafts: DraftMeta[]; onOpen(): void }) {
  const { t } = useTranslation(["editor"]);

  if (drafts.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="recovery-banner"
      className="flex shrink-0 items-center gap-3 border-b border-line bg-surface/80 px-5 py-2 text-xs text-ink-muted"
    >
      <span className="inline-block size-1.5 rounded-full bg-warning" aria-hidden="true" />
      <span>{t("editor:recovery.banner", { count: drafts.length })}</span>
      <button
        type="button"
        data-testid="recovery-open"
        onClick={onOpen}
        className="ml-auto rounded-full border border-line px-3 py-1 text-[11px] text-ink transition-colors hover:bg-surface-muted"
      >
        {t("editor:recovery.open")}
      </button>
    </div>
  );
}
