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
  HistoryEntry,
  HistoryRecord,
  ImageSaveResult,
  JsonValue,
  ReadOnlyReason,
  SaveRequest,
  SaveResult,
  SearchResponse,
  TextFormat,
  TrashEntry,
  TrashRestoreMode,
  TrashRestoreResult,
  WorkspaceEntry,
  WorkspaceInfo,
  WorkspaceListing,
} from "@qingmo/shared";

import { COMMANDS, type CommandName } from "./commands";
import { AppError } from "./errors";
import type {
  CloseConfirmRequest,
  DocumentNewPlacement,
  IpcPort,
  LivePreviewRequest,
} from "./port";

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
  /** Seeds an already-open workspace for this window. */
  workspace?: FakeWorkspaceSeed | null;
  /** `null` simulates a cancelled folder dialog. */
  workspaceFolder?: string | null;
  delayMs?: number;
}

export interface FakeWorkspaceSeed {
  root: string;
  name?: string;
  /** Files are added before the workspace is exposed. */
  files?: Array<FakeFile | string>;
}

export interface FakeWorkspaceCall {
  command: CommandName;
  args: Record<string, unknown>;
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
  private readonly workspaceChangedListeners = new Set<() => void>();
  private readonly closeCancelledListeners = new Set<
    (payload: { reason: string; generation: number }) => void
  >();
  private readonly indexStatusListeners = new Set<
    (payload: import("@qingmo/shared").WorkspaceIndexStatusPayload) => void
  >();
  private readonly history = new Map<string, HistoryEntry[]>();
  private readonly historyBodies = new Map<string, HistoryRecord>();
  private readonly trash = new Map<string, TrashEntry>();
  private historyClock = 1;
  private readonly viewStates = new Map<string, EditorViewState>();
  private readonly drafts = new Map<string, DraftRecord>();
  private active: { token: string; path: string } | null = null;
  /** Every token this fake issued, so a failed adoption can reactivate. */
  private readonly issuedTokens = new Map<string, string>();
  private pending: FilePayload | null = null;
  private openFile: string | null;
  private saveAsFile: string | null;
  private workspace: WorkspaceInfo | null = null;
  private workspaceFolder: string | null;
  private nextWorkspaceToken = 1;
  private nextToken = 1;
  private clock = 0;
  private defaultDelayMs: number;

  readonly closeConfirmCalls: CloseConfirmRequest[] = [];
  readonly livePreviewCalls: boolean[] = [];
  readonly viewStateWrites: Array<{ path: string; state: EditorViewState }> = [];
  readonly draftWrites: DraftWriteRequest[] = [];
  readonly localeCalls: ApplyLocaleRequest[] = [];
  readonly openedLinks: string[] = [];
  readonly commandCalls: FakeWorkspaceCall[] = [];

