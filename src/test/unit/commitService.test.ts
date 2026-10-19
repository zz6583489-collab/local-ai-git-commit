import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Settings } from '../../config/settings';
import { AiClient } from '../../services/ai/aiClient';
import { CommitService } from '../../services/commit/commitService';
import { validateCommitMessage } from '../../services/commit/commitValidator';
import { systemPrompt } from '../../services/commit/commitPrompt';
import type { StagedDiff } from '../../types/git';

const settings: Settings = {
  provider: 'custom',
  baseUrl: 'https://example.test/v1',
  model: 'mock',
  language: 'zh-CN',
  timeout: 1000,
  temperature: 0.2,
  sendTemperature: false,
  maxDiffLength: 2000,
  maxContextTokens: 16000,
  maxSummaryCalls: 10,
  autoFill: true,
  confirmOverwrite: true,
  conventionalCommits: true,
  customPrompt: '',
  outputFormat: 'singleLine',
  promptFile: '',
};

test('校验 Conventional Commit 并拒绝多行和 Markdown', () => {
  assert.equal(validateCommitMessage('feat(auth): 新增登录验证', true), undefined);
  assert.match(validateCommitMessage('修改代码', true) ?? '', /Conventional/);
  assert.match(validateCommitMessage('fix: 修复问题\n附言', true) ?? '', /单行/);
  assert.match(validateCommitMessage('`fix: 修复问题`', true) ?? '', /Markdown/);
});

test('提示词格式允许 CODEBUDDY 风格的多行提交信息', async () => {
  const detailed =
    'feat(feature): 添加平台维度控制功能开关\n\n- 新增平台常量\n- 根据平台过滤功能开关';
  assert.equal(validateCommitMessage(detailed, true, 'prompt'), undefined);
  assert.match(validateCommitMessage(detailed, true, 'singleLine') ?? '', /单行/);
  assert.match(
    validateCommitMessage('feat(feature): 添加功能\n- 缺少空行', true, 'prompt') ?? '',
    /空一行/,
  );
  const promptSettings: Settings = { ...settings, outputFormat: 'prompt' };
  const prompt = systemPrompt(promptSettings, '第一行后空一行，列出受影响功能');
  assert.match(prompt, /第一行后空一行/);
  assert.doesNotMatch(prompt, /只输出一行/);

  const diff: StagedDiff = {
    files: [
      {
        path: 'feature.ts',
        kind: 'modified',
        additions: 1,
        deletions: 0,
        binary: false,
        patch: '+platform\n',
      },
    ],
    source: 'staged',
    fingerprint: 'x',
    additions: 1,
    deletions: 0,
  };
  const client = new AiClient(async () =>
    Response.json({ choices: [{ message: { content: detailed } }] }),
  );
  assert.equal(
    await new CommitService(client).generate(
      diff,
      promptSettings,
      'key',
      new AbortController().signal,
      () => {},
      '第一行后空一行，列出受影响功能',
    ),
    detailed,
  );
});

test('格式错误只修复一次并生成有效消息', async () => {
  let calls = 0;
  const client = new AiClient(async () => {
    calls++;
    return Response.json({
      choices: [{ message: { content: calls === 1 ? 'bad' : 'fix(core): 修复边界条件' } }],
    });
  });
  const diff: StagedDiff = {
    files: [
      {
        path: 'a.ts',
        kind: 'modified',
        additions: 1,
        deletions: 0,
        binary: false,
        patch: '+fix\n',
      },
    ],
    source: 'staged',
    fingerprint: 'x',
    additions: 1,
    deletions: 0,
  };
  const answer = await new CommitService(client).generate(
    diff,
    settings,
    'key',
    new AbortController().signal,
    () => {},
  );
  assert.equal(answer, 'fix(core): 修复边界条件');
  assert.equal(calls, 2);
});

test('大型差异完整分块、有限摘要且超出上限明确失败', async () => {
  const lines = Array.from({ length: 70 }, (_, i) => `+unique-line-${i}-${'x'.repeat(35)}`).join(
    '\n',
  );
  const diff: StagedDiff = {
    files: [
      {
        path: 'large.vue',
        kind: 'modified',
        additions: 70,
        deletions: 0,
        binary: false,
        patch: lines,
      },
    ],
    source: 'staged',
    fingerprint: 'x',
    additions: 70,
    deletions: 0,
  };
  const seen: string[] = [];
  const client = new AiClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    seen.push(body.messages.at(-1)?.content ?? '');
    return Response.json({
      choices: [
        { message: { content: seen.length < 4 ? '局部摘要' : 'feat(large): 完成大型变更' } },
      ],
    });
  });
  await assert.rejects(
    new CommitService(client).generate(
      diff,
      { ...settings, maxSummaryCalls: 1 },
      'key',
      new AbortController().signal,
      () => {},
    ),
    /超过设定上限/,
  );
  assert.equal(seen.length, 0);
  const summaryClient = new AiClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const content = body.messages.at(-1)?.content ?? '';
    seen.push(content);
    return Response.json({
      choices: [
        {
          message: {
            content: content.includes('最终提交信息') ? 'feat(large): 完成大型变更' : '局部摘要',
          },
        },
      ],
    });
  });
  assert.equal(
    await new CommitService(summaryClient).generate(
      diff,
      settings,
      'key',
      new AbortController().signal,
      () => {},
    ),
    'feat(large): 完成大型变更',
  );
  for (let i = 0; i < 70; i++)
    assert.equal(seen.filter((part) => part.includes(`+unique-line-${i}-`)).length, 1);
});

