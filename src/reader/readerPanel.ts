import * as vscode from 'vscode';
import { loadFolderBook } from './folderBook';
import type { BookEncoding, ParsedBook } from './txtParser';
import {
  BookStore,
  readReaderSettings,
  writeReaderSettings,
  type BookRecord,
  type ReaderSettings,
} from './readerState';

const CHUNK_CHARS = 12_000;
const LINE_EXTENSION = 1_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validOffset(value: unknown, length: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= length
    ? value
    : undefined;
}

function validSettings(value: unknown): ReaderSettings | undefined {
  if (!isObject(value)) return undefined;
  const { fontSize, lineHeight, width } = value;
  if (
    typeof fontSize !== 'number' ||
    !Number.isFinite(fontSize) ||
    typeof lineHeight !== 'number' ||
    !Number.isFinite(lineHeight) ||
    typeof width !== 'number' ||
    !Number.isFinite(width)
  ) {
    return undefined;
  }
  return { fontSize, lineHeight, width };
}

function safeStart(text: string, offset: number): number {
  if (
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  ) {
    return offset - 1;
  }
  return offset;
}

function safeEnd(text: string, offset: number): number {
  if (
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  ) {
    return offset + 1;
  }
  return offset;
}

class ReaderPanel {
  readonly panel: vscode.WebviewPanel;
  private book: ParsedBook;
  private record: BookRecord;
  private disposed = false;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private progressSaveScheduled = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: BookStore,
    record: BookRecord,
    book: ParsedBook,
    onDispose: () => void,
  ) {
    this.record = record;
    this.book = book;
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'reader');
    this.panel = vscode.window.createWebviewPanel(
      'aiGitCommit.reader',
      `小说阅读：${record.title}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [mediaRoot] },
    );
    this.panel.webview.html = this.html(mediaRoot);
    this.panel.onDidDispose(() => {
      this.flushProgress();
      this.disposed = true;
      onDispose();
    });
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : '操作失败。';
        void this.panel.webview.postMessage({ type: 'error', message: detail });
      });
    });
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    if (!this.disposed) this.panel.dispose();
  }

  private html(mediaRoot: vscode.Uri): string {
    const webview = this.panel.webview;
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'reader.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'reader.js'));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; connect-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <title>小说阅读器</title>
  <link rel="stylesheet" href="${css}">
  <script defer src="${js}"></script>
</head>
<body>
  <div id="readerShell">
    <header id="readerToolbar">
      <button id="tocToggle" type="button" aria-label="显示或隐藏目录">目录</button>
      <strong id="title"></strong>
      <button id="prevChapter" type="button" aria-label="上一章">上一章</button>
      <button id="nextChapter" type="button" aria-label="下一章">下一章</button>
      <span id="progress" aria-live="polite"></span>
      <div id="readerControls">
        <label>字号 <input id="fontSize" type="number" min="12" max="36" step="1" aria-label="字号"></label>
        <label>行距 <input id="lineHeight" type="number" min="1.2" max="2.5" step="0.1" aria-label="行距"></label>
        <label>宽度 <input id="width" type="number" min="480" max="1200" step="20" aria-label="正文宽度"></label>
        <label>编码 <select id="encoding" aria-label="文件编码"><option value="auto">自动</option><option value="utf8">UTF-8</option><option value="gb18030">GB18030</option></select></label>
      </div>
    </header>
    <div id="readerMain">
      <nav id="toc" aria-label="章节目录"></nav>
      <main id="content" tabindex="0" aria-label="小说正文"></main>
    </div>
    <div id="error" role="alert" hidden></div>
  </div>
</body>
</html>`;
  }

  private sendInit(): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({
      type: 'init',
      title: this.record.title,
      chapters: this.book.chapters,
      totalLength: this.book.text.length,
      position: Math.min(this.record.progress, this.book.text.length),
      settings: readReaderSettings(this.context.globalState),
      encoding: this.record.encodingMode ?? 'auto',
    });
    this.sendContent(this.record.progress, 'initial');
  }

  private sendContent(offset: number, direction: 'initial' | 'next' | 'prev'): void {
    if (this.disposed) return;
    const text = this.book.text;
    const length = text.length;
    if (length === 0) {
      void this.panel.webview.postMessage({
        type: 'content',
        start: 0,
        end: 0,
        text: '',
        reset: true,
      });
      return;
    }
    let start: number;
    let end: number;
    if (direction === 'initial') {
      const target = Math.min(Math.max(offset, 0), length);
      const before = Math.max(0, target - LINE_EXTENSION);
      start = before === 0 ? 0 : text.lastIndexOf('\n', before - 1) + 1;
      if (target - start > CHUNK_CHARS) start = Math.max(0, target - LINE_EXTENSION);
      start = safeStart(text, start);
      end = this.endOfChunk(start);
      if (end < target) end = safeEnd(text, Math.min(length, target + LINE_EXTENSION));
    } else if (direction === 'next') {
      start = safeStart(text, Math.min(Math.max(offset, 0), length));
      if (start === length) return;
      end = this.endOfChunk(start);
    } else {
      end = Math.min(Math.max(offset, 0), length);
      if (end === 0) return;
      const boundary = Math.max(0, end - CHUNK_CHARS);
      start = boundary === 0 ? 0 : text.lastIndexOf('\n', boundary - 1) + 1;
      if (end - start > CHUNK_CHARS + LINE_EXTENSION) start = boundary;
      start = safeStart(text, start);
    }
    if (end <= start) return;
    void this.panel.webview.postMessage({
      type: 'content',
      start,
      end,
      text: text.slice(start, end),
      reset: direction === 'initial',
    });
  }

  private endOfChunk(start: number): number {
    const text = this.book.text;
    const target = Math.min(text.length, start + CHUNK_CHARS);
    if (target === text.length) return target;
    const newline = text.indexOf('\n', target);
    return newline >= 0 && newline - target <= LINE_EXTENSION ? newline + 1 : safeEnd(text, target);
  }

  private scheduleProgressSave(): void {
    if (!this.progressSaveScheduled) {
      this.progressSaveScheduled = true;
      this.persistProgress();
    }
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => this.flushProgress(), 250);
  }

  private flushProgress(): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    if (!this.progressSaveScheduled) return;
    this.progressSaveScheduled = false;
    this.persistProgress();
  }

  private persistProgress(): void {
    void this.store.save(this.record).catch(() => {
      if (!this.disposed) {
        void this.panel.webview.postMessage({ type: 'error', message: '阅读进度保存失败。' });
      }
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (this.disposed || !isObject(message) || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
        {
          const restored = validOffset(message.position, this.book.text.length);
          if (restored !== undefined) {
            this.record.progress = restored;
            await this.store.save(this.record);
          }
        }
        this.sendInit();
        return;
      case 'load': {
        const offset = validOffset(message.offset, this.book.text.length);
        if (offset === undefined || (message.direction !== 'next' && message.direction !== 'prev'))
          return;
        this.sendContent(offset, message.direction);
        return;
      }
      case 'navigate': {
        const offset = validOffset(message.offset, this.book.text.length);
        if (offset !== undefined) {
          this.record.progress = offset;
          this.flushProgress();
          await this.store.save(this.record);
          this.sendContent(offset, 'initial');
        }
        return;
      }
      case 'position': {
        const offset = validOffset(message.offset, this.book.text.length);
        if (offset !== undefined && offset !== this.record.progress) {
          this.record.progress = offset;
          this.scheduleProgressSave();
        }
        return;
      }
      case 'settings': {
        const settings = validSettings(message.settings);
        if (settings) await writeReaderSettings(this.context.globalState, settings);
        return;
      }
      case 'encoding': {
        const encoding = message.encoding;
        if (encoding !== 'auto' && encoding !== 'utf8' && encoding !== 'gb18030') return;
        if (encoding === (this.record.encodingMode ?? 'auto')) return;
        await this.changeEncoding(encoding);
        return;
      }
      default:
        return;
    }
  }

  private async changeEncoding(encoding: BookEncoding | 'auto'): Promise<void> {
    const parsed = await loadFolderBook(
      vscode.Uri.parse(this.record.uri),
      encoding === 'auto' ? undefined : encoding,
    );
    this.book = parsed;
    this.record = {
      ...this.record,
      encoding: parsed.encoding,
      encodingMode: encoding,
      version: parsed.version,
      progress: Math.min(this.record.progress, parsed.text.length),
    };
    await this.store.save(this.record);
    this.sendInit();
  }
}

export class ReaderPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, ReaderPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: BookStore,
  ) {}

  reveal(uri: string): boolean {
    const existing = this.panels.get(uri);
    if (!existing) return false;
    existing.reveal();
    return true;
  }

  open(record: BookRecord, book: ParsedBook): void {
    if (this.reveal(record.uri)) return;
    const panel = new ReaderPanel(this.context, this.store, record, book, () => {
      this.panels.delete(record.uri);
    });
    this.panels.set(record.uri, panel);
  }

  close(uri: string): void {
    this.panels.get(uri)?.dispose();
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
