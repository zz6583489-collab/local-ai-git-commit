import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Settings } from '../../config/settings';
import { AiClient } from '../../services/ai/aiClient';
import { ApiKeyManager } from '../../services/ai/apiKeyManager';
import { completionUrl } from '../../services/ai/providerRegistry';

const settings: Settings = {
  provider: 'custom',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  language: 'zh-CN',
  timeout: 1000,
  temperature: 0.2,
  sendTemperature: false,
  maxDiffLength: 30000,
  maxContextTokens: 16000,
  maxSummaryCalls: 10,
  autoFill: true,
  confirmOverwrite: true,
  conventionalCommits: true,
  customPrompt: '',
  outputFormat: 'singleLine',
  promptFile: '',
};

test('拼接端点并拒绝 URL 中的凭据和不安全远端 HTTP', () => {
  assert.equal(
    completionUrl('https://example.test/v1/'),
    'https://example.test/v1/chat/completions',
  );
  assert.equal(
    completionUrl('https://example.test/v1/chat/completions'),
    'https://example.test/v1/chat/completions',
  );
  assert.throws(() => completionUrl('http://example.test/v1'), /HTTPS/);
  assert.throws(() => completionUrl('https://user:secret@example.test/v1'), /凭据/);
});

test('发送 Bearer Token 与最小参数，响应解析且无温度参数', async () => {
  let seen: RequestInit | undefined;
  const client = new AiClient(async (url, init) => {
    assert.equal(url, 'https://example.test/v1/chat/completions');
    seen = init;
    return Response.json({ choices: [{ message: { content: 'fix(core): 修复错误' } }] });
  });
  assert.equal(
    await client.complete(
      [{ role: 'user', content: 'test' }],
      settings,
      'secret-123',
      new AbortController().signal,
    ),
    'fix(core): 修复错误',
  );
  assert.equal((seen?.headers as Record<string, string>).Authorization, 'Bearer secret-123');
  const body = JSON.parse(String(seen?.body)) as Record<string, unknown>;
  assert.equal(body.model, 'test-model');
  assert.equal('temperature' in body, false);
});

test('401/403/404/500 错误不泄露服务端内容或密钥', async () => {
  for (const status of [401, 403, 404, 500]) {
    const client = new AiClient(async () => new Response('secret-123 server details', { status }));
    await assert.rejects(
      client.complete([], settings, 'secret-123', new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(String(status)));
        assert.doesNotMatch(error.message, /secret-123|server details/);
        return true;
      },
    );
  }
});

test('429 有限重试，用户取消及超时终止请求', async () => {
  let calls = 0;
  const client = new AiClient(async () => {
    calls++;
    return calls === 1
      ? new Response('', { status: 429 })
      : Response.json({ choices: [{ message: { content: 'ok' } }] });
  });
  assert.equal(await client.complete([], settings, 'key', new AbortController().signal), 'ok');
  assert.equal(calls, 2);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(client.complete([], settings, 'key', cancelled.signal), /取消/);
  const hanging = new AiClient(
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      ),
  );
  await assert.rejects(
    hanging.complete([], { ...settings, timeout: 20 }, 'key', new AbortController().signal),
    /超时/,
  );
});

test('密钥按服务商隔离并可删除', async () => {
  const storage = new Map<string, string>();
  const manager = new ApiKeyManager({
    get: async (key: string) => storage.get(key),
    store: async (key: string, value: string) => {
      storage.set(key, value);
    },
    delete: async (key: string) => {
      storage.delete(key);
    },
  } as never);
  await manager.set('custom', 'one');
  await manager.set('openai', 'two');
  assert.equal(await manager.get('custom'), 'one');
  assert.equal(await manager.get('openai'), 'two');
  await manager.delete('openai');
  assert.equal(await manager.has('openai'), false);
  assert.equal(storage.has('aiGitCommit.apiKey'), true);
});

test('密钥存储故障不会把原始异常和密钥输出给用户', async () => {
  const manager = new ApiKeyManager({
    get: async () => {
      throw new Error('secret-123');
    },
    store: async () => {
      throw new Error('secret-123');
    },
    delete: async () => {
      throw new Error('secret-123');
    },
  } as never);
  for (const action of [
    manager.get('custom'),
    manager.set('custom', 'secret-123'),
    manager.delete('custom'),
  ]) {
    await assert.rejects(action, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /secret-123/);
      return true;
    });
  }
});

test('请求体包含疑似密钥时，发出网络请求前终止', async () => {
  let calls = 0;
  const client = new AiClient(async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  });
  const dummy = `sk-${'A'.repeat(32)}`;
  await assert.rejects(
    client.complete(
      [{ role: 'user', content: `文件内容：${dummy}` }],
      settings,
      'safe-auth-key',
      new AbortController().signal,
    ),
    /可能包含凭据/,
  );
  assert.equal(calls, 0);
});
