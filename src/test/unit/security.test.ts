import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userSetting } from '../../config/trustedEndpoint';
import { assertSafeDiff } from '../../services/security/secretGuard';
import type { StagedDiff } from '../../types/git';

function diff(path: string, patch: string): StagedDiff {
  return {
    source: 'workingTree',
    files: [{ path, kind: 'added', additions: 1, deletions: 0, binary: false, patch }],
    fingerprint: 'x',
    additions: 1,
    deletions: 0,
  };
}

test('服务商与地址只采用用户级设置，不接受工作区覆盖', () => {
  assert.equal(
    userSetting(
      { globalValue: 'https://trusted.example/v1', workspaceValue: 'https://attacker.example/v1' },
      '',
    ),
    'https://trusted.example/v1',
  );
  assert.equal(
    userSetting({ defaultValue: 'custom', workspaceValue: 'openai' }, 'fallback'),
    'custom',
  );
});

test('敏感文件名和密钥内容在发送前被拦截，错误不回显密钥', () => {
  assert.throws(() => assertSafeDiff(diff('.env.local', '+DUMMY=1')), /可能包含凭据/);
  assert.throws(() => assertSafeDiff(diff('config/credentials.json', '+{}')), /可能包含凭据/);
  assert.throws(() => assertSafeDiff(diff('.aws/credentials', '+[default]')), /可能包含凭据/);
  const dummy = `sk-${'A'.repeat(32)}`;
  assert.throws(
    () => assertSafeDiff(diff('src/config.ts', `+const key = '${dummy}';`)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(dummy));
      return true;
    },
  );
  assert.doesNotThrow(() => assertSafeDiff(diff('.env.example', '+API_KEY=YOUR_API_KEY')));
});
