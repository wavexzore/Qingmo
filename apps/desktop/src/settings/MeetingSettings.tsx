import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  KeyStatus,
  MeetingConfigView,
  ModelProgress,
  ModelState,
  ModelView,
  RuntimePreview,
} from "@qingmo/shared";

import { AppError, normalizeError } from "../lib/ipc/errors";
import type { KeySlot, SettingsPort } from "../lib/settings/port";
import { ModelDownloadBanner } from "./ModelDownloadBanner";
import { buildRows, downloadableMembers, type ModelRow } from "./modelGroups";
import { ModelList, type ModelProgressState } from "./ModelList";

type Panel = "local" | "remote";
const SPEAKER_IDS = ["pyannote-segmentation-3-int8", "campplus-zh-en-advanced"];
const PROVIDER_TERMS: Record<string, string> = {
  openai: "https://openai.com/policies/terms-of-use/",
  groq: "https://groq.com/terms-of-service/",
  deepgram: "https://deepgram.com/terms",
};

export interface MeetingSettingsProps {
  settings: SettingsPort;
  onToast(message: string): void;
}

function stateFromProgress(progress: ModelProgress): ModelState {
  switch (progress.state) {
    case "queued":
    case "downloading":
      return "downloading";
    case "verifying":
      return "verifying";
    case "done":
      return "ready";
    case "failed":
      return "failed";
    default:
      return "not_downloaded";
  }
}

function patchConfig(
  config: MeetingConfigView,
  patch: Parameters<SettingsPort["meetingConfigSet"]>[0],
): MeetingConfigView {
  const next = structuredClone(config);
  if (patch.runtimeMode !== undefined) next.runtime.mode = patch.runtimeMode;
  if (patch.asrMode !== undefined) next.asr.mode = patch.asrMode;
  if (patch.asrProvider !== undefined && patch.asrProvider !== next.asr.provider) {
    next.asr.provider = patch.asrProvider;
    next.asr.model = "";
  }
  if (patch.asrModel !== undefined) next.asr.model = patch.asrModel;
  if (patch.asrApiKeyRef !== undefined) next.asr.apiKeyRef = patch.asrApiKeyRef;
  if (patch.asrLocalModel !== undefined) {
    if (patch.asrLocalModel) next.asr.localModel = patch.asrLocalModel;
    else delete next.asr.localModel;
  }
  if (patch.llmMode !== undefined) next.llm.mode = patch.llmMode;
  if (patch.llmBaseUrl !== undefined) next.llm.baseUrl = patch.llmBaseUrl;
  if (patch.llmModel !== undefined) next.llm.model = patch.llmModel;
  if (patch.llmApiKeyRef !== undefined) next.llm.apiKeyRef = patch.llmApiKeyRef;
  if (patch.llmLocalModel !== undefined) {
    if (patch.llmLocalModel) next.llm.localModel = patch.llmLocalModel;
    else delete next.llm.localModel;
  }
  if (patch.keepTranscript !== undefined) next.keepTranscript = patch.keepTranscript;
  if (patch.maxMinutes !== undefined) next.maxMinutes = patch.maxMinutes;
  return next;
}

/**
 * Meeting AI settings: route capsules, local model packs, remote endpoints and
 * the first-use download queue. `config.json` stays the only source of truth;
 * this component only mirrors it while editing.
 */
