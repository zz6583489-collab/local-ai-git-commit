import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitApi, GitExtension, GitRepository } from '../../types/git';

export async function getGitApi(): Promise<GitApi> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) throw new Error('未找到 VS Code 内置 Git 扩展，请启用它。');
  if (!extension.isActive) await extension.activate();
  return extension.exports.getAPI(1);
}

function contextUri(context: unknown): vscode.Uri | undefined {
  if (!context || typeof context !== 'object') return undefined;
  // VS Code 返回的 URI 在扩展主机中可能不是同一个 JS constructor，按公开形状判断。
  const candidate =
    'rootUri' in context
      ? context.rootUri
      : 'resourceUri' in context
        ? context.resourceUri
        : undefined;
  if (
    candidate &&
    typeof candidate === 'object' &&
    'scheme' in candidate &&
    'fsPath' in candidate &&
    'toString' in candidate &&
    typeof candidate.toString === 'function'
  ) {
    return candidate as vscode.Uri;
  }
  return undefined;
}

export async function selectRepository(
  api: GitApi,
  context?: unknown,
): Promise<GitRepository | undefined> {
  const repos = api.repositories.filter(
    (repo) => repo.rootUri.scheme === 'file' && !repo.isUsingVirtualFileSystem,
  );
  if (!repos.length) throw new Error('未找到本地 Git 仓库。');
  const uri = contextUri(context);
  if (uri) {
    const matching = repos.filter((repo) => repo.rootUri.toString() === uri.toString());
    if (matching.length === 1) return matching[0];
    const byResource = api.getRepository(uri);
    if (byResource) {
      const local = repos.find((repo) => repo.rootUri.toString() === byResource.rootUri.toString());
      if (local) return local;
    }
  }
  if (repos.length === 1) return repos[0];
  const selected = repos.filter((repo) => repo.ui.selected);
  if (selected.length === 1) return selected[0];
  const items = repos.map((repo) => ({
    label: path.basename(repo.rootUri.fsPath),
    description: repo.rootUri.fsPath,
    detail: `${repo.state.indexChanges.length} 个暂存文件`,
    repo,
  }));
  return (
    await vscode.window.showQuickPick(items, { placeHolder: '选择要生成提交信息的 Git 仓库' })
  )?.repo;
}
