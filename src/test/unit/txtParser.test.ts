import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Uri } from 'vscode';
import { detectChapters, loadTxtBook, MAX_BOOK_BYTES } from '../../reader/txtParser';

function uri(path: string, scheme = 'file'): Uri {
  return { scheme, fsPath: path } as Uri;
}

test('UTF-8 BOM、换行归一化和中英文目录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'novel-parser-'));
  try {
    const file = join(root, '书籍.txt');
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('前言\r\n第1章 开始\r\n内容\rChapter 2: Next\nThe end.'),
      ]),
    );
    const parsed = await loadTxtBook(uri(file));
    assert.equal(parsed.encoding, 'utf8');
    assert.equal(parsed.text, '前言\n第1章 开始\n内容\nChapter 2: Next\nThe end.');
    assert.deepEqual(
      parsed.chapters.map((chapter) => chapter.title),
      ['前言', '第1章 开始', 'Chapter 2: Next'],
    );
    assert.equal(
      parsed.text.slice(parsed.chapters[1].start, parsed.chapters[1].end),
      '第1章 开始\n内容\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GB18030 自动回退与手动编码切换', async () => {
  const root = mkdtempSync(join(tmpdir(), 'novel-encoding-'));
  try {
    const file = join(root, 'book.TXT');
    writeFileSync(
      file,
      Buffer.concat([Buffer.from('Chapter 1 ', 'ascii'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])]),
    );
    const parsed = await loadTxtBook(uri(file));
    assert.equal(parsed.encoding, 'gb18030');
    assert.equal(parsed.text, 'Chapter 1 中文');
    assert.equal((await loadTxtBook(uri(file), 'gb18030')).encoding, 'gb18030');
    await assert.rejects(loadTxtBook(uri(file), 'utf8'), /UTF-8 解码失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无章节时可阅读全文，文件版本随内容变化', async () => {
  const root = mkdtempSync(join(tmpdir(), 'novel-version-'));
  try {
    const file = join(root, 'plain.txt');
    writeFileSync(file, '只有正文');
    const first = await loadTxtBook(uri(file));
    assert.deepEqual(first.chapters, [{ title: '全文', start: 0, end: first.text.length }]);
    writeFileSync(file, '只有文本');
    const second = await loadTxtBook(uri(file));
    assert.notEqual(first.version, second.version);
    assert.deepEqual(detectChapters(''), [{ title: '全文', start: 0, end: 0 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拒绝远程 URI、非 TXT 和超大文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'novel-limits-'));
  try {
    const file = join(root, 'large.txt');
    writeFileSync(file, '');
    truncateSync(file, MAX_BOOK_BYTES + 1);
    await assert.rejects(loadTxtBook(uri(file)), /超过 32 MiB/);
    await assert.rejects(loadTxtBook(uri(file, 'vscode-remote')), /仅支持本地/);
    await assert.rejects(loadTxtBook(uri(join(root, 'other.md'))), /仅支持本地/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