test('大量源码与依赖锁文件可在默认摘要上限内生成，源码完整覆盖', async () => {
  const files = Array.from({ length: 30 }, (_, i) => ({
    path: `src/file-${i}.ts`,
    kind: 'added' as const,
    additions: 1,
    deletions: 0,
    binary: false,
    patch: `+source-marker-${i}-${'x'.repeat(1200)}\n`,
  }));
  const diff: StagedDiff = {
    files: [
      {
        path: 'package-lock.json',
        kind: 'added',
        additions: 5636,
        deletions: 0,
        binary: false,
        patch: Array.from({ length: 5636 }, (_, i) => `+lock-marker-${i}-${'y'.repeat(22)}`).join(
          '\n',
        ),
      },
      ...files,
    ],
    source: 'staged',
    fingerprint: 'x',
    additions: 5666,
    deletions: 0,
  };
  const requests: string[] = [];
  const client = new AiClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const content = body.messages.at(-1)?.content ?? '';
    requests.push(content);
    return Response.json({
      choices: [
        {
          message: {
            content: content.includes('请生成最终提交信息')
              ? 'feat(core): 实现插件功能'
              : '局部事实摘要',
          },
        },
      ],
    });
  });
  assert.equal(
    await new CommitService(client).generate(
      diff,
      { ...settings, maxDiffLength: 30000 },
      'key',
      new AbortController().signal,
      () => {},
    ),
    'feat(core): 实现插件功能',
  );
  assert.ok(requests.length <= 11, '局部摘要应保持在默认 10 次以内，再加最终一次生成');
  for (let i = 0; i < 30; i++)
    assert.equal(requests.filter((part) => part.includes(`+source-marker-${i}-`)).length, 1);
  assert.equal(
    requests.some((part) => part.includes('lock-marker-100')),
    false,
  );
  assert.ok(requests.some((part) => part.includes('package-lock.json') && part.includes('仅分析')));
});

test('局部摘要超过 800 字符但最终请求仍在预算内时直接生成', async () => {
  const diff: StagedDiff = {
    source: 'staged',
    files: [
      {
        path: 'large.ts',
        kind: 'modified',
        additions: 600,
        deletions: 0,
        binary: false,
        patch: Array.from({ length: 600 }, (_, i) => `+line-${i}-${'x'.repeat(70)}`).join('\n'),
      },
    ],
    fingerprint: 'x',
    additions: 600,
    deletions: 0,
  };
  const longSummary = `实现说明：${'具体变更'.repeat(220)}`;
  let summaryCalls = 0;
  const client = new AiClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const user = body.messages.at(-1)?.content ?? '';
    if (user.includes('请生成最终提交信息')) {
      assert.match(user, /实现说明/);
      return Response.json({ choices: [{ message: { content: 'feat(core): 完成大型变更' } }] });
    }
    summaryCalls++;
    return Response.json({ choices: [{ message: { content: longSummary } }] });
  });
  assert.equal(
    await new CommitService(client).generate(
      diff,
      { ...settings, maxDiffLength: 50000, maxContextTokens: 30000 },
      'key',
      new AbortController().signal,
      () => {},
    ),
    'feat(core): 完成大型变更',
  );
  assert.ok(summaryCalls > 1);
});

test('局部摘要合计超过最终预算时压缩摘要，不重复发送代码差异', async () => {
  const diff: StagedDiff = {
    source: 'workingTree',
    files: [
      {
        path: 'many.vue',
        kind: 'modified',
        additions: 130,
        deletions: 0,
        binary: false,
        patch: Array.from({ length: 130 }, (_, i) => `+source-${i}-${'z'.repeat(70)}`).join('\n'),
      },
    ],
    fingerprint: 'x',
    additions: 130,
    deletions: 0,
  };
  let compressionCalls = 0;
  let diffCalls = 0;
  const client = new AiClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const user = body.messages.at(-1)?.content ?? '';
    if (user.includes('请生成最终提交信息'))
      return Response.json({ choices: [{ message: { content: 'refactor(ui): 整理界面逻辑' } }] });
    if (user.includes('<untrusted_summary>')) {
      compressionCalls++;
      assert.doesNotMatch(user, /\+source-/);
      return Response.json({
        choices: [{ message: { content: `压缩事实摘要 ${compressionCalls}` } }],
      });
    }
    diffCalls++;
    return Response.json({
      choices: [{ message: { content: `文件变更事实 ${'具体行为'.repeat(450)}` } }],
    });
  });
  assert.equal(
    await new CommitService(client).generate(
      diff,
      { ...settings, maxDiffLength: 4000, maxSummaryCalls: 8 },
      'key',
      new AbortController().signal,
      () => {},
    ),
    'refactor(ui): 整理界面逻辑',
  );
  assert.ok(diffCalls > 1);
  assert.ok(compressionCalls > 0);
});

test('摘要压缩不会越过配置的请求次数上限', async () => {
  const diff: StagedDiff = {
    source: 'staged',
    files: [
      {
        path: 'large.ts',
        kind: 'modified',
        additions: 130,
        deletions: 0,
        binary: false,
        patch: Array.from({ length: 130 }, (_, i) => `+line-${i}-${'x'.repeat(70)}`).join('\n'),
      },
    ],
    fingerprint: 'x',
    additions: 130,
    deletions: 0,
  };
  let calls = 0;
  const client = new AiClient(async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: '具体变更'.repeat(450) } }] });
  });
  await assert.rejects(
    new CommitService(client).generate(
      diff,
      { ...settings, maxDiffLength: 4000, maxSummaryCalls: 4 },
      'key',
      new AbortController().signal,
      () => {},
    ),
    /已达到 4 次摘要请求上限/,
  );
  assert.equal(calls, 4);
});
