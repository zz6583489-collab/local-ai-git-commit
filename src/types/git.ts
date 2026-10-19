import type { Uri } from 'vscode';

// VS Code 内置 Git 扩展公开 API 中本插件使用的稳定子集。
export interface GitRepository {
  readonly rootUri: Uri;
  readonly inputBox: { value: string };
  readonly state: { readonly indexChanges: readonly unknown[] };
  readonly ui: { readonly selected: boolean };
  readonly isUsingVirtualFileSystem?: boolean;
}

export interface GitApi {
  readonly git: { readonly path: string };
  readonly repositories: readonly GitRepository[];
  getRepository(uri: Uri): GitRepository | null;
}

export interface GitExtension {
  getAPI(version: 1): GitApi;
}

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'other';
export type DiffSource = 'staged' | 'workingTree';

export interface StagedFile {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
}

export interface StagedDiff {
  source: DiffSource;
  files: StagedFile[];
  fingerprint: string;
  additions: number;
  deletions: number;
}