export function MeetingSettings({ settings, onToast }: MeetingSettingsProps) {
  const { t } = useTranslation("settings");
  const [config, setConfig] = useState<MeetingConfigView | null>(null);
  const [preview, setPreview] = useState<RuntimePreview | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const [diskFree, setDiskFree] = useState(0);
  const [asrRequired, setAsrRequired] = useState(0);
  const [llmRequired, setLlmRequired] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, ModelProgressState>>({});
  const [busy, setBusy] = useState(false);
  const [asrKeyDraft, setAsrKeyDraft] = useState("");
  const [llmKeyDraft, setLlmKeyDraft] = useState("");
  const revisionRef = useRef(0);
  const waiters = useRef(new Map<string, () => void>());
  const activeDownloads = useRef(new Map<string, string>());
  const writeChain = useRef(Promise.resolve());
  const queueRunning = useRef(false);
  const stopQueue = useRef(false);

  const refreshModels = useCallback(async () => {
    setModels(await settings.meetingModelsList());
  }, [settings]);

  const load = useCallback(async () => {
    try {
      const [response, list] = await Promise.all([
        settings.meetingConfigGet(),
        settings.meetingModelsList(),
      ]);
      revisionRef.current = response.config.revision;
      setConfig(response.config);
      setPreview(response.preview);
      setDiskFree(response.disk.freeBytes);
      setAsrRequired(response.disk.asrRequiredBytes);
      setLlmRequired(response.disk.llmRequiredBytes);
      setModels(list);
      setLoadError(null);
    } catch (error) {
      setLoadError(normalizeError(error).message);
    }
  }, [settings]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return settings.onModelProgress((update) => {
      const key = update.modelId;
      activeDownloads.current.set(key, update.downloadId);
      setProgress((current) => ({
        ...current,
        [key]: { doneBytes: update.doneBytes, totalBytes: update.totalBytes },
      }));
      setModels((current) =>
        current.map((model) => {
          if (model.id !== key) {
            return model;
          }
          const next = {
            ...model,
            state: stateFromProgress(update),
            localBytes: update.state === "done" ? model.installBytes : model.localBytes,
          };
          if (update.error) {
            next.error = update.error;
          } else {
            delete next.error;
          }
          return next;
        }),
      );
      if (update.state === "done" || update.state === "failed" || update.state === "cancelled") {
        activeDownloads.current.delete(key);
        waiters.current.get(key)?.();
        waiters.current.delete(key);
        if (update.state !== "done") {
          stopQueue.current = true;
        }
      }
    });
  }, [settings]);

  const apply = useCallback(
    (patch: Parameters<SettingsPort["meetingConfigSet"]>[0]) => {
      setConfig((current) => (current ? patchConfig(current, patch) : current));
      writeChain.current = writeChain.current.then(async () => {
        try {
          const response = await settings.meetingConfigSet(patch, revisionRef.current);
          revisionRef.current = response.revision;
          setConfig((current) => (current ? { ...current, revision: response.revision } : current));
        } catch (error) {
          if (error instanceof AppError && error.code === "CONFLICT") {
            // Re-read, then replay the optimistic patch on the fresh revision.
            await load();
            try {
              const retried = await settings.meetingConfigSet(patch, revisionRef.current);
              revisionRef.current = retried.revision;
              setConfig((current) => (current ? patchConfig(current, patch) : current));
            } catch {
              onToast(t("ai.toast.saveFailed"));
            }
            onToast(t("ai.toast.conflict"));
          } else {
            onToast(t("ai.toast.saveFailed"));
          }
        }
      });
    },
    [load, onToast, settings, t],
  );

  const runDownloads = useCallback(
    async (ids: string[]) => {
      if (queueRunning.current || ids.length === 0) {
        return;
      }
      queueRunning.current = true;
      stopQueue.current = false;
      setBusy(true);
      try {
        for (const id of ids) {
          if (stopQueue.current) {
            break;
          }
          try {
            const { downloadId } = await settings.meetingModelDownload(id);
            activeDownloads.current.set(id, downloadId);
            await new Promise<void>((resolve) => {
              waiters.current.set(id, resolve);
            });
            await refreshModels();
          } catch (error) {
            const code = normalizeError(error).code;
            onToast(
              code === "MODEL_BUSY"
                ? t("ai.toast.busy")
                : code === "MODEL_DOWNLOAD_FAILED"
                  ? t("ai.toast.diskFull")
                  : t("ai.toast.downloadFailed"),
            );
            break;
          }
        }
      } finally {
        queueRunning.current = false;
        setBusy(false);
        await refreshModels();
      }
    },
    [onToast, refreshModels, settings, t],
  );

  const cancelRow = useCallback(
    async (row: ModelRow) => {
      stopQueue.current = true;
      for (const member of row.members) {
        const downloadId = activeDownloads.current.get(member.id);
        if (downloadId) {
          try {
            await settings.meetingModelDownloadCancel(downloadId);
          } catch {
            // The worker may already have settled.
          }
        }
      }
    },
    [settings],
  );

  const removeRow = useCallback(
    async (row: ModelRow) => {
      for (const id of row.members
        .filter((member) => member.state !== "not_downloaded")
        .map((member) => member.id)) {
        try {
          await settings.meetingModelRemove(id);
        } catch (error) {
          if (normalizeError(error).code !== "MODEL_NOT_READY") {
            onToast(t("ai.toast.removeFailed"));
            break;
          }
        }
      }
      await Promise.all([refreshModels(), load()]);
    },
    [load, onToast, refreshModels, settings, t],
  );

  const setKey = useCallback(
    async (slot: KeySlot, value: string) => {
      try {
        await settings.meetingKeySet(slot, value);
        if (slot === "asr") setAsrKeyDraft("");
        else setLlmKeyDraft("");
        onToast(t("ai.keys.saved"));
        await load();
      } catch {
        onToast(t("ai.keys.saveFailed"));
      }
    },
    [load, onToast, settings, t],
  );

  const clearKey = useCallback(
    async (slot: KeySlot) => {
      try {
        await settings.meetingKeyClear(slot);
        await load();
      } catch {
        onToast(t("ai.keys.saveFailed"));
      }
    },
    [load, onToast, settings, t],
  );

  const asrRows = useMemo(
    () =>
      buildRows(
        models.filter((model) => model.kind === "asr"),
        false,
      ),
    [models],
  );
  const groupRows = useMemo(() => buildRows(models, true), [models]);
  const llmRows = useMemo(
    () =>
      buildRows(
        models.filter((model) => model.kind === "llm"),
        false,
      ),
    [models],
  );

  const asrGapIds = useMemo(() => {
    if (!config || !preview) return [];
    const selected = config.asr.localModel ?? preview.defaults.asrModel;
    const ids = [
      selected,
      preview.resolved?.asr ?? preview.defaults.asrModel,
      preview.defaults.asrModel,
      "silero-vad",
      ...SPEAKER_IDS,
    ];
    return [...new Set(ids)].filter(
      (id) => models.find((model) => model.id === id)?.state !== "ready",
    );
  }, [config, models, preview]);

  const asrSetBytes = useMemo(
    () =>
      asrGapIds.reduce(
        (total, id) => total + (models.find((model) => model.id === id)?.downloadBytes ?? 0),
        0,
      ),
    [asrGapIds, models],
  );

  const llmGapIds = useMemo(() => {
    const resolved = preview?.resolved?.llm ?? preview?.defaults.llmModel;
    if (!resolved) return [];
    return models.find((model) => model.id === resolved)?.state === "ready" ? [] : [resolved];
  }, [models, preview]);

  const llmSetBytes = useMemo(
    () =>
      llmGapIds.reduce(
        (total, id) => total + (models.find((model) => model.id === id)?.downloadBytes ?? 0),
        0,
      ),
    [llmGapIds, models],
  );

  const firstUse = useMemo(() => {
    const members = [...new Set([...asrGapIds, preview?.defaults.asrModel ?? ""])].filter(Boolean);
    return (
      members.length > 0 &&
      members.every((id) => models.find((m) => m.id === id)?.state === "not_downloaded")
    );
  }, [asrGapIds, models, preview]);

  const selectedAsr = config?.asr.localModel ?? preview?.defaults.asrModel ?? "";
  const selectedAsrReady = models.find((model) => model.id === selectedAsr)?.state === "ready";

  const modeRow = (
    label: string,
    value: Panel,
    onChange: (mode: Panel) => void,
    testId: string,
    labels?: Record<Panel, string>,
  ) => (
    <div className="meeting-capsule" role="group" aria-label={label}>
      {(["local", "remote"] as const).map((mode) => (
        <button
          className={`meeting-capsule-item${value === mode ? " is-active" : ""}`}
          type="button"
          key={mode}
          data-testid={`${testId}-${mode}`}
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
        >
          {labels ? labels[mode] : t(`ai.mode.${mode}`)}
        </button>
      ))}
    </div>
  );

  const keyControl = (
    slot: KeySlot,
    status: KeyStatus,
    draft: string,
    setDraft: (v: string) => void,
  ) => (
    <div className="meeting-key">
      <label className="meeting-field">
        <span>{t("ai.keys.label")}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          data-testid={`key-input-${slot}`}
          placeholder={t("ai.keys.placeholder")}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      </label>
      <div className="meeting-key-foot">
        <span className={`meeting-state is-key-${status}`}>{t(`ai.keys.status.${status}`)}</span>
        <div className="meeting-model-actions">
          <button
            className="meeting-button is-quiet"
            type="button"
            data-testid={`key-save-${slot}`}
            disabled={!draft.trim()}
            onClick={() => void setKey(slot, draft.trim())}
          >
            {t("ai.keys.save")}
          </button>
          {status === "present" ? (
            <button
              className="meeting-button is-quiet"
              type="button"
              data-testid={`key-clear-${slot}`}
              onClick={() => void clearKey(slot)}
            >
              {t("ai.keys.clear")}
            </button>
          ) : null}
        </div>
      </div>
      {status === "keyring_unavailable" ? (
        <p className="meeting-warn">{t("ai.keys.unavailable")}</p>
      ) : null}
    </div>
  );

  if (loadError) {
    return (
      <div className="meeting-load-error" role="alert">
        <p>{t("ai.loadError")}</p>
        <button className="meeting-button is-quiet" type="button" onClick={() => void load()}>
          {t("ai.retry")}
        </button>
      </div>
    );
  }

  if (!config || !preview) {
    return (
      <p className="meeting-loading" role="status">
        {t("ai.loading")}
      </p>
    );
  }

  const renderLocalModels = (rows: ModelRow[]) => (
    <ModelList
      rows={rows}
      progress={progress}
      onDownload={(row) => void runDownloads(downloadableMembers(row))}
      onCancel={(row) => void cancelRow(row)}
      onRemove={(row) => void removeRow(row)}
      onLicense={(href) => void settings.openExternal(href)}
    />
  );

  return (
    <div className="meeting-settings">
      <section className="settings-section" aria-labelledby="meeting-asr-heading">
        <header className="settings-section-head">
          <span className="settings-section-num">01</span>
          <h2 id="meeting-asr-heading">{t("ai.asr.title")}</h2>
          <span className="settings-section-rule" aria-hidden="true" />
        </header>
        <div className="settings-row">
          <div className="settings-copy">
            <h3>{t("ai.runtime.label")}</h3>
            <p>{t("ai.runtime.description")}</p>
          </div>
          {modeRow(
            t("ai.runtime.label"),
            config.runtime.mode === "cpu" ? "remote" : "local",
            (mode) => void apply({ runtimeMode: mode === "remote" ? "cpu" : "auto" }),
            "runtime",
            { local: t("ai.runtime.auto"), remote: t("ai.runtime.cpu") },
          )}
        </div>
        <p className="settings-hint">{t("ai.runtime.hint")}</p>
        <div className="settings-row">
          <div className="settings-copy">
            <h3>{t("ai.route.label")}</h3>
            <p>{t("ai.route.asrDescription")}</p>
          </div>
          {modeRow(
            t("ai.route.label"),
            config.asr.mode,
            (mode) => void apply({ asrMode: mode }),
            "asr-mode",
          )}
        </div>

        <p className="settings-hint">{t("ai.route.separationFixed")}</p>

        {config.asr.mode === "local" ? (
          <div className="meeting-panel" data-testid="asr-local-panel">
            <div className="settings-row">
              <div className="settings-copy">
                <h3>{t("ai.asr.model")}</h3>
                <p>{t("ai.asr.modelHint")}</p>
              </div>
              <select
                className="meeting-select"
                data-testid="asr-model-select"
                value={config.asr.localModel ?? ""}
                onChange={(event) => void apply({ asrLocalModel: event.currentTarget.value })}
              >
                <option value="">
                  {t("ai.models.auto", { model: preview.defaults.asrModel })}
                </option>
                {asrRows.map((row) => (
                  <option key={row.key} value={row.members[0]?.id ?? ""}>
                    {row.display}
                    {row.state === "ready" ? ` · ${t("ai.models.readySuffix")}` : ""}
                  </option>
                ))}
              </select>
            </div>
            {preview.unsupported ? (
              <p className="meeting-warn">{t("ai.models.unsupported")}</p>
            ) : null}
            {config.asr.localModel === "fireredasr2-ctc-int8" ? (
              <p className="meeting-warn">{t("ai.models.fireRedHint")}</p>
            ) : null}
            <ModelDownloadBanner
              kind="asr"
              missingCount={asrGapIds.length}
              totalBytes={asrSetBytes}
              freeBytes={diskFree}
              requiredBytes={asrRequired}
              busy={busy}
              firstUse={firstUse}
              onDownload={() => void runDownloads(asrGapIds)}
              secondaryLabel={
                selectedAsrReady ? t("ai.banner.asrReady") : t("ai.banner.asrSecondary")
              }
              secondaryDisabled={selectedAsrReady}
              onSecondary={() => selectedAsr && void runDownloads([selectedAsr])}
            />
            {preview.defaults.notes.map((note) => (
              <p className="meeting-warn" key={note}>
                {t(`ai.notes.${note}`)}
              </p>
            ))}
            {renderLocalModels([...asrRows, ...groupRows])}
          </div>
        ) : (
          <div className="meeting-panel" data-testid="asr-remote-panel">
            <div className="settings-row">
              <div className="settings-copy">
                <h3>{t("ai.asr.provider")}</h3>
                <p>{t("ai.asr.providerHint")}</p>
              </div>
              <select
                className="meeting-select"
                data-testid="asr-provider"
                value={config.asr.provider}
                onChange={(event) =>
                  void apply({
                    asrProvider: event.currentTarget.value as "openai" | "groq" | "deepgram",
                  })
                }
              >
                <option value="openai">OpenAI</option>
                <option value="groq">Groq</option>
                <option value="deepgram">Deepgram</option>
              </select>
            </div>
            <label className="meeting-field">
              <span>{t("ai.asr.remoteModel")}</span>
              <input
                value={config.asr.model}
                data-testid="asr-model"
                placeholder={t("ai.asr.remoteModelPlaceholder")}
                onChange={(event) => void apply({ asrModel: event.currentTarget.value })}
              />
            </label>
            {keyControl("asr", config.asr.keyStatus, asrKeyDraft, setAsrKeyDraft)}
            <button
              className="meeting-link"
              type="button"
              onClick={() =>
                void settings.openExternal(
                  PROVIDER_TERMS[config.asr.provider] ??
                    "https://openai.com/policies/terms-of-use/",
                )
              }
            >
              {t("ai.asr.terms", { provider: config.asr.provider })}
            </button>
            <p className="settings-hint">{t("ai.asr.uploadHint")}</p>
          </div>
        )}
      </section>

      <section className="settings-section" aria-labelledby="meeting-llm-heading">
        <header className="settings-section-head">
          <span className="settings-section-num">02</span>
          <h2 id="meeting-llm-heading">
            {t("ai.llm.title")}
            {config.runtime.mode === "cpu" ? (
              <span className="meeting-tag">{t("ai.llm.cpu")}</span>
            ) : null}
          </h2>
          <span className="settings-section-rule" aria-hidden="true" />
        </header>
        <div className="settings-row">
          <div className="settings-copy">
            <h3>{t("ai.route.label")}</h3>
            <p>{t("ai.route.llmDescription")}</p>
          </div>
          {modeRow(
            t("ai.route.label"),
            config.llm.mode,
            (mode) => void apply({ llmMode: mode }),
            "llm-mode",
          )}
        </div>

        {config.llm.mode === "local" ? (
          <div className="meeting-panel" data-testid="llm-local-panel">
            <div className="settings-row">
              <div className="settings-copy">
                <h3>{t("ai.llm.model")}</h3>
                <p>{t("ai.llm.modelHint")}</p>
              </div>
              <select
                className="meeting-select"
                data-testid="llm-model-select"
                value={config.llm.localModel ?? ""}
                onChange={(event) => void apply({ llmLocalModel: event.currentTarget.value })}
              >
                <option value="">
                  {t("ai.models.auto", { model: preview.defaults.llmModel })}
                </option>
                {llmRows.map((row) => (
                  <option key={row.key} value={row.members[0]?.id ?? ""}>
                    {row.display}
                    {row.state === "ready" ? ` · ${t("ai.models.readySuffix")}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <ModelDownloadBanner
              kind="llm"
              missingCount={llmGapIds.length}
              totalBytes={llmSetBytes}
              freeBytes={diskFree}
              requiredBytes={llmRequired}
              busy={busy}
              firstUse={llmGapIds.every(
                (id) => models.find((model) => model.id === id)?.state === "not_downloaded",
              )}
              onDownload={() => void runDownloads(llmGapIds)}
            />
            {preview.defaults.notes.map((note) => (
              <p className="meeting-warn" key={note}>
                {t(`ai.notes.${note}`)}
              </p>
            ))}
            {renderLocalModels(llmRows)}
          </div>
        ) : (
          <div className="meeting-panel" data-testid="llm-remote-panel">
            <label className="meeting-field">
              <span>{t("ai.llm.baseUrl")}</span>
              <input
                value={config.llm.baseUrl}
                data-testid="llm-base-url"
                placeholder="https://api.example.com/v1"
                onChange={(event) => void apply({ llmBaseUrl: event.currentTarget.value })}
              />
            </label>
            <p className="settings-hint">{t("ai.llm.baseUrlHint")}</p>
            <label className="meeting-field">
              <span>{t("ai.llm.remoteModel")}</span>
              <input
                value={config.llm.model}
                data-testid="llm-model"
                placeholder={t("ai.llm.remoteModelPlaceholder")}
                onChange={(event) => void apply({ llmModel: event.currentTarget.value })}
              />
            </label>
            {keyControl("llm", config.llm.keyStatus, llmKeyDraft, setLlmKeyDraft)}
            <p className="settings-hint">{t("ai.llm.emptyHint")}</p>
          </div>
        )}
      </section>

      <section className="settings-section" aria-labelledby="meeting-scope-heading">
        <header className="settings-section-head">
          <span className="settings-section-num">03</span>
          <h2 id="meeting-scope-heading">{t("ai.scope.title")}</h2>
          <span className="settings-section-rule" aria-hidden="true" />
        </header>
        <div className="settings-row">
          <div className="settings-copy">
            <h3>{t("ai.scope.keep")}</h3>
            <p>{t("ai.scope.keepHint")}</p>
          </div>
          <label className="meeting-switch">
            <input
              type="checkbox"
              checked={config.keepTranscript}
              data-testid="keep-transcript"
              onChange={(event) => void apply({ keepTranscript: event.currentTarget.checked })}
            />
            <span>{t("ai.scope.keepLabel")}</span>
          </label>
        </div>
        <div className="settings-row">
          <div className="settings-copy">
            <h3>{t("ai.scope.maxMinutes")}</h3>
            <p>{t("ai.scope.maxMinutesHint")}</p>
          </div>
          <input
            className="meeting-number"
            type="number"
            min={5}
            max={600}
            step={5}
            value={config.maxMinutes}
            data-testid="max-minutes"
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value) && value >= 5 && value <= 600) {
                void apply({ maxMinutes: value });
              }
            }}
          />
        </div>
      </section>
    </div>
  );
}
