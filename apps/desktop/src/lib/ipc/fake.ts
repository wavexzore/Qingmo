import type {
  AppErrorCode,
  ApplyLocaleRequest,
  DocumentChangedPayload,
  DraftKind,
  DraftMeta,
  DraftRecord,
  DraftWriteRequest,
  EditorViewState,
  EditorViewStateInput,
  FilePayload,
  JsonValue,
  ReadOnlyReason,
  SaveRequest,
  SaveResult,
  TextFormat,
} from "@qingmo/shared";

import { COMMANDS, type CommandName } from "./commands";
import { AppError } from "./errors";
import type { CloseConfirmRequest, IpcPort, LivePreviewRequest } from "./port";

export const FAKE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FAKE_MAX_DRAFT_BYTES = 2 * 1024 * 1024;
const FAKE_MAX_DRAFT_COUNT = 20;
const FAKE_MAX_DRAFT_TOTAL_BYTES = 8 * 1024 * 1024;
const FAKE_MAX_DRAFT_TITLE = 200;
const FAKE_MAX_VIEW_STATES = 200;

const textEncoder = new TextEncoder();

export interface FakeFile {
  path: string;
  text?: string;
  format?: Partial<TextFormat>;
  readOnlyReason?: ReadOnlyReason | null;
}

export interface FakeIpcOptions {
  files?: FakeFile[];
  /** `null` simulates a cancelled native open dialog. */
  openFile?: string | null;
  /** `null` simulates a cancelled native save dialog. */
  saveAsFile?: string | null;
  delayMs?: number;
}

export interface FakeFileSnapshot {
  path: string;
  text: string;
  format: TextFormat;
  readOnlyReason: ReadOnlyReason | null;
  baseHash: string;
  diskHash: string;
  size: number;
  mtimeMs: number;
}

interface FakeRecord {
  path: string;
  /** Current disk text, always LF-only. */
  text: string;
  format: TextFormat;
  readOnlyReason: ReadOnlyReason | null;
  /** Hash of the version the editor last opened/reloaded/saved. */
  baseHash: string;
  /** Hash of what the fake "disk" currently contains. */
  diskHash: string;
  size: number;
  mtimeMs: number;
}

/**
 * Deterministic non-cryptographic hash for the browser fake. The real adapter
 * never sees this value; it only needs stable conflict semantics.
 */
