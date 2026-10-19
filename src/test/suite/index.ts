import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import { CommitCommands } from '../../commands/generateCommit';
import type { ApiKeyManager } from '../../services/ai/apiKeyManager';
import { GitService } from '../../services/git/gitService';
import { getGitApi, selectRepository } from '../../services/git/repositoryManager';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('local-ai-git-commit.ai-git-commit');
  assert.ok(extension, '扩展应可加载');
  await extension.activate();
  const api = await getGitApi();
  let repo = api.repositories[0];
  for (let attempt = 0; api.repositories.length < 2 && attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    repo = api.repositories[0];
  }
  assert.ok(repo && api.repositories.length >= 2, 'Git 扩展应发现多根工作区中的两个仓库');
  const other = api.repositories.find(
    (candidate) => candidate.rootUri.toString() !== repo.rootUri.toString(),
  );
  assert.ok(other);
  const selected = await selectRepository(api, { rootUri: repo.rootUri });
  assert.equal(selected?.rootUri.toString(), repo.rootUri.toString(), 'SCM 上下文应定位到同一仓库');
  const selectedOther = await selectRepository(api, { rootUri: other.rootUri });
  assert.equal(
    selectedOther?.rootUri.toString(),
    other.rootUri.toString(),
    '第二个 SCM 上下文应定位到第二个仓库',
  );
  const diff = await new GitService().stagedDiff(repo.rootUri.fsPath);
  assert.equal(diff.files[0].path, '集成测试.ts');
  assert.equal(diff.files[0].kind, 'added');
  const prior = repo.inputBox.value;
  const otherPrior = other.inputBox.value;
  repo.inputBox.value = 'test(scm): 验证正确仓库输入框';
  assert.equal(repo.inputBox.value, 'test(scm): 验证正确仓库输入框');
  assert.equal(other.inputBox.value, otherPrior, '写入 A 仓库不得影响 B 仓库');
  repo.inputBox.value = prior;
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('aiGitCommit.generate'));
  assert.ok(commands.includes('aiGitCommit.cancel'));

  // 在真实 Extension Host + Git 仓库中，通过 Mock HTTP 验证完整生成链路。
  const configuration = vscode.workspace.getConfiguration('aiGitCommit');
  const priorProvider = configuration.get<string>('provider');
  const priorUrl = configuration.get<string>('baseUrl');
  const priorModel = configuration.get<string>('model');
  const priorOutputFormat = configuration.get<string>('outputFormat');
  const priorPromptFile = configuration.get<string>('promptFile');
  const priorFetch = globalThis.fetch;
  const handler = new CommitCommands(
    { get: async () => 'mock-key' } as unknown as ApiKeyManager,
    () => {},
  );
  try {
    await configuration.update('provider', 'custom', vscode.ConfigurationTarget.Workspace);
    await configuration.update(
      'baseUrl',
      'https://example.test/v1',
      vscode.ConfigurationTarget.Workspace,
    );
    await configuration.update('model', 'mock-model', vscode.ConfigurationTarget.Workspace);
    let requests = 0;
    globalThis.fetch = async (_input, init) => {
      requests++;
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer mock-key');
      return Response.json({ choices: [{ message: { content: 'feat(test): 添加暂存文件测试' } }] });
    };
    await handler.generate({ rootUri: repo.rootUri });
    assert.equal(repo.inputBox.value, 'feat(test): 添加暂存文件测试');
    assert.equal(other.inputBox.value, otherPrior, '模型结果不得填写到 B 仓库');
    assert.equal(requests, 1);
    assert.throws(
      () =>
        execFileSync('git', ['-C', repo.rootUri.fsPath, 'rev-parse', '--verify', 'HEAD'], {
          stdio: 'pipe',
        }),
      '生成不得自动提交',
    );

    repo.inputBox.value = '';
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    globalThis.fetch = async (_input, init) => {
      requests++;
      started();
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    };
    const first = handler.generate({ rootUri: repo.rootUri });
    await requestStarted;
    await handler.generate({ rootUri: repo.rootUri });
    assert.equal(requests, 2, '重复点击不得发送第二个请求');
    await handler.cancel({ rootUri: repo.rootUri });
    await first;
    assert.equal(repo.inputBox.value, '', '取消后不得填写输入框');

    await configuration.update('outputFormat', 'prompt', vscode.ConfigurationTarget.Workspace);
    await configuration.update('promptFile', 'CODEBUDDY.md', vscode.ConfigurationTarget.Workspace);
    const detailed = 'feat(test): 添加暂存文件测试\n\n- 新增测试文件\n- 验证仓库输入框';
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      assert.ok(body.messages[0].content.includes('空一行后列出受影响功能'));
      return Response.json({ choices: [{ message: { content: detailed } }] });
    };
    await handler.generate({ rootUri: repo.rootUri });
    assert.equal(repo.inputBox.value, detailed, '提示词文件定义的多行格式应写入 SCM');
    assert.equal(other.inputBox.value, otherPrior, '多行结果仍须隔离仓库');

    execFileSync('git', ['-C', other.rootUri.fsPath, 'rm', '--cached', '-q', '集成测试.ts']);
    const working = await new GitService().preferredDiff(other.rootUri.fsPath);
    assert.equal(working.source, 'workingTree');
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      assert.match(body.messages.at(-1)?.content ?? '', /Git 工作区未暂存变更总计/);
      return Response.json({ choices: [{ message: { content: detailed } }] });
    };
    await handler.generate({ rootUri: other.rootUri });
    assert.equal(other.inputBox.value, detailed, '无暂存变更时应使用工作区文件并填写所选仓库');
    assert.equal(repo.inputBox.value, detailed, '工作区模式不得影响另一仓库');
  } finally {
    handler.dispose();
    globalThis.fetch = priorFetch;
    repo.inputBox.value = prior;
    other.inputBox.value = otherPrior;
    await configuration.update('provider', priorProvider, vscode.ConfigurationTarget.Workspace);
    await configuration.update('baseUrl', priorUrl, vscode.ConfigurationTarget.Workspace);
    await configuration.update('model', priorModel, vscode.ConfigurationTarget.Workspace);
    await configuration.update(
      'outputFormat',
      priorOutputFormat,
      vscode.ConfigurationTarget.Workspace,
    );
    await configuration.update('promptFile', priorPromptFile, vscode.ConfigurationTarget.Workspace);
  }
}
