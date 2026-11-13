import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { TextDecoder } from 'node:util';
import type { Uri } from 'vscode';

export type BookEncoding = 'utf8' | 'gb18030';

export interface Chapter {
  title: string;
  start: number;
  end: number;
}

export interface ParsedBook {
  text: string;
  chapters: Chapter[];
  encoding: BookEncoding;
  version: string;
}

export const MAX_BOOK_BYTES = 32 * 1024 * 1024;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const HEADING =
  /^[ \t]{0,12}((?:第[0-9０-９零一二三四五六七八九十百千万两〇○]+[章节回卷篇部集][^\n]{0,45})|(?:chapter[ \t]+[0-9]+[^\n]{0,45}))[ \t]*$/gim;

function decode(
  bytes: Buffer,
  preferredEncoding?: BookEncoding,
): {
  text: string;
  encoding: BookEncoding;
} {
  const hasBom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const content = hasBom ? bytes.subarray(UTF8_BOM.length) : bytes;
  if (preferredEncoding === 'gb18030') {
    try {
      return {
        text: new TextDecoder('gb18030', { fatal: true }).decode(content),
        encoding: 'gb18030',
      };
    } catch {
      throw new Error('GB18030 解码失败，请检查文件编码。');
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(content), encoding: 'utf8' };
  } catch {
    if (preferredEncoding === 'utf8' || hasBom) {
      throw new Error('UTF-8 解码失败，请尝试切换为 GB18030。');
    }
  }
  try {
    return {
      text: new TextDecoder('gb18030', { fatal: true }).decode(content),
      encoding: 'gb18030',
    };
  } catch {
    throw new Error('TXT 解码失败，请检查文件编码。');
  }
}

export function detectChapters(text: string): Chapter[] {
  const starts: Array<{ title: string; start: number }> = [];
  HEADING.lastIndex = 0;
  for (const match of text.matchAll(HEADING)) {
    starts.push({ title: match[1].trim(), start: match.index });
  }
  if (starts.length === 0) return [{ title: '全文', start: 0, end: text.length }];
  if (starts[0].start > 0) starts.unshift({ title: '前言', start: 0 });
  return starts.map(({ title, start }, index) => ({
    title,
    start,
    end: starts[index + 1]?.start ?? text.length,
  }));
}

export async function loadTxtBook(uri: Uri, preferredEncoding?: BookEncoding): Promise<ParsedBook> {
  if (uri.scheme !== 'file' || extname(uri.fsPath).toLowerCase() !== '.txt') {
    throw new Error('仅支持本地 .txt 文件。');
  }
  if (
    preferredEncoding !== undefined &&
    preferredEncoding !== 'utf8' &&
    preferredEncoding !== 'gb18030'
  ) {
    throw new Error('不支持的 TXT 编码。');
  }
  const info = await stat(uri.fsPath);
  if (!info.isFile()) throw new Error('请选择本地 .txt 文件。');
  if (info.size > MAX_BOOK_BYTES) throw new Error('TXT 文件超过 32 MiB，暂不支持读取。');
  const bytes = await readFile(uri.fsPath);
  if (bytes.length > MAX_BOOK_BYTES) throw new Error('TXT 文件超过 32 MiB，暂不支持读取。');
  const decoded = decode(bytes, preferredEncoding);
  const text = decoded.text.replace(/\r\n?/g, '\n');
  return {
    text,
    chapters: detectChapters(text),
    encoding: decoded.encoding,
    version: `${bytes.length}:${info.mtimeMs}:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}
