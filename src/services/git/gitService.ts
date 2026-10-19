import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ChangeKind, DiffSource, StagedDiff, StagedFile } from '../../types/git';

const execFileAsync = promisify(execFile);

async function git(
  executable: string,
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await execFileAsync(executable, ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      signal,
    });
    return result.stdout;
  } catch (error) {
    if (signal?.aborted) throw new Error('生成已取消。');
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ) {
      throw new Error('单个暂存文件的差异超过 32 MiB，请拆分暂存内容。');
    }
    throw new Error('读取 Git 变更失败，请检查 Git 是否可用及仓库状态。');
  }
}

function parseNames(raw: string): { kind: ChangeKind; path: string; oldPath?: string }[] {
  const fields = raw.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const files: { kind: ChangeKind; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    const code = status[0];
    const old = fields[i++];
    if (!old) throw new Error('Git 暂存文件列表格式无效。');
    if (code === 'R' || code === 'C') {
      const path = fields[i++];
      if (!path) throw new Error('Git 重命名文件列表格式无效。');
      files.push({ kind: code === 'R' ? 'renamed' : 'copied', oldPath: old, path });
    } else {
      const kind: ChangeKind =
        code === 'A' ? 'added' : code === 'M' ? 'modified' : code === 'D' ? 'deleted' : 'other';
      files.push({ kind, path: old });
    }
  }
  return files;
}

function countLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export class GitService {
  constructor(private readonly executable = 'git') {}

  private async stagedNames(
    root: string,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseNames>> {
    return parseNames(
      await git(
        this.executable,
        root,
        ['diff', '--cached', '--name-status', '-z', '-M', '--no-ext-diff'],
        signal,
      ),
    );
  }

  async fingerprint(
    root: string,
    signal?: AbortSignal,
    source: DiffSource = 'staged',
  ): Promise<string> {
    if (source === 'workingTree') {
      if ((await this.stagedNames(root, signal)).length)
        throw new Error('生成期间出现新的暂存变更，请重新生成。');
      return (await this.workingSnapshot(root, signal)).fingerprint;
    }
    const raw = await git(
      this.executable,
      root,
      ['diff', '--cached', '--raw', '-z', '--no-ext-diff'],
      signal,
    );
    return createHash('sha256').update(raw).digest('hex');
  }

  async stagedDiff(root: string, signal?: AbortSignal): Promise<StagedDiff> {
    const before = await this.fingerprint(root, signal);
    const names = await this.stagedNames(root, signal);
    if (names.length === 0) throw new Error('该仓库暂存区为空，请先暂存需要提交的变更。');
    const files: StagedFile[] = [];
    for (const file of names) {
      const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
      const patch = await git(
        this.executable,
        root,
        [
          'diff',
          '--cached',
          '-M',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--unified=3',
          '--',
          ...paths,
        ],
        signal,
      );
      if (!patch) throw new Error(`无法读取暂存文件差异：${file.path}`);
      const { additions, deletions } = countLines(patch);
      files.push({
        ...file,
        patch,
        additions,
        deletions,
        binary: patch.includes('Binary files ') || patch.includes('GIT binary patch'),
      });
    }
    const after = await this.fingerprint(root, signal);
    if (before !== after) throw new Error('生成期间暂存区发生变化，请重新生成。');
    return {
      source: 'staged',
      files,
      fingerprint: before,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  }

  async preferredDiff(root: string, signal?: AbortSignal): Promise<StagedDiff> {
    if ((await this.stagedNames(root, signal)).length) return this.stagedDiff(root, signal);
    return this.workingDiff(root, signal);
  }

  async workingDiff(root: string, signal?: AbortSignal): Promise<StagedDiff> {
    if ((await this.stagedNames(root, signal)).length)
      throw new Error('暂存区已有变更，请优先根据暂存区生成。');
    const snapshot = await this.workingSnapshot(root, signal);
    if (!snapshot.files.length) throw new Error('该仓库没有暂存或工作区变更。');
    if (snapshot.fingerprint !== (await this.fingerprint(root, signal, 'workingTree'))) {
      throw new Error('读取期间工作区变更发生变化，请重新生成。');
    }
    return snapshot;
  }

  private async workingSnapshot(root: string, signal?: AbortSignal): Promise<StagedDiff> {
    const tracked = parseNames(
      await git(
        this.executable,
        root,
        ['diff', '--name-status', '-z', '-M', '--no-ext-diff'],
        signal,
      ),
    );
    const untrackedRaw = await git(
      this.executable,
      root,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      signal,
    );
    const untracked = untrackedRaw.split('\0').filter(Boolean);
    const files: StagedFile[] = [];
    const hash = createHash('sha256');
    for (const file of tracked) {
      if (signal?.aborted) throw new Error('生成已取消。');
      const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
      const patch = await git(
        this.executable,
        root,
        [
          'diff',
          '-M',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--unified=3',
          '--',
          ...paths,
        ],
        signal,
      );
      if (!patch) throw new Error(`无法读取工作区文件差异：${file.path}`);
      const { additions, deletions } = countLines(patch);
      const binary = patch.includes('Binary files ') || patch.includes('GIT binary patch');
      files.push({ ...file, patch, additions, deletions, binary });
      hash.update(JSON.stringify([file.path, file.oldPath, file.kind, patch]));
      if (binary && file.kind !== 'deleted') {
        const fullPath = path.resolve(root, file.path);
        const stat = await lstat(fullPath);
        if (stat.isFile() && stat.size > 32 * 1024 * 1024)
          throw new Error(`工作区文件 ${file.path} 超过 32 MiB，请缩小变更范围。`);
        hash.update(stat.isSymbolicLink() ? await readlink(fullPath) : await readFile(fullPath));
      }
    }
    for (const name of untracked) {
      if (signal?.aborted) throw new Error('生成已取消。');
      const fullPath = path.resolve(root, name);
      const stat = await lstat(fullPath);
      let patch: string;
      let additions = 0;
      let binary = false;
      if (stat.isSymbolicLink()) {
        hash.update(await readlink(fullPath));
        patch = `diff --git a/${JSON.stringify(name)} b/${JSON.stringify(name)}\n[new symbolic link: target content not read]`;
        binary = true;
      } else if (stat.isFile()) {
        if (stat.size > 32 * 1024 * 1024)
          throw new Error(`未跟踪文件 ${name} 超过 32 MiB，请缩小变更范围。`);
        const bytes = await readFile(fullPath);
        if (bytes.length > 32 * 1024 * 1024)
          throw new Error(`未跟踪文件 ${name} 超过 32 MiB，请缩小变更范围。`);
        hash.update(bytes);
        let content: string | undefined;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          binary = true;
        }
        if (bytes.includes(0)) binary = true;
        if (binary) {
          patch = `diff --git a/${JSON.stringify(name)} b/${JSON.stringify(name)}\nBinary files /dev/null and b/${JSON.stringify(name)} differ`;
        } else {
          const lines = content!.split(/\r?\n/);
          if (lines.at(-1) === '') lines.pop();
          additions = lines.length;
          patch = `diff --git a/${JSON.stringify(name)} b/${JSON.stringify(name)}\nnew file mode 100644\n--- /dev/null\n+++ b/${JSON.stringify(name)}\n@@ -0,0 +1,${additions} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
        }
      } else {
        continue;
      }
      hash.update(JSON.stringify([name, 'added', binary]));
      files.push({ path: name, kind: 'added', additions, deletions: 0, binary, patch });
    }
    return {
      source: 'workingTree',
      files,
      fingerprint: hash.digest('hex'),
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  }
}
