import { useTranslation } from "react-i18next";

import { Button } from "@qingmo/ui";

import type { ClosePrompt } from "./useCloseGuard";

export function CloseConfirmDialog({
  prompt,
  onAllow,
  onCancel,
}: {
  prompt: ClosePrompt | null;
  onAllow(): Promise<void>;
  onCancel(): Promise<void>;
}) {
  const { t } = useTranslation(["common"]);

  if (!prompt) {
    return null;
  }

  const unsaved = prompt.kind === "unsaved";
  const label = unsaved
    ? t("common:closeGuard.unsaved")
    : prompt.kind === "conflict"
      ? t("common:closeGuard.conflict")
      : t("common:closeGuard.error");

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-6 backdrop-blur-[2px]"
      data-testid="close-confirm-overlay"
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-confirm-title"
        aria-describedby="close-confirm-description"
        className="w-full max-w-[420px] rounded-card border border-line bg-surface p-6 shadow-card"
      >
        <p className="text-[10px] uppercase tracking-[0.18em] text-danger">{label}</p>
        <h2 id="close-confirm-title" className="mt-2 font-serif text-2xl tracking-[-0.02em]">
          {t("common:closeGuard.title")}
        </h2>
        <p id="close-confirm-description" className="mt-3 text-sm leading-7 text-ink-muted">
          {unsaved ? t("common:closeGuard.unsavedDescription") : t("common:closeGuard.description")}
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="ghost"
            data-testid="close-cancel"
            autoFocus
            onClick={() => {
              void onCancel();
            }}
          >
            {t("common:closeGuard.cancel")}
          </Button>
          <Button
            data-testid={unsaved ? "close-confirm" : "close-anyway"}
            onClick={() => {
              void onAllow();
            }}
          >
            {unsaved ? t("common:closeGuard.confirm") : t("common:closeGuard.allow")}
          </Button>
        </div>
      </section>
    </div>
  );
}