export function fakeHash(text: string): string {
  const bytes = textEncoder.encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fake-${hash.toString(16).padStart(8, "0")}-${bytes.length.toString(16)}`;
}

function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

function ensureMarkdownPath(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const extension = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : undefined;
  if (extension === "md" || extension === "markdown") {
    return path;
  }
  if (!fileName.includes(".") || fileName.endsWith(".")) {
    return `${path}.md`;
  }
  throw new AppError("UNSUPPORTED_EXTENSION", "save-as only supports .md and .markdown files");
}

function copyFormat(format: TextFormat): TextFormat {
  return {
    encoding: format.encoding,
    hasBom: format.hasBom,
    eol: format.eol,
  };
}

/**
 * In-memory IpcPort for browser tests and Playwright.
 *
 * It mirrors the Rust contract closely enough to drive T-008/T-011/T-012 and
 * T-018: single active token, always-hash conflict detection, exact
 * `expectedCurrentHash` override, read-only documents, delayed responses, and
 * one-shot/persistent error injection.
 */
export class FakeIpc implements IpcPort {
  private readonly records = new Map<string, FakeRecord>();
  private readonly queuedErrors = new Map<CommandName, AppError[]>();
  private readonly persistentErrors = new Map<CommandName, AppError>();
  private readonly commandDelays = new Map<CommandName, number>();
  private readonly documentChangedListeners = new Set<(change: DocumentChangedPayload) => void>();
  private readonly viewStates = new Map<string, EditorViewState>();
  private readonly drafts = new Map<string, DraftRecord>();
  private active: { token: string; path: string } | null = null;
  private pending: FilePayload | null = null;
  private openFile: string | null;
  private saveAsFile: string | null;
  private nextToken = 1;
  private clock = 0;
  private defaultDelayMs: number;

  readonly closeConfirmCalls: CloseConfirmRequest[] = [];
  readonly livePreviewCalls: boolean[] = [];
  readonly viewStateWrites: Array<{ path: string; state: EditorViewState }> = [];
  readonly localeCalls: ApplyLocaleRequest[] = [];

  constructor(options: FakeIpcOptions = {}) {
    for (const file of options.files ?? []) {
      this.addFile(file);
    }
    this.openFile =
      options.openFile !== undefined
        ? options.openFile
        : (this.records.keys().next().value ?? null);
    this.saveAsFile = options.saveAsFile !== undefined ? options.saveAsFile : "/docs/untitled.md";
    this.defaultDelayMs = options.delayMs ?? 0;
  }

  addFile(file: FakeFile): void {
    if (this.records.has(file.path)) {
      throw new Error(`duplicate fake file: ${file.path}`);
    }
    const text = file.text ?? "";
    const hash = fakeHash(text);
    this.records.set(file.path, {
      path: file.path,
      text,
      format: {
        encoding: file.format?.encoding ?? "utf8",
        hasBom: file.format?.hasBom ?? false,
        eol: file.format?.eol ?? "lf",
      },
      readOnlyReason: file.readOnlyReason ?? null,
      baseHash: hash,
      diskHash: hash,
      size: byteLength(text),
      mtimeMs: this.tick(),
    });
  }

  setOpenFile(path: string | null): void {
    this.openFile = path;
  }

  setSaveAsFile(path: string | null): void {
    this.saveAsFile = path;
  }

  /** Simulates an external editor changing the file; the base hash stays old. */
  setDiskText(path: string, text: string): void {
    const record = this.records.get(path);
    if (!record) {
      throw new AppError("NOT_FOUND", `fake file not found: ${path}`);
    }
    record.text = text;
    record.diskHash = fakeHash(text);
    record.size = byteLength(text);
    record.mtimeMs = this.tick();
    this.emitDiskModified(path);
  }

  /** Simulates another program deleting or moving the open file. */
  deleteDiskFile(path: string): void {
    if (!this.records.delete(path)) {
      throw new AppError("NOT_FOUND", `fake file not found: ${path}`);
    }
    if (this.active?.path === path) {
      this.emitDocumentChanged({
        docToken: this.active.token,
        kind: "deleted",
      });
    }
  }

  /**
   * Mirrors the Rust watcher event. The fake only reports changes for the
   * active document, exactly like a window ignores other tokens.
   */
  onDocumentChanged(callback: (change: DocumentChangedPayload) => void): () => void {
    this.documentChangedListeners.add(callback);
    return () => {
      this.documentChangedListeners.delete(callback);
    };
  }

  getFile(path: string): FakeFileSnapshot | undefined {
    const record = this.records.get(path);
    if (!record) {
      return undefined;
    }
    return {
      path: record.path,
      text: record.text,
      format: copyFormat(record.format),
      readOnlyReason: record.readOnlyReason,
      baseHash: record.baseHash,
      diskHash: record.diskHash,
      size: record.size,
      mtimeMs: record.mtimeMs,
    };
  }

  getActiveToken(): string | null {
    return this.active?.token ?? null;
  }

  setDelay(milliseconds: number): void {
    this.defaultDelayMs = milliseconds;
  }

  setCommandDelay(command: CommandName, milliseconds: number): void {
    this.commandDelays.set(command, milliseconds);
  }

  failNext(
    command: CommandName,
    code: AppErrorCode = "IO",
    message = "injected failure",
    details?: JsonValue,
  ): void {
    const queue = this.queuedErrors.get(command) ?? [];
    queue.push(new AppError(code, message, details));
    this.queuedErrors.set(command, queue);
  }

  failAlways(
    command: CommandName,
    code: AppErrorCode = "IO",
    message = "injected persistent failure",
    details?: JsonValue,
  ): void {
    this.persistentErrors.set(command, new AppError(code, message, details));
  }

  clearInjectedErrors(): void {
    this.queuedErrors.clear();
    this.persistentErrors.clear();
  }

  /**
   * Browser harness fallback: the fake cannot create a native window, so it
   * returns the payload and the UI adopts it in place.
   */
  async documentOpen(): Promise<FilePayload> {
    await this.wait(COMMANDS.documentOpen);
    this.maybeThrow(COMMANDS.documentOpen);

    const path = this.openFile;
    if (path === null) {
      throw new AppError("CANCELLED", "file dialog was cancelled");
    }
    const record = this.records.get(path);
    if (!record) {
      throw new AppError("NOT_FOUND", `fake file not found: ${path}`);
    }

    // The browser harness adopts in place, so opening establishes a new base
    // version and replaces the fake's single active token.
    record.baseHash = record.diskHash;
    const token = `fake-doc-${this.nextToken}`;
    this.nextToken += 1;
    this.active = { token, path };
    return this.toPayload(record, token);
  }

  /** Seeds a payload for a simulated document window boot. */
  stagePending(payload: FilePayload): void {
    this.pending = payload;
  }

  /** Seeds the file currently registered under `path` for a document window. */
  stagePendingPath(path: string): void {
    const record = this.records.get(path);
    if (!record) {
      throw new AppError("NOT_FOUND", `fake file not found: ${path}`);
    }
    const token = `fake-doc-${this.nextToken}`;
    this.nextToken += 1;
    this.stagePending(this.toPayload(record, token));
  }

  async documentTakePending(): Promise<FilePayload | null> {
    const payload = this.pending;
    this.pending = null;
    if (!payload) {
      return null;
    }
    this.active = { token: payload.docToken, path: payload.path };
    return payload;
  }

  async documentSaveAs(text: string): Promise<FilePayload> {
    await this.wait(COMMANDS.documentSaveAs);
    this.maybeThrow(COMMANDS.documentSaveAs);

    const path = this.saveAsFile;
    if (path === null) {
      throw new AppError("CANCELLED", "save dialog was cancelled");
    }
    const target = ensureMarkdownPath(path);
    this.validateText(text);

    const existing = this.records.get(target);
    const format = existing
      ? copyFormat(existing.format)
      : { encoding: "utf8" as const, hasBom: false, eol: "lf" as const };
    const hash = fakeHash(text);
    const next: FakeRecord = {
      path: target,
      text,
      format,
      readOnlyReason: null,
      baseHash: hash,
      diskHash: hash,
      size: byteLength(text),
      mtimeMs: this.tick(),
    };
    this.records.set(target, next);

    const token = `fake-doc-${this.nextToken}`;
    this.nextToken += 1;
    this.active = { token, path: target };
    return this.toPayload(next, token);
  }

  async documentReload(docToken: string): Promise<FilePayload> {
    await this.wait(COMMANDS.documentReload);
    this.maybeThrow(COMMANDS.documentReload);

    const record = this.requireActive(docToken, COMMANDS.documentReload);
    record.baseHash = record.diskHash;
    return this.toPayload(record, docToken);
  }

  async documentWriteAtomic(request: SaveRequest): Promise<SaveResult> {
    await this.wait(COMMANDS.documentWriteAtomic);
    this.maybeThrow(COMMANDS.documentWriteAtomic);

    const record = this.requireActive(request.docToken, COMMANDS.documentWriteAtomic);
    if (record.readOnlyReason !== null) {
      throw new AppError("READ_ONLY", `document is read-only: ${record.readOnlyReason}`);
    }

    if (record.diskHash !== record.baseHash && request.expectedCurrentHash !== record.diskHash) {
      throw new AppError("CONFLICT", "file changed on disk since it was opened", {
        currentHash: record.diskHash,
        currentMtimeMs: record.mtimeMs,
        currentSize: record.size,
      });
    }

    this.validateText(request.text);

    const newHash = fakeHash(request.text);
    if (newHash === record.diskHash) {
      // Byte-identical confirmation: refresh the base version without a write.
      record.baseHash = record.diskHash;
      return {
        hash: record.diskHash,
        size: record.size,
        mtimeMs: record.mtimeMs,
      };
    }

    record.text = request.text;
    record.diskHash = newHash;
    record.baseHash = newHash;
    record.size = byteLength(request.text);
    record.mtimeMs = this.tick();

    return {
      hash: record.diskHash,
      size: record.size,
      mtimeMs: record.mtimeMs,
    };
  }

  async appCloseConfirm(request: CloseConfirmRequest): Promise<void> {
    await this.wait(COMMANDS.appCloseConfirm);
    this.maybeThrow(COMMANDS.appCloseConfirm);
    this.closeConfirmCalls.push({ allow: request.allow });
  }

  async appSetLivePreview(request: LivePreviewRequest): Promise<void> {
    await this.wait(COMMANDS.appSetLivePreview);
    this.maybeThrow(COMMANDS.appSetLivePreview);
    this.livePreviewCalls.push(request.livePreview);
  }

  async appApplyLocale(request: ApplyLocaleRequest): Promise<void> {
    await this.wait(COMMANDS.appApplyLocale);
    this.maybeThrow(COMMANDS.appApplyLocale);
    this.localeCalls.push(request);
  }

  private emitDiskModified(path: string): void {
    if (!this.active || this.active.path !== path) {
      return;
    }
    const record = this.records.get(path);
    if (!record) {
      return;
    }
    this.emitDocumentChanged({
      docToken: this.active.token,
      kind: "modified",
      currentHash: record.diskHash,
      currentSize: record.size,
      currentMtimeMs: record.mtimeMs,
    });
  }

  private emitDocumentChanged(change: DocumentChangedPayload): void {
    for (const listener of [...this.documentChangedListeners]) {
      listener(change);
    }
  }

  private requireActive(docToken: string, command: CommandName): FakeRecord {
    if (!this.active || this.active.token !== docToken) {
      throw new AppError("INVALID_PATH", `unknown or expired docToken for ${command}`);
    }
    const record = this.records.get(this.active.path);
    if (!record) {
      throw new AppError("NOT_FOUND", `fake file not found: ${this.active.path}`);
    }
    return record;
  }

  private validateText(text: string): void {
    if (text.includes("\r")) {
      throw new AppError("IO", "save text must use LF-only line endings");
    }
    if (text.includes("\0")) {
      throw new AppError("IO", "save text must not contain NUL characters");
    }
    if (byteLength(text) > FAKE_MAX_FILE_BYTES) {
      throw new AppError("FILE_TOO_LARGE", `file exceeds ${FAKE_MAX_FILE_BYTES} bytes`);
    }
  }

  private toPayload(record: FakeRecord, docToken: string): FilePayload {
    return {
      docToken,
      path: record.path,
      text: record.text,
      format: copyFormat(record.format),
      mixedEol: false,
      hash: record.diskHash,
      size: record.size,
      textUnits: record.text.length,
      mtimeMs: record.mtimeMs,
      readOnly: record.readOnlyReason !== null,
      readOnlyReason: record.readOnlyReason,
    };
  }

  private async wait(command: CommandName): Promise<void> {
    const milliseconds = this.commandDelays.get(command) ?? this.defaultDelayMs;
    if (milliseconds > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      });
    }
  }

  private maybeThrow(command: CommandName): void {
    const persistent = this.persistentErrors.get(command);
    if (persistent) {
      throw persistent;
    }
    const queue = this.queuedErrors.get(command);
    const next = queue?.shift();
    if (!next) {
      return;
    }
    if (queue && queue.length === 0) {
      this.queuedErrors.delete(command);
    }
    throw next;
  }

  /** Seeds a persisted view state exactly as Rust would return it. */
  seedViewState(path: string, state: EditorViewState): void {
    this.viewStates.set(path, { ...state });
  }

  /** Seeds a crash draft, e.g. to drive the recovery banner in browser tests. */
  seedDraft(record: DraftRecord): void {
    this.drafts.set(record.id, { ...record });
  }

  async sessionViewStateGet(path: string): Promise<EditorViewState | null> {
    await this.wait(COMMANDS.sessionViewStateGet);
    this.maybeThrow(COMMANDS.sessionViewStateGet);
    const state = this.viewStates.get(path);
    return state ? { ...state } : null;
  }

  async sessionViewStateSet(path: string, state: EditorViewStateInput): Promise<void> {
    await this.wait(COMMANDS.sessionViewStateSet);
    this.maybeThrow(COMMANDS.sessionViewStateSet);
    if (!path) {
      throw new AppError("INVALID_PATH", "view state path must not be empty");
    }
    const entry: EditorViewState = {
      anchor: clampInt(state.anchor, 0, 0xffff_ffff),
      head: clampInt(state.head, 0, 0xffff_ffff),
      topPos: clampInt(state.topPos, 0, 0xffff_ffff),
      topOffset: clampNumber(state.topOffset, -1_000_000, 1_000_000),
      scrollLeft: clampNumber(state.scrollLeft, 0, 1_000_000),
      livePreviewPreferred: state.livePreviewPreferred,
      updatedAtMs: this.tick(),
    };
    // Mirrors the Rust cap: drop the oldest keys above 200 entries.
    if (!this.viewStates.has(path) && this.viewStates.size >= FAKE_MAX_VIEW_STATES) {
      const oldest = [...this.viewStates.entries()].sort(
        (left, right) => left[1].updatedAtMs - right[1].updatedAtMs,
      )[0];
      if (oldest) {
        this.viewStates.delete(oldest[0]);
      }
    }
    this.viewStates.set(path, entry);
    this.viewStateWrites.push({ path, state: entry });
  }

  async sessionDraftWrite(request: DraftWriteRequest): Promise<DraftMeta> {
    await this.wait(COMMANDS.sessionDraftWrite);
    this.maybeThrow(COMMANDS.sessionDraftWrite);

    const kind = request.kind.trim().toLowerCase();
    if (kind !== "untitled" && kind !== "named") {
      throw new AppError("INVALID_PATH", `unknown draft kind: ${request.kind}`);
    }
    if (kind === "named" && !request.path) {
      throw new AppError("INVALID_PATH", "named drafts require a path");
    }
    const bytes = byteLength(request.text);
    if (bytes > FAKE_MAX_DRAFT_BYTES) {
      throw new AppError("FILE_TOO_LARGE", `draft text exceeds ${FAKE_MAX_DRAFT_BYTES} bytes`);
    }

    const existing = request.id ? this.drafts.get(request.id) : undefined;
    const id = existing?.id ?? request.id ?? newUuid();
    const createdAtMs = existing?.createdAtMs ?? this.tick();
    const record: DraftRecord = {
      schemaVersion: 1,
      id,
      kind: (existing?.kind ?? kind) as DraftKind,
      path: existing ? existing.path : kind === "named" ? (request.path ?? null) : null,
      title: sanitizeDraftTitle(request.title),
      text: request.text,
      textUnits: request.text.length,
      sizeBytes: bytes,
      anchor: clampInt(request.anchor, 0, 0xffff_ffff),
      head: clampInt(request.head, 0, 0xffff_ffff),
      createdAtMs,
      updatedAtMs: this.tick(),
      appVersion: "fake",
    };
    this.drafts.set(id, record);
    this.pruneDrafts();
    return toDraftMeta(record);
  }

  async sessionDraftList(): Promise<DraftMeta[]> {
    await this.wait(COMMANDS.sessionDraftList);
    this.maybeThrow(COMMANDS.sessionDraftList);
    this.pruneDrafts();
    return [...this.drafts.values()]
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .map(toDraftMeta);
  }

  async sessionDraftRead(id: string): Promise<DraftRecord> {
    await this.wait(COMMANDS.sessionDraftRead);
    this.maybeThrow(COMMANDS.sessionDraftRead);
    const record = this.drafts.get(id);
    if (!record) {
      throw new AppError("NOT_FOUND", `draft not found: ${id}`);
    }
    return { ...record };
  }

  async sessionDraftDiscard(id: string): Promise<boolean> {
    await this.wait(COMMANDS.sessionDraftDiscard);
    this.maybeThrow(COMMANDS.sessionDraftDiscard);
    return this.drafts.delete(id);
  }

  private pruneDrafts(): void {
    const oldestFirst = [...this.drafts.values()].sort(
      (left, right) => left.updatedAtMs - right.updatedAtMs,
    );
    let total = oldestFirst.reduce((sum, record) => sum + record.sizeBytes, 0);
    for (const record of oldestFirst) {
      if (this.drafts.size <= FAKE_MAX_DRAFT_COUNT && total <= FAKE_MAX_DRAFT_TOTAL_BYTES) {
        break;
      }
      this.drafts.delete(record.id);
      total -= record.sizeBytes;
    }
  }

  private tick(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }
}

function sanitizeDraftTitle(title: string): string {
  return Array.from(title)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      // Mirrors Rust `char::is_control`: C0, DEL and C1 controls only.
      return !(code < 0x20 || (code >= 0x7f && code <= 0x9f));
    })
    .slice(0, FAKE_MAX_DRAFT_TITLE)
    .join("");
}

function clampInt(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function toDraftMeta(record: DraftRecord): DraftMeta {
  return {
    id: record.id,
    kind: record.kind,
    path: record.path,
    title: record.title,
    textUnits: record.textUnits,
    sizeBytes: record.sizeBytes,
    anchor: record.anchor,
    head: record.head,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    appVersion: record.appVersion,
  };
}

function newUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;
}
