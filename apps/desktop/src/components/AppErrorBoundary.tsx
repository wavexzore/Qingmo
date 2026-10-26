import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@qingmo/ui";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

function ErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation("common");
  return (
    <main className="grid min-h-dvh place-items-center bg-paper p-6 text-ink">
      <section className="w-full max-w-[520px] rounded-card border border-line bg-surface p-8 shadow-card">
        <p className="text-[10px] uppercase tracking-[0.18em] text-danger">{t("appNameLatin")}</p>
        <h1 className="mt-3 font-serif text-3xl tracking-[-0.03em]">{t("errorBoundary.title")}</h1>
        <p className="mt-3 text-sm leading-7 text-ink-muted">{t("errorBoundary.description")}</p>
        <pre className="mt-5 max-h-40 overflow-auto rounded-md border border-line bg-surface-muted p-3 text-xs text-ink-muted">
          {error.message}
        </pre>
        <Button className="mt-6" onClick={onRetry}>
          {t("actions.retry")}
        </Button>
      </section>
    </main>
  );
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Qingmo UI error", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorFallback error={this.state.error} onRetry={() => this.setState({ error: null })} />
      );
    }
    return this.props.children;
  }
}
