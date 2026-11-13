import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Uri } from 'vscode';
import { loadTxtBook, MAX_BOOK_BYTES, type BookEncoding, type ParsedBook } from './txtParser';

const MAX_FOLDER_FILES = 2_000;
const nameOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export interface FolderFile {
  path: string;
  name: string;
  start: number;
  end: number;
}

export interface FolderBook extends ParsedBook {
  files: FolderFile[];
}

/** Each direct-child TXT file is one chapter of the selected local book folder. */
export async function loadFolderBook(
  uri: Uri,
  preferredEncoding?: BookEncoding,
): Promise<FolderBook> {
  if (uri.scheme !== 'file') throw new Error('仅支持本地小说目录。');
  const directory = await stat(uri.fsPath);
  if (!directory.isDirectory()) throw new Error('请选择包含 TXT 章节文件的目录。');

  const entries = (await readdir(uri.fsPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.txt')
    .sort((a, b) => nameOrder.compare(a.name, b.name) || a.name.localeCompare(b.name));
  if (entries.length === 0) throw new Error('所选目录下没有 TXT 章节文件。');
  if (entries.length > MAX_FOLDER_FILES)
    throw new Error(`目录中的 TXT 文件超过 ${MAX_FOLDER_FILES} 个，暂不支持读取。`);

  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += (await stat(join(uri.fsPath, entry.name))).size;
    if (totalBytes > MAX_BOOK_BYTES)
      throw new Error('小说目录中的 TXT 总大小超过 32 MiB，暂不支持读取。');
  }

  const textParts: string[] = [];
  const files: FolderFile[] = [];
  const chapters: FolderBook['chapters'] = [];
  const versionHash = createHash('sha256');
  let position = 0;
  let encoding: BookEncoding | undefined;
  for (const [index, entry] of entries.entries()) {
    const filePath = join(uri.fsPath, entry.name);
    const fileUri = { scheme: 'file', fsPath: filePath } as Uri;
    const parsed = await loadTxtBook(fileUri, preferredEncoding);
    encoding ??= parsed.encoding;
    const title = entry.name.slice(0, -extname(entry.name).length);
    const start = position;
    const end = start + parsed.text.length;
    textParts.push(parsed.text);
    files.push({ path: filePath, name: entry.name, start, end });
    chapters.push({ title, start, end });
    versionHash.update(entry.name).update('\0').update(parsed.version).update('\0');
    position = end;
    if (index < entries.length - 1) {
      textParts.push('\n\n');
      position += 2;
    }
  }

  return {
    text: textParts.join(''),
    files,
    chapters,
    encoding: preferredEncoding ?? encoding ?? 'utf8',
    version: versionHash.digest('hex'),
  };
}
