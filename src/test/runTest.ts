import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');
  const fixture = mkdtempSync(path.join(tmpdir(), 'ai-git-commit-host-'));
  try {
    for (const name of ['repo-a', 'repo-b']) {
      const repo = path.join(fixture, name);
      mkdirSync(repo);
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'config', 'core.autocrlf', 'false']);
      writeFileSync(path.join(repo, '集成测试.ts'), `export const staged = '${name}';\n`);
      writeFileSync(
        path.join(repo, 'CODEBUDDY.md'),
        '第一行使用 type(scope): 中文描述，空一行后列出受影响功能。\n',
      );
      execFileSync('git', ['-C', repo, 'add', '集成测试.ts']);
    }
    const workspace = path.join(fixture, 'test.code-workspace');
    writeFileSync(workspace, JSON.stringify({ folders: [{ path: 'repo-a' }, { path: 'repo-b' }] }));
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
      ],
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || undefined,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Extension Host 集成测试失败：${error instanceof Error ? error.message : '未知错误'}\n`,
  );
  process.exitCode = 1;
});
