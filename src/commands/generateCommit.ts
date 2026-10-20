import * as vscode from 'vscode';
import { readSettings } from '../config/settings';
import { AiClient } from '../services/ai/aiClient';
import { ApiKeyManager } from '../services/ai/apiKeyManager';
import { CommitService, SummaryLimitError } from '../services/commit/commitService';
import { isDependencyLockfile } from '../services/commit/diffClassification';
import { loadFormatPrompt } from '../services/commit/promptFile';
import { GitService } from '../services/git/gitService';
import { getGitApi, selectRepository } from '../services/git/repositoryManager';
import { assertSafeDiff, assertSafeText } from '../services/security/secretGuard';
import type { GitRepository } from '../types/git';

export class CommitCommands {
  private readonly active = new Map<string, AbortController>();
  private readonly last = new Map<string, string>();

  constructor(
    private readonly keys: ApiKeyManager,
    private readonly log: (event: string) => void,
  ) {}

  private async pickRepo(context?: unknown): Promise<GitRepository | undefined> {
    return selectRepository(await getGitApi(), context);
  }

  async generate(context?: unknown): Promise<void> {
    const repo = await this.pickRepo(context);
    if (!repo) return;
    const root = repo.rootUri.fsPath;
    if (this.active.has(root)) {
      void vscode.window.showInformationMessage('该仓库正在生成提交信息，可通过“取消生成”中止。');
      return;
    }
    const controller = new AbortController();
    this.active.set(root, controller);
    try {
      const settings = readSettings(repo.rootUri);
      const formatPrompt = await loadFormatPrompt(root, settings.promptFile, settings.customPrompt);
      assertSafeText(formatPrompt);
      const key = await this.keys.get(settings.provider);
      if (!key) throw new Error('尚未配置当前服务商的 API Key，请执行 Set API Key 命令。');
      this.log('开始生成');
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `AI Git Commit：${repo.rootUri.path.split('/').at(-1)}`,
          cancellable: true,
        },
        async (progress, token) => {
          const disposable = token.onCancellationRequested(() => controller.abort());
          try {
            progress.report({ message: '检查暂存区和工作区' });
            const git = new GitService((await getGitApi()).git.path);
            const diff = await git.preferredDiff(root, controller.signal);
            if (controller.signal.aborted) return;
            assertSafeDiff(diff);
            progress.report({
              message: diff.source === 'staged' ? '分析暂存区变更' : '暂存区为空，分析工作区变更',
            });
            const binaryCount = diff.files.filter((file) => file.binary).length;
            if (binaryCount)
              void vscode.window.showWarningMessage(
                `${binaryCount} 个二进制变更文件只能依据文件名和变更类型分析，无法读取内部内容。`,
              );
            const lockfileCount = diff.files.filter((file) =>
              isDependencyLockfile(file.path),
            ).length;
            if (lockfileCount)
              void vscode.window.showWarningMessage(
                `${lockfileCount} 个依赖锁文件仅依据文件名和变更统计分析，未发送其完整差异；请核对依赖清单。`,
              );
            const service = new CommitService(new AiClient());
            const generate = (limit: number) =>
              service.generate(
                diff,
                { ...settings, maxSummaryCalls: limit },
                key,
                controller.signal,
                (message) => progress.report({ message }),
                formatPrompt,
              );
            let answer: string;
            try {
              answer = await generate(settings.maxSummaryCalls);
            } catch (error) {
              if (!(error instanceof SummaryLimitError) || error.requiredCalls > 30) throw error;
              const choice = await vscode.window.showWarningMessage(
                `完整分析需要 ${error.requiredCalls} 次局部摘要，超过设置的 ${error.configuredCalls} 次；加上最终生成至少会调用 ${error.requiredCalls + 1} 次 API，可能产生费用。是否仅本次继续？`,
                { modal: true },
                '本次继续',
              );
              if (choice !== '本次继续' || controller.signal.aborted) return;
              answer = await generate(error.requiredCalls);
            }
            if (controller.signal.aborted) return;
            if (diff.fingerprint !== (await git.fingerprint(root, controller.signal, diff.source)))
              throw new Error('生成期间所选 Git 变更发生变化，请重新生成。');
            if (controller.signal.aborted) return;
            await this.presentResult(
              repo,
              answer,
              settings.autoFill,
              settings.confirmOverwrite,
              controller.signal,
              diff.source,
            );
            if (controller.signal.aborted) return;
            this.last.set(root, answer);
            this.log('生成成功');
          } finally {
            disposable.dispose();
          }
        },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        this.log('生成已取消');
        void vscode.window.showInformationMessage('已取消生成。');
        return;
      }
      throw error;
    } finally {
      this.active.delete(root);
    }
  }

  private async presentResult(
    repo: GitRepository,
    answer: string,
    autoFill: boolean,
    confirmOverwrite: boolean,
    signal: AbortSignal,
    source: 'staged' | 'workingTree',
  ): Promise<void> {
    if (!autoFill) {
      const choice = await vscode.window.showInformationMessage(
        `已根据${source === 'staged' ? '暂存区' : '工作区未暂存'}变更生成：${answer}`,
        '复制',
        '填写',
      );
      if (signal.aborted) return;
      if (choice === '复制') await vscode.env.clipboard.writeText(answer);
      if (choice !== '填写') return;
    }
    const previous = repo.inputBox.value;
    if (previous.trim() && previous !== answer && confirmOverwrite) {
      const choice = await vscode.window.showWarningMessage(
        '当前仓库已有提交信息，是否覆盖？',
        '覆盖',
        '仅复制',
      );
      if (signal.aborted) return;
      if (repo.inputBox.value !== previous)
        throw new Error('确认期间提交输入框发生变化，已停止覆盖。');
      if (choice === '仅复制') {
        await vscode.env.clipboard.writeText(answer);
        void vscode.window.showInformationMessage('已复制生成的提交信息。');
        return;
      }
      if (choice !== '覆盖') return;
    }
    if (signal.aborted) return;
    if (repo.inputBox.value !== previous) throw new Error('提交输入框发生变化，已停止覆盖。');
    repo.inputBox.value = answer;
    void vscode.window.showInformationMessage(
      `已根据${source === 'staged' ? '暂存区' : '工作区未暂存'}变更填写当前仓库的 SCM 提交输入框。`,
    );
  }

  async copy(context?: unknown): Promise<void> {
    const repo = await this.pickRepo(context);
    if (!repo) return;
    const answer = this.last.get(repo.rootUri.fsPath);
    if (!answer) throw new Error('该仓库尚无生成结果，请先生成。');
    await vscode.env.clipboard.writeText(answer);
    void vscode.window.showInformationMessage('已复制该仓库最近生成的提交信息。');
  }

  async cancel(context?: unknown): Promise<void> {
    const repo = await this.pickRepo(context);
    if (!repo) return;
    const controller = this.active.get(repo.rootUri.fsPath);
    if (!controller) {
      void vscode.window.showInformationMessage('该仓库当前没有生成任务。');
      return;
    }
    controller.abort();
  }

  dispose(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }
}
