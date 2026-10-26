import type {
  AppErrorCode,
  FilePayload,
  JsonValue,
  ReadOnlyReason,
  SaveRequest,
  SaveResult,
  TextFormat,
} from "@qingmo/shared";

import { COMMANDS, type CommandName } from "./commands";
import { AppError } from "./errors";
import type { CloseConfirmRequest, IpcPort } from "./port";

export const FAKE_MAX_FILE_BYTES = 10 * 1024 * 1024;

const textEncoder = new TextEncoder();

export interface FakeFile {
  path: string;
  text?: string;
  format?: Partial<TextFormat>;
  readOnlyReason?: ReadOnlyReason | null;
}

export interface FakeIpcOptions {
  files?: FakeFile[];
  /** `null` simulates a cancelled native dialog. */
  openFile?: string | null;
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
  private active: { token: string; path: string } | null = null;
  private openFile: string | null;
  private nextToken = 1;
  private clock = 0;
  private defaultDelayMs: number;

  readonly closeConfirmCalls: CloseConfirmRequest[] = [];

  constructor(options: FakeIpcOptions = {}) {
    for (const file of options.files ?? []) {
      this.addFile(file);
    }
    this.openFile =
      options.openFile !== undefined
        ? options.openFile
        : (this.records.keys().next().value ?? null);
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

    // Opening establishes a new base version and invalidates the old token,
    // matching the single-document Rust registry.
    record.baseHash = record.diskHash;
    const token = `fake-doc-${this.nextToken}`;
    this.nextToken += 1;
    this.active = { token, path };
    return this.toPayload(record, token);
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

  private tick(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }
}
