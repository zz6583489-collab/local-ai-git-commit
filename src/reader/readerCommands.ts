import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadFolderBook, type FolderBook } from './folderBook';
import type { BookEncoding } from './txtParser';
import { ReaderPanelManager } from './readerPanel';
import { BookStore, type BookRecord } from './readerState';

function isUri(value: unknown): value is vscode.Uri {
  return (
    !!value &&
    typeof value === 'object' &&
    'scheme' in value &&
    'fsPath' in value &&
    'toString' in value &&
    typeof value.toString === 'function'
  );
}

function titleFor(uri: vscode.Uri): string {
  return path.basename(uri.fsPath) || '未命名小说';
}

function folderFor(uri: vscode.Uri): vscode.Uri {
  if (uri.scheme !== 'file') return uri;
  const directory =
    path.extname(uri.fsPath).toLowerCase() === '.txt' ? path.dirname(uri.fsPath) : uri.fsPath;
  return vscode.Uri.file(path.resolve(directory));
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function preferredEncoding(record?: BookRecord): BookEncoding | undefined {
  const mode = record?.encodingMode ?? 'auto';
  return mode === 'auto' ? undefined : mode;
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

export class ReaderCommands implements vscode.Disposable {
  private readonly books: BookStore;
  private readonly panels: ReaderPanelManager;
  private readonly quickOpen: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.books = new BookStore(context.globalState);
    this.panels = new ReaderPanelManager(context, this.books);
    this.quickOpen = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
    this.quickOpen.command = 'aiGitCommit.reader.resume';
    context.subscriptions.push(this.quickOpen);
    this.register('open', (arg) => this.open(arg));
    this.register('resume', () => this.resume());
    this.register('import', (arg) => this.importBooks(arg));
    this.register('remove', (arg) => this.remove(arg));
    this.register('relocate', () => this.relocate());
    this.refreshQuickOpen();
  }

  dispose(): void {
    this.panels.dispose();
  }

  private refreshQuickOpen(): void {
    const latest = this.books.list()[0];
    if (!latest) {
      this.quickOpen.hide();
      return;
    }
    this.quickOpen.text = '$(book) 继续阅读';
    this.quickOpen.tooltip = `继续阅读《${latest.title}》`;
    this.quickOpen.show();
  }

  private async resume(): Promise<void> {
    const latest = this.books.list()[0];
    if (latest) await this.openSaved(latest);
    else await this.importBooks();
  }

  private register(name: string, handler: (...args: unknown[]) => Promise<void>): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand(`aiGitCommit.reader.${name}`, (...args: unknown[]) =>
        handler(...args).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : '操作失败。';
          void vscode.window.showErrorMessage(`小说阅读器：${detail}`);
        }),
      ),
    );
  }

  private async open(arg?: unknown): Promise<void> {
    if (isUri(arg)) {
      const uri = folderFor(arg).toString();
      const saved = this.books.get(uri);
      if (saved) await this.openSaved(saved);
      else await this.importUris([folderFor(arg)], true);
      return;
    }
    const items = this.books.list().map((book) => ({
      label: book.title,
      description: vscode.Uri.parse(book.uri).fsPath,
      detail: `上次打开：${new Date(book.lastOpened).toLocaleString('zh-CN')}`,
      book,
    }));
    const importItem = {
      label: '$(add) 导入小说目录',
      description: '',
      detail: '一个目录作为一本书，目录下每个 TXT 是一章',
      book: undefined,
    };
    const selected = await vscode.window.showQuickPick([importItem, ...items], {
      placeHolder: '选择最近阅读的书籍，或导入 TXT',
      matchOnDescription: true,
    });
    if (!selected) return;
    if (selected.book) await this.openSaved(selected.book);
    else await this.importBooks();
  }

  private async importBooks(arg?: unknown): Promise<void> {
    const uris =
      Array.isArray(arg) && arg.every(isUri)
        ? (arg as vscode.Uri[])
        : isUri(arg)
          ? [arg]
          : await vscode.window.showOpenDialog({
              canSelectFiles: false,
              canSelectFolders: true,
              canSelectMany: true,
              openLabel: '导入小说目录',
            });
    if (!uris?.length) return;
    await this.importUris(
      [...new Map(uris.map((uri) => [folderFor(uri).toString(), folderFor(uri)])).values()],
      true,
    );
  }

  private async importUris(uris: vscode.Uri[], openFirst: boolean): Promise<void> {
    let first: { record: BookRecord; parsed: FolderBook } | undefined;
    const failures: string[] = [];
    for (const uri of uris) {
      try {
        const key = uri.toString();
        const existing = this.books.get(key);
        const legacyUris = this.books
          .list()
          .filter((book) => {
            const source = vscode.Uri.parse(book.uri).fsPath;
            return (
              path.extname(source).toLowerCase() === '.txt' &&
              samePath(path.dirname(source), uri.fsPath)
            );
          })
          .map((book) => book.uri);
        const parsed = await loadFolderBook(uri, preferredEncoding(existing));
        if (existing?.version && existing.version !== parsed.version) {
          this.panels.close(key);
          void vscode.window.showInformationMessage(
            `《${existing.title}》的源文件已变化，阅读位置可能有偏移。`,
          );
        }
        const matchedLegacyUris = legacyUris.filter((legacyUri) =>
          parsed.files.some((file) => samePath(file.path, vscode.Uri.parse(legacyUri).fsPath)),
        );
        for (const legacyUri of matchedLegacyUris) this.panels.close(legacyUri);
        const legacy = matchedLegacyUris
          .map((legacyUri) => this.books.get(legacyUri))
          .filter((book): book is BookRecord => book !== undefined)
          .sort((left, right) => right.lastOpened - left.lastOpened)[0];
        const legacyFile = legacy
          ? parsed.files.find((file) => samePath(file.path, vscode.Uri.parse(legacy.uri).fsPath))
          : undefined;
        const migratedProgress =
          legacy && legacyFile
            ? legacyFile.start + Math.min(legacy.progress, legacyFile.end - legacyFile.start)
            : 0;
        const record: BookRecord = {
          uri: key,
          title: existing?.title || titleFor(uri),
          encoding: parsed.encoding,
          encodingMode: existing?.encodingMode ?? 'auto',
          progress: Math.min(existing?.progress ?? migratedProgress, parsed.text.length),
          version: parsed.version,
          lastOpened: Date.now(),
        };
        await this.books.save(record);
        for (const legacyUri of matchedLegacyUris) await this.books.remove(legacyUri);
        if (legacyUris.length > matchedLegacyUris.length) {
          void vscode.window.showWarningMessage(
            matchedLegacyUris.length
              ? '部分旧章节文件不在该目录中；对应的旧书架记录已保留。'
              : '旧章节文件不在该目录中；旧书架记录已保留，阅读位置未迁移。',
          );
        }
        if (!first) first = { record, parsed };
      } catch (error) {
        if (uris.length === 1) throw error;
        const reason = error instanceof Error ? error.message : '导入失败。';
        failures.push(`${path.basename(uri.fsPath)}：${reason}`);
      }
    }
    if (openFirst && first) this.panels.open(first.record, first.parsed);
    this.refreshQuickOpen();
    if (uris.length > 1 && first)
      void vscode.window.showInformationMessage(
        `已导入 ${uris.length - failures.length} 本小说目录。`,
      );
    if (failures.length)
      void vscode.window.showWarningMessage(
        `有 ${failures.length} 本导入失败：${failures.join('；')}`,
      );
  }

  private async openSaved(record: BookRecord): Promise<void> {
    const source = vscode.Uri.parse(record.uri);
    if (path.extname(source.fsPath).toLowerCase() === '.txt') {
      try {
        await this.importUris([folderFor(source)], true);
      } catch (error) {
        if (isMissingFile(error)) {
          await this.handleMissing(record);
          return;
        }
        throw error;
      }
      return;
    }
    if (this.panels.reveal(record.uri)) return;
    let parsed: FolderBook;
    try {
      parsed = await loadFolderBook(source, preferredEncoding(record));
    } catch (error) {
      if (isMissingFile(error)) {
        await this.handleMissing(record);
        return;
      }
      throw error;
    }
    if (record.version && record.version !== parsed.version) {
      void vscode.window.showInformationMessage(
        `《${record.title}》的源文件已变化，阅读位置可能有偏移。`,
      );
    }
    const updated = {
      ...record,
      encoding: parsed.encoding,
      encodingMode: record.encodingMode ?? 'auto',
      version: parsed.version,
      progress: Math.min(record.progress, parsed.text.length),
      lastOpened: Date.now(),
    };
    await this.books.save(updated);
    this.refreshQuickOpen();
    this.panels.open(updated, parsed);
  }

  private async handleMissing(record: BookRecord): Promise<void> {
    const action = await vscode.window.showWarningMessage(
      `找不到《${record.title}》的源文件。`,
      '重新定位',
      '移除记录',
    );
    if (action === '重新定位') await this.relocateRecord(record);
    if (action === '移除记录') {
      await this.books.remove(record.uri);
      this.refreshQuickOpen();
    }
  }

  private async selectBook(placeHolder: string): Promise<BookRecord | undefined> {
    const items = this.books.list().map((book) => ({
      label: book.title,
      description: vscode.Uri.parse(book.uri).fsPath,
      book,
    }));
    return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))
      ?.book;
  }

  private async remove(arg?: unknown): Promise<void> {
    if (isUri(arg)) {
      const key = this.books.get(arg.toString()) ? arg.toString() : folderFor(arg).toString();
      this.panels.close(key);
      await this.books.remove(key);
      this.refreshQuickOpen();
      return;
    }
    const record = await this.selectBook('选择要从书架移除的书籍');
    if (!record) return;
    const action = await vscode.window.showWarningMessage(
      `从书架移除《${record.title}》？源文件不会删除。`,
      '移除',
    );
    if (action !== '移除') return;
    this.panels.close(record.uri);
    await this.books.remove(record.uri);
    this.refreshQuickOpen();
  }

  private async relocate(): Promise<void> {
    const record = await this.selectBook('选择要重新定位的书籍');
    if (record) await this.relocateRecord(record);
  }

  private async relocateRecord(record: BookRecord): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '重新定位小说目录',
    });
    const uri = selected?.[0] ? vscode.Uri.file(path.resolve(selected[0].fsPath)) : undefined;
    if (!uri) return;
    const parsed = await loadFolderBook(uri, preferredEncoding(record));
    const source = vscode.Uri.parse(record.uri).fsPath;
    const legacyFile =
      path.extname(source).toLowerCase() === '.txt'
        ? parsed.files.find(
            (file) => file.name.toLowerCase() === path.basename(source).toLowerCase(),
          )
        : undefined;
    if (path.extname(source).toLowerCase() === '.txt' && !legacyFile) {
      void vscode.window.showWarningMessage(
        '新目录中找不到原章节文件，旧书架记录和阅读位置已保留。',
      );
      return;
    }
    const progress = legacyFile
      ? legacyFile.start + Math.min(record.progress, legacyFile.end - legacyFile.start)
      : record.progress;
    const next: BookRecord = {
      ...record,
      uri: uri.toString(),
      title: titleFor(uri),
      encoding: parsed.encoding,
      encodingMode: record.encodingMode ?? 'auto',
      version: parsed.version,
      progress: Math.min(progress, parsed.text.length),
      lastOpened: Date.now(),
    };
    this.panels.close(record.uri);
    await this.books.relocate(record.uri, next);
    this.refreshQuickOpen();
    this.panels.open(next, parsed);
    if (record.version !== parsed.version && !legacyFile)
      void vscode.window.showInformationMessage('小说目录内容已变化，阅读位置可能有偏移。');
  }
}
