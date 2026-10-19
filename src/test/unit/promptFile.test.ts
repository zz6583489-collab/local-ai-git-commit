import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadFormatPrompt } from '../../services/commit/promptFile';

test('按仓库根目录读取提示词文件，并与附加规则合并', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-git-prompt-'));
  try {
    writeFileSync(join(root, 'CODEBUDDY.md'), '# Git Commit Message 规范\n第一行后空一行列功能。');
    const result = await loadFormatPrompt(root, 'CODEBUDDY.md', '描述使用中文');
    assert.match(result, /第一行后空一行列功能/);
    assert.match(result, /描述使用中文/);
    await assert.rejects(loadFormatPrompt(root, '../other.md', ''), /仓库内/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
