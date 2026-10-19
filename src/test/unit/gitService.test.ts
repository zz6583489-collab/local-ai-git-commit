import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { GitService } from '../../services/git/gitService';

const root = mkdtempSync(join(tmpdir(), 'ai-git-commit-tests-'));
after(() => rmSync(root, { recursive: true, force: true }));

function run(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function newRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  run(dir, 'init', '-q');
  run(dir, 'config', 'user.email', 'test@example.com');
  run(dir, 'config', 'user.name', 'Test');
  return dir;
}

test('只读取暂存区，中文路径与未暂存内容隔离', async () => {
  const dir = newRepo('中文仓库');
  writeFileSync(join(dir, '中文.vue'), '<template>已暂存</template>\n');
  run(dir, 'add', '中文.vue');
  writeFileSync(join(dir, '中文.vue'), '<template>未暂存</template>\n');
  const diff = await new GitService().stagedDiff(dir);
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0].path, '中文.vue');
  assert.match(diff.files[0].patch, /已暂存/);
  assert.doesNotMatch(diff.files[0].patch, /未暂存/);
  assert.equal(diff.files[0].kind, 'added');
  assert.equal(run(dir, 'status', '--porcelain').trim().startsWith('AM'), true);
});

test('多仓库暂存区隔离；空暂存区明确报错', async () => {
  const a = newRepo('repo-a');
  const b = newRepo('repo-b');
  writeFileSync(join(a, 'a.ts'), 'a\n');
  writeFileSync(join(b, 'b.ts'), 'b\n');
  run(a, 'add', 'a.ts');
  run(b, 'add', 'b.ts');
  const service = new GitService();
  const [left, right] = await Promise.all([service.stagedDiff(a), service.stagedDiff(b)]);
  assert.equal(left.files[0].path, 'a.ts');
  assert.equal(right.files[0].path, 'b.ts');
  assert.notEqual(left.fingerprint, right.fingerprint);
  const empty = newRepo('empty');
  await assert.rejects(service.stagedDiff(empty), /暂存区为空/);
});

test('识别修改、删除、重命名和新增文件', async () => {
  const dir = newRepo('kinds');
  writeFileSync(join(dir, 'edit.ts'), 'old\n');
  writeFileSync(join(dir, 'delete.py'), 'remove\n');
  writeFileSync(join(dir, 'old.java'), 'class Example {}\n');
  run(dir, 'add', '.');
  run(dir, 'commit', '-qm', 'initial');
  writeFileSync(join(dir, 'edit.ts'), 'new\n');
  run(dir, 'rm', 'delete.py');
  renameSync(join(dir, 'old.java'), join(dir, '新.java'));
  writeFileSync(join(dir, 'new.vue'), '<script setup lang="ts"></script>\n');
  run(dir, 'add', '.');
  const diff = await new GitService().stagedDiff(dir);
  assert.deepEqual(
    new Set(diff.files.map((f) => f.kind)),
    new Set(['added', 'modified', 'deleted', 'renamed']),
  );
  assert.ok(diff.files.find((f) => f.path === '新.java' && f.oldPath === 'old.java'));
  assert.ok(diff.additions > 0 && diff.deletions > 0);
});

test('暂存区指纹在内容变化时变化，读取不提交仓库', async () => {
  const dir = newRepo('fingerprint');
  writeFileSync(join(dir, 'file.txt'), 'one\n');
  run(dir, 'add', '.');
  const service = new GitService();
  const first = await service.fingerprint(dir);
  writeFileSync(join(dir, 'file.txt'), 'two\n');
  run(dir, 'add', '.');
  assert.notEqual(first, await service.fingerprint(dir));
  await service.stagedDiff(dir);
  assert.throws(() => run(dir, 'rev-parse', 'HEAD'));
});

test('有暂存变更时优先只分析暂存区，忽略同文件未暂存内容和未跟踪文件', async () => {
  const dir = newRepo('staged-priority');
  writeFileSync(join(dir, 'feature.ts'), 'staged-version\n');
  run(dir, 'add', 'feature.ts');
  writeFileSync(join(dir, 'feature.ts'), 'working-version\n');
  writeFileSync(join(dir, 'untracked.ts'), 'untracked-version\n');
  const diff = await new GitService().preferredDiff(dir);
  assert.equal(diff.source, 'staged');
  assert.deepEqual(
    diff.files.map((file) => file.path),
    ['feature.ts'],
  );
  assert.match(diff.files[0].patch, /staged-version/);
  assert.doesNotMatch(diff.files[0].patch, /working-version|untracked-version/);
});

test('没有暂存变更时分析已跟踪的工作区修改和未跟踪的中文文件', async () => {
  const dir = newRepo('working-fallback');
  writeFileSync(join(dir, 'tracked.py'), 'before\n');
  run(dir, 'add', 'tracked.py');
  run(dir, 'commit', '-qm', 'initial');
  writeFileSync(join(dir, 'tracked.py'), 'after\n');
  writeFileSync(join(dir, '中文新文件.vue'), '<template>新增</template>\n');
  const service = new GitService();
  const diff = await service.preferredDiff(dir);
  assert.equal(diff.source, 'workingTree');
  assert.deepEqual(
    new Set(diff.files.map((file) => file.path)),
    new Set(['tracked.py', '中文新文件.vue']),
  );
  assert.match(diff.files.find((file) => file.path === 'tracked.py')?.patch ?? '', /after/);
  assert.match(diff.files.find((file) => file.path === '中文新文件.vue')?.patch ?? '', /新增/);
  const before = diff.fingerprint;
  writeFileSync(join(dir, '中文新文件.vue'), '<template>变化</template>\n');
  assert.notEqual(before, await service.fingerprint(dir, undefined, 'workingTree'));
  run(dir, 'add', 'tracked.py');
  assert.equal((await service.preferredDiff(dir)).source, 'staged');
});

test('工作区未跟踪二进制文件仅提供元数据；无变更明确报错', async () => {
  const dir = newRepo('working-binary');
  const service = new GitService();
  await assert.rejects(service.preferredDiff(dir), /没有暂存或工作区变更/);
  writeFileSync(join(dir, 'image.bin'), Buffer.from([0, 255, 128, 1]));
  const diff = await service.preferredDiff(dir);
  assert.equal(diff.source, 'workingTree');
  assert.equal(diff.files[0].binary, true);
  assert.match(diff.files[0].patch, /Binary files/);
});
