import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { readReaderSettings, writeReaderSettings } from '../../reader/readerState';

function readerTabs(title: string): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.label === title);
}

async function waitForReaderTabs(title: string, count: number): Promise<vscode.Tab[]> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const tabs = readerTabs(title);
    if (tabs.length === count) return tabs;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const labels = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map(
      (tab) =>
        `${tab.label} (${tab.input instanceof vscode.TabInputWebview ? 'Webview' : typeof tab.input})`,
    );
  assert.fail(`等待 ${count} 个阅读标签超时；当前标签：${labels.join('，') || '无'}`);
}

async function checkReaderSettings(): Promise<void> {
  const values = new Map<string, unknown>();
  const memento = (): vscode.Memento =>
    ({
      get: <T>(key: string, fallback?: T): T => (values.has(key) ? values.get(key) : fallback) as T,
      update: async (key: string, value: unknown): Promise<void> => {
        values.set(key, value);
      },
      keys: (): readonly string[] => [...values.keys()],
    }) as vscode.Memento;

  assert.deepEqual(readReaderSettings(memento()), {
    fontSize: 18,
    lineHeight: 1.8,
    width: 760,
  });
  await writeReaderSettings(memento(), { fontSize: 22, lineHeight: 2.1, width: 880 });
  assert.deepEqual(readReaderSettings(memento()), {
    fontSize: 22,
    lineHeight: 2.1,
    width: 880,
  });
}

export async function runReaderIntegration(): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['open', 'resume', 'import', 'remove', 'relocate']) {
    assert.ok(commands.includes(`aiGitCommit.reader.${name}`), `阅读器命令 ${name} 应已注册`);
  }
  await checkReaderSettings();

  const root = mkdtempSync(join(tmpdir(), 'ai-git-reader-host-'));
  const folder = join(root, '集成测试小说');
  mkdirSync(folder);
  const first = join(folder, '0001_第一章.txt');
  writeFileSync(first, '第1章 初见\n这是第一章。\n');
  writeFileSync(
    join(folder, '0002_第二章.txt'),
    Buffer.concat([Buffer.from('Chapter 2 ', 'ascii'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])]),
  );
  const folderUri = vscode.Uri.file(folder);
  const fileUri = vscode.Uri.file(first);
  const title = `小说阅读：${basename(folder)}`;
  assert.equal(
    vscode.workspace.getWorkspaceFolder(folderUri),
    undefined,
    '书籍目录位于 Git 工作区之外',
  );

  try {
    await vscode.commands.executeCommand('aiGitCommit.reader.import', folderUri);
    const opened = await waitForReaderTabs(title, 1);
    assert.ok(opened[0].input instanceof vscode.TabInputWebview, '目录书籍应在 Webview 标签中打开');

    await vscode.commands.executeCommand('aiGitCommit.reader.open', folderUri);
    assert.equal(readerTabs(title).length, 1, '重复打开目录应复用现有标签');
    await vscode.commands.executeCommand('aiGitCommit.reader.open', fileUri);
    assert.equal(readerTabs(title).length, 1, '打开目录内单个 TXT 应定位到整本书');

    const closed = await vscode.window.tabGroups.close(opened[0]);
    assert.equal(closed, true, '阅读标签应能关闭');
    await waitForReaderTabs(title, 0);
    await vscode.commands.executeCommand('aiGitCommit.reader.resume');
    const resumed = await waitForReaderTabs(title, 1);
    assert.ok(resumed[0].input instanceof vscode.TabInputWebview, '继续阅读应重新打开阅读标签');
  } finally {
    await vscode.commands.executeCommand('aiGitCommit.reader.remove', folderUri);
    rmSync(root, { recursive: true, force: true });
  }
}
