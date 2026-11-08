import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import type { SearchResponse } from "@qingmo/shared";

import type { IpcPort } from "../../lib/ipc/port";

interface SearchPanelProps {
  ipc: Pick<IpcPort, "workspaceSearch">;
  workspaceToken: string;
  active: boolean;
  focusRequest: number;
  onOpenFile(segments: string[]): void | Promise<boolean>;
}

const DEBOUNCE_MS = 200;

export function SearchPanel({
  ipc,
  workspaceToken,
  active,
  focusRequest,
  onOpenFile,
}: SearchPanelProps) {
  const { t } = useTranslation(["workspace"]);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (active && focusRequest > 0) {
      inputRef.current?.focus();
    }
  }, [active, focusRequest]);

  useEffect(() => {
    const current = ++generation.current;
    const trimmed = query.trim();
    if (!trimmed) {
      setResponse(null);
      setError(null);
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      setLoading(true);
      void ipc
        .workspaceSearch(workspaceToken, trimmed, 30, 0)
        .then((next) => {
          if (generation.current !== current) return;
          setResponse(next);
          setError(next.error ?? null);
          setSelected(0);
        })
        .catch((reason: unknown) => {
          if (generation.current !== current) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (generation.current === current) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [ipc, query, workspaceToken]);

  const openSelected = (index: number): void => {
    const hit = response?.results[index];
    if (!hit) return;
    void onOpenFile(hit.path.split("/").filter(Boolean));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const count = response?.results.length ?? 0;
    if (event.key === "ArrowDown" && count > 0) {
      event.preventDefault();
      setSelected((current) => (current + 1) % count);
    } else if (event.key === "ArrowUp" && count > 0) {
      event.preventDefault();
      setSelected((current) => (current - 1 + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      openSelected(selected);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      setResponse(null);
      setError(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="search-panel">
      <div className="shrink-0 border-b border-line px-2 py-2">
        <input
          ref={inputRef}
          type="search"
          role="searchbox"
          aria-label={t("workspace:search.label")}
          placeholder={t("workspace:search.placeholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="w-full rounded border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent"
        />
      </div>
      {error ? (
        <p role="alert" className="px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      {loading || response?.indexing ? (
        <p role="status" className="px-3 py-2 text-xs text-ink-muted">
          {t("workspace:search.indexing")}
        </p>
      ) : null}
      {response && response.results.length === 0 && !loading && !error ? (
        <p role="status" className="px-3 py-3 text-sm text-ink-muted">
          {t("workspace:search.empty")}
        </p>
      ) : null}
      <ul
        role="listbox"
        aria-label={t("workspace:search.results")}
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {response?.results.map((hit, index) => (
          <li key={`${hit.path}-${hit.mtimeMs}`} role="option" aria-selected={index === selected}>
            <button
              type="button"
              onMouseEnter={() => setSelected(index)}
              onClick={() => openSelected(index)}
              className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left ${
                index === selected ? "bg-surface-raised" : "hover:bg-surface-raised/60"
              }`}
            >
              <span className="truncate text-sm font-medium text-ink">{hit.title}</span>
              <span className="truncate text-[10px] text-ink-faint">{hit.path}</span>
              {hit.snippet ? (
                <span className="line-clamp-2 text-xs text-ink-muted">{hit.snippet}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
