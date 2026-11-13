import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Uri } from 'vscode';
import { loadFolderBook } from '../../reader/folderBook';
import { MAX_BOOK_BYTES } from '../../reader/txtParser';

function fileUri(fsPath: string): Uri {
  return { scheme: 'file', fsPath } as Uri;
}

test('目录中的 TXT 按自然顺序合并为一本书，每个文件成为一章', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-git-reader-folder-'));
  try {
    writeFileSync(join(root, '10_终章.txt'), '终章内容');
    writeFileSync(join(root, '2_中篇.txt'), '中篇\n正文');
    writeFileSync(join(root, '1_开篇.TXT'), '开篇\r\n正文');
    writeFileSync(join(root, '说明.md'), '不应导入');
    mkdirSync(join(root, '其他目录'));
    writeFileSync(join(root, '其他目录', '3_子目录.txt'), '不递归');

    const book = await loadFolderBook(fileUri(root));
    assert.deepEqual(
      book.chapters.map((chapter) => chapter.title),
      ['1_开篇', '2_中篇', '10_终章'],
    );
    assert.equal(book.text, '开篇\n正文\n\n中篇\n正文\n\n终章内容');
    assert.deepEqual(
      book.chapters.map(({ start, end }) => book.text.slice(start, end)),
      ['开篇\n正文', '中篇\n正文', '终章内容'],
    );
    assert.deepEqual(
      book.files.map(({ start, end }) => [start, end]),
      book.chapters.map(({ start, end }) => [start, end]),
    );
    assert.ok(book.files.every((file) => file.path.startsWith(root)));
    assert.equal(book.encoding, 'utf8');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('文件内容变化时目录版本变化', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-git-reader-version-'));
  try {
    const file = join(root, '01.txt');
    writeFileSync(file, '旧内容');
    const before = await loadFolderBook(fileUri(root));
    writeFileSync(file, '新内容');
    const after = await loadFolderBook(fileUri(root));
    assert.notEqual(before.version, after.version);
    assert.equal(after.chapters.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('空目录、非本地 URI、非目录和超大目录给出明确错误', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-git-reader-invalid-folder-'));
  try {
    await assert.rejects(loadFolderBook(fileUri(root)), /没有 TXT/);
    await assert.rejects(loadFolderBook({ scheme: 'https', fsPath: root } as Uri), /本地小说目录/);
    const file = join(root, '第一章.txt');
    writeFileSync(file, 'x');
    await assert.rejects(loadFolderBook(fileUri(file)), /请选择.*目录/);
    truncateSync(file, MAX_BOOK_BYTES + 1);
    await assert.rejects(loadFolderBook(fileUri(root)), /总大小超过 32 MiB/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