  constructor(options: FakeIpcOptions = {}) {
    for (const file of options.files ?? []) {
      this.addFile(file);
    }
    if (options.workspace) {
      this.seedWorkspace(options.workspace.root, options.workspace);
    }
    this.openFile =
      options.openFile !== undefined
        ? options.openFile
        : (this.records.keys().next().value ?? null);
    this.saveAsFile = options.saveAsFile !== undefined ? options.saveAsFile : "/docs/untitled.md";
    this.workspaceFolder =
      options.workspaceFolder !== undefined
        ? options.workspaceFolder
        : (this.workspace?.root ?? null);
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

  /** Simulates a debounced Rust workspace watcher batch. */
  emitWorkspaceChanged(): void {
    for (const listener of [...this.workspaceChangedListeners]) {
      listener();
    }
  }

  onWorkspaceChanged(callback: () => void): () => void {
    this.workspaceChangedListeners.add(callback);
    return () => {
      this.workspaceChangedListeners.delete(callback);
    };
  }

  onCloseCancelled(
    callback: (payload: { reason: string; generation: number }) => void,
  ): () => void {
    this.closeCancelledListeners.add(callback);
    return () => {
      this.closeCancelledListeners.delete(callback);
    };
  }

  onWorkspaceIndexStatus(
    callback: (payload: import("@qingmo/shared").WorkspaceIndexStatusPayload) => void,
  ): () => void {
    this.indexStatusListeners.add(callback);
    return () => {
      this.indexStatusListeners.delete(callback);
    };
  }

  emitCloseCancelled(reason: string, generation: number): void {
    for (const listener of [...this.closeCancelledListeners]) {
      listener({ reason, generation });
    }
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

  /**
   * Seeds an open workspace for browser tests. The returned token is replaced
   * on every later `workspaceOpen`, mirroring the native switch semantics.
   */
  seedWorkspace(
    root: string,
    options: { name?: string | undefined; files?: Array<FakeFile | string> | undefined } = {},
  ): WorkspaceInfo {
    const normalized = normalizeWorkspaceRoot(root);
    for (const file of options.files ?? []) {
      const seed = typeof file === "string" ? { path: file } : file;
      if (!this.records.has(seed.path)) {
        this.addFile(seed);
      }
    }
    const token = `fake-workspace-${this.nextWorkspaceToken}`;
    this.nextWorkspaceToken += 1;
    this.workspace = {
      token,
      root: normalized,
      name: options.name ?? workspaceName(normalized),
    };
    return { ...this.workspace };
  }

  resetWorkspace(): void {
    this.workspace = null;
    this.workspaceFolder = null;
    this.commandCalls.length = 0;
  }

  /** The next `workspaceOpen` returns this folder; `null` cancels the dialog. */
  setWorkspaceFolder(path: string | null): void {
    this.workspaceFolder = path;
  }

  addWorkspaceFile(path: string, text = ""): void {
    const existing = this.records.get(path);
    if (existing) {
      existing.text = text;
      existing.diskHash = fakeHash(text);
      existing.size = byteLength(text);
      existing.mtimeMs = this.tick();
      return;
    }
    this.addFile({ path, text });
  }

  getWorkspaceCalls(): FakeWorkspaceCall[] {
    return this.commandCalls.map((call) => ({ command: call.command, args: { ...call.args } }));
  }

  async workspaceOpen(): Promise<WorkspaceInfo> {
    await this.wait(COMMANDS.workspaceOpen);
    this.maybeThrow(COMMANDS.workspaceOpen);
    this.record(COMMANDS.workspaceOpen, {});
    if (this.workspaceFolder === null) {
      throw new AppError("CANCELLED", "folder dialog was cancelled");
    }
    return this.seedWorkspace(this.workspaceFolder);
  }

  async workspaceCurrent(): Promise<WorkspaceInfo | null> {
    await this.wait(COMMANDS.workspaceCurrent);
    this.maybeThrow(COMMANDS.workspaceCurrent);
    this.record(COMMANDS.workspaceCurrent, {});
    return this.workspace ? { ...this.workspace } : null;
  }

  async workspaceList(workspaceToken: string, dirSegments: string[]): Promise<WorkspaceListing> {
    await this.wait(COMMANDS.workspaceList);
    this.maybeThrow(COMMANDS.workspaceList);
    this.record(COMMANDS.workspaceList, { workspaceToken, dirSegments: [...dirSegments] });
    const workspace = this.requireWorkspace(workspaceToken);
    for (const segment of dirSegments) {
      if (!isValidWorkspaceSegment(segment)) {
        throw new AppError("INVALID_PATH", "invalid workspace directory segment");
      }
    }
    return {
      segments: [...dirSegments],
      entries: this.listWorkspaceEntries(workspace.root, dirSegments),
      truncated: false,
      truncationReason: null,
    };
  }

  async workspaceOpenDocument(workspaceToken: string, segments: string[]): Promise<FilePayload> {
    await this.wait(COMMANDS.workspaceOpenDocument);
    this.maybeThrow(COMMANDS.workspaceOpenDocument);
    this.record(COMMANDS.workspaceOpenDocument, { workspaceToken, segments: [...segments] });
    const workspace = this.requireWorkspace(workspaceToken);
    if (segments.length === 0) {
      throw new AppError("NOT_A_FILE", "a workspace document needs a file segment");
    }
    for (const segment of segments) {
      if (!isValidWorkspaceSegment(segment)) {
        throw new AppError("INVALID_PATH", "invalid workspace document segment");
      }
    }
    const path = workspacePath(workspace.root, segments);
    const record = this.records.get(path);
    if (!record) {
      throw new AppError("NOT_FOUND", `fake file not found: ${path}`);
    }
    if (!isSupportedMarkdown(path)) {
      throw new AppError("UNSUPPORTED_EXTENSION", `unsupported file extension: ${path}`);
    }
    // Browser harnesses adopt in place, exactly like the file dialog path.
    record.baseHash = record.diskHash;
    const token = `fake-doc-${this.nextToken}`;
    this.nextToken += 1;
    this.issuedTokens.set(token, path);
    this.active = { token, path };
    return this.toPayload(record, token);
  }

  async workspaceLocateDocument(
    workspaceToken: string,
    docToken: string,
  ): Promise<string[] | null> {
    await this.wait(COMMANDS.workspaceLocateDocument);
    this.maybeThrow(COMMANDS.workspaceLocateDocument);
    this.record(COMMANDS.workspaceLocateDocument, { workspaceToken, docToken });
    const workspace = this.requireWorkspace(workspaceToken);
    if (docToken === "untitled" || !this.active || this.active.token !== docToken) {
      return null;
    }
    const relative = relativeWorkspaceComponents(this.active.path, workspace.root);
    if (!relative || relative.length === 0) {
      return null;
    }
    return relative.every(isValidWorkspaceSegment) ? relative : null;
  }

  async workspaceDelete(workspaceToken: string, segments: string[]): Promise<TrashEntry> {
    await this.wait(COMMANDS.workspaceDelete);
    this.maybeThrow(COMMANDS.workspaceDelete);
    this.record(COMMANDS.workspaceDelete, { workspaceToken, segments });
    const workspace = this.requireWorkspace(workspaceToken);
    const path = [workspace.root, ...segments].join("/");
    const record = this.records.get(path);
    if (!record) throw new AppError("NOT_FOUND", "file not found");
    this.records.delete(path);
    const entry: TrashEntry = {
      id: crypto.randomUUID(),
      relativePath: segments.join("/"),
      deletedAtMs: this.tick(),
      sizeBytes: record.size,
      state: "active",
    };
    this.trash.set(entry.id, entry);
    return entry;
  }

  async workspaceTrashList(workspaceToken: string): Promise<TrashEntry[]> {
    await this.wait(COMMANDS.workspaceTrashList);
    this.maybeThrow(COMMANDS.workspaceTrashList);
    this.record(COMMANDS.workspaceTrashList, { workspaceToken });
    this.requireWorkspace(workspaceToken);
    return [...this.trash.values()];
  }

  async workspaceTrashRestore(
    workspaceToken: string,
    entryId: string,
    mode: TrashRestoreMode,
  ): Promise<TrashRestoreResult> {
    await this.wait(COMMANDS.workspaceTrashRestore);
    this.maybeThrow(COMMANDS.workspaceTrashRestore);
    this.record(COMMANDS.workspaceTrashRestore, { workspaceToken, entryId, mode });
    const workspace = this.requireWorkspace(workspaceToken);
    const entry = this.trash.get(entryId);
    if (!entry) throw new AppError("NOT_FOUND", "trash entry not found");
    const target = [workspace.root, entry.relativePath].join("/");
    this.records.set(target, {
      path: target,
      text: "",
      format: { encoding: "utf8", hasBom: false, eol: "lf" },
      readOnlyReason: null,
      baseHash: fakeHash(""),
      diskHash: fakeHash(""),
      size: 0,
      mtimeMs: this.tick(),
    });
    this.trash.delete(entryId);
    return { relativePath: entry.relativePath, mode };
  }

  async workspaceTrashPurge(workspaceToken: string, entryId: string): Promise<void> {
    await this.wait(COMMANDS.workspaceTrashPurge);
    this.maybeThrow(COMMANDS.workspaceTrashPurge);
    this.record(COMMANDS.workspaceTrashPurge, { workspaceToken, entryId });
    this.requireWorkspace(workspaceToken);
    this.trash.delete(entryId);
  }

  async workspaceSearch(
    workspaceToken: string,
    query: string,
    limit = 30,
    offset = 0,
  ): Promise<SearchResponse> {
    await this.wait(COMMANDS.workspaceSearch);
    this.maybeThrow(COMMANDS.workspaceSearch);
    this.record(COMMANDS.workspaceSearch, { workspaceToken, query, limit, offset });
    const workspace = this.requireWorkspace(workspaceToken);
    const needle = query.trim().toLowerCase();
    const results = [...this.records.values()]
      .filter((record) => record.path.startsWith(`${workspace.root}/`))
      .filter((record) => !needle || record.text.toLowerCase().includes(needle))
      .map((record) => ({
        path: record.path.slice(workspace.root.length + 1),
        title: record.path.split("/").pop() ?? record.path,
        snippet: record.text.slice(0, 160),
        score: 0,
        mtimeMs: record.mtimeMs,
      }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    return {
      results: results.slice(offset, offset + limit),
      hasMore: results.length > offset + limit,
      indexing: false,
      truncated: false,
      tookMs: 0,
      mode: "trigram",
    };
  }

  async workspaceSearchRebuild(workspaceToken: string): Promise<void> {
    await this.wait(COMMANDS.workspaceSearchRebuild);
    this.maybeThrow(COMMANDS.workspaceSearchRebuild);
    this.record(COMMANDS.workspaceSearchRebuild, { workspaceToken });
    this.requireWorkspace(workspaceToken);
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
    // version and switches the active token. A caller that aborts still knows
    // its previous token and can `documentActivate` it back.
    record.baseHash = record.diskHash;
    const token = `fake-doc-${this.nextToken}`;
    this.nextToken += 1;
    this.issuedTokens.set(token, path);
    this.active = { token, path };
    return this.toPayload(record, token);
  }

  async documentActivate(docToken: string): Promise<void> {
    // Untitled sessions use a constant token and have no writable path.
    if (docToken === "untitled") {
      this.active = null;
      return;
    }
    const path = this.issuedTokens.get(docToken);
    if (!path) {
      throw new AppError("INVALID_PATH", `unknown docToken: ${docToken}`);
    }
    this.active = { token: docToken, path };
  }

  /** Seeds a payload for a simulated document window boot. */
  stagePending(payload: FilePayload): void {
    this.pending = payload;
  }

  /**
   * Browser harness fallback: reset the only window to a fresh untitled
   * document. The caller flushes the current session before replacing it, so
   * the active token must survive until that flush completes. The new
   * untitled session never writes through it, and the next Open/Save As
   * replaces it.
   */
  async documentNew(): Promise<DocumentNewPlacement> {
    await this.wait(COMMANDS.documentNew);
    this.maybeThrow(COMMANDS.documentNew);
    this.pending = null;
    return "current";
  }

  /** Seeds the file currently registered under `path` for a document window. */
  stagePendingPath(path: string): void {
    const record = this.records.get(path);
    if (!record) {
      throw new AppError("NOT_FOUND", `fake file not found: ${path}`);
    }
    const token = `fake-doc-${this.nextToken}`;
    this.nextToken += 1;
    this.issuedTokens.set(token, path);
    this.stagePending(this.toPayload(record, token));
  }

  async documentTakePending(): Promise<FilePayload | null> {
    const payload = this.pending;
    this.pending = null;
    if (!payload) {
      return null;
    }
    this.issuedTokens.set(payload.docToken, payload.path);
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
    this.issuedTokens.set(token, target);
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

  async documentSaveImage(request: {
    docToken: string;
    fileName: string;
    mime: string;
    dataBase64: string;
  }): Promise<ImageSaveResult> {
    await this.wait(COMMANDS.documentSaveImage);
    this.maybeThrow(COMMANDS.documentSaveImage);
    this.record(COMMANDS.documentSaveImage, request);
    this.requireActive(request.docToken, COMMANDS.documentSaveImage);
    const stem = request.fileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-");
    const extension = request.mime === "image/jpeg" ? "jpg" : (request.mime.split("/")[1] ?? "png");
    const relativePath = `assets/${stem}.${extension}`;
    const size = Math.floor((request.dataBase64.length * 3) / 4);
    return {
      relativePath,
      markdown: `![${stem}](${relativePath})`,
      sizeBytes: size,
      mime: request.mime,
    };
  }

  async documentHistoryList(docToken: string, limit = 50, offset = 0): Promise<HistoryEntry[]> {
    await this.wait(COMMANDS.documentHistoryList);
    this.maybeThrow(COMMANDS.documentHistoryList);
    this.record(COMMANDS.documentHistoryList, { docToken, limit, offset });
    return (this.history.get(docToken) ?? []).slice(offset, offset + limit);
  }

  async documentHistoryRead(docToken: string, entryId: string): Promise<HistoryRecord> {
    await this.wait(COMMANDS.documentHistoryRead);
    this.maybeThrow(COMMANDS.documentHistoryRead);
    this.record(COMMANDS.documentHistoryRead, { docToken, entryId });
    const record = this.historyBodies.get(entryId);
    if (!record) throw new AppError("NOT_FOUND", "history entry not found");
    return record;
  }

  async documentHistoryRestore(docToken: string, entryId: string): Promise<FilePayload> {
    await this.wait(COMMANDS.documentHistoryRestore);
    this.maybeThrow(COMMANDS.documentHistoryRestore);
    this.record(COMMANDS.documentHistoryRestore, { docToken, entryId });
    const snapshot = this.historyBodies.get(entryId);
    const record = this.requireActive(docToken, COMMANDS.documentHistoryRestore);
    if (!snapshot) throw new AppError("NOT_FOUND", "history entry not found");
    record.text = snapshot.text;
    record.diskHash = fakeHash(snapshot.text);
    record.baseHash = record.diskHash;
    record.size = byteLength(snapshot.text);
    record.mtimeMs = this.tick();
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

    const previousText = record.text;
    if (previousText !== request.text) {
      const entryId = `${this.historyClock++}-${newHash.slice(0, 8)}`;
      const entry: HistoryEntry = {
        id: entryId,
        hash: record.diskHash,
        sizeBytes: record.size,
        createdAtMs: this.tick(),
        appVersion: "0.1.4",
      };
      this.history.set(request.docToken, [entry, ...(this.history.get(request.docToken) ?? [])]);
      this.historyBodies.set(entryId, {
        id: entryId,
        text: previousText,
        format: copyFormat(record.format),
        hash: record.diskHash,
        createdAtMs: entry.createdAtMs,
      });
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
    this.closeConfirmCalls.push({ allow: request.allow, generation: request.generation });
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

  async appOpenExternal(href: string): Promise<void> {
    await this.wait(COMMANDS.appOpenExternal);
    this.maybeThrow(COMMANDS.appOpenExternal);
    this.openedLinks.push(href);
  }

  private requireWorkspace(workspaceToken: string): WorkspaceInfo {
    if (!this.workspace || this.workspace.token !== workspaceToken) {
      throw new AppError("INVALID_PATH", "unknown or expired workspaceToken");
    }
    return this.workspace;
  }

  private record(command: CommandName, args: Record<string, unknown>): void {
    this.commandCalls.push({ command, args });
  }

  private listWorkspaceEntries(root: string, dirSegments: string[]): WorkspaceEntry[] {
    const directories = new Set<string>();
    const files: WorkspaceEntry[] = [];

    for (const record of this.records.values()) {
      const relative = relativeWorkspaceComponents(record.path, root);
      if (!relative || relative.length <= dirSegments.length) {
        continue;
      }
      if (!dirSegments.every((segment, index) => relative[index] === segment)) {
        continue;
      }
      const name = relative[dirSegments.length];
      if (!name) {
        continue;
      }
      if (name.startsWith(".") || name === "node_modules") {
        continue;
      }
      if (relative.length > dirSegments.length + 1) {
        directories.add(name);
      } else if (isSupportedMarkdown(name)) {
        files.push({
          name,
          kind: "file",
          expandable: false,
          openable: true,
        });
      }
    }

    const directoryEntries: WorkspaceEntry[] = [...directories]
      .sort(compareWorkspaceNames)
      .map((name) => ({
        name,
        kind: "directory",
        expandable: true,
        openable: false,
      }));
    files.sort((left, right) => compareWorkspaceNames(left.name, right.name));
    return [...directoryEntries, ...files];
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
    this.draftWrites.push(request);
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

function normalizeWorkspaceRoot(root: string): string {
  const normalized = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

function workspaceName(root: string): string {
  const name = root.split("/").filter(Boolean).pop();
  return name ?? root;
}

function workspacePath(root: string, segments: string[]): string {
  const normalized = normalizeWorkspaceRoot(root);
  const suffix = segments.join("/");
  return normalized === "/" ? `/${suffix}` : `${normalized}/${suffix}`;
}

function relativeWorkspaceComponents(path: string, root: string): string[] | null {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRoot = normalizeWorkspaceRoot(root);
  if (normalizedPath === normalizedRoot) {
    return [];
  }
  const prefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(prefix)) {
    return null;
  }
  return normalizedPath.slice(prefix.length).split("/").filter(Boolean);
}

function isValidWorkspaceSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === ".." || segment.length > 255) {
    return false;
  }
  if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
    return false;
  }
  return !Array.from(segment).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

function isSupportedMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function compareWorkspaceNames(left: string, right: string): number {
  const folded = left.toLowerCase().localeCompare(right.toLowerCase());
  return folded === 0 ? left.localeCompare(right) : folded;
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
