import * as vscode from 'vscode';
import { readSettings } from '../config/settings';
import { AiClient } from '../services/ai/aiClient';
import { ApiKeyManager } from '../services/ai/apiKeyManager';
import { providerPreset, providers, type ProviderId } from '../services/ai/providerRegistry';

function currentProvider(): ProviderId {
  const id = vscode.workspace.getConfiguration('aiGitCommit').get<string>('provider', 'custom');
  if (!providerPreset(id)) throw new Error('服务商设置无效。');
  return id as ProviderId;
}

export class ConfigCommands {
  constructor(
    private readonly keys: ApiKeyManager,
    private readonly log: (event: string) => void,
  ) {}

  async setApiKey(): Promise<void> {
    const id = currentProvider();
    const value = await vscode.window.showInputBox({
      title: `设置 ${providerPreset(id)?.label} API Key`,
      prompt: '密钥仅存于 VS Code SecretStorage。暂存代码差异会发送给所选服务商。',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    await this.keys.set(id, value);
    this.log('密钥已设置');
    void vscode.window.showInformationMessage('当前服务商的 API Key 已安全保存。');
  }

  async deleteApiKey(): Promise<void> {
    await this.keys.delete(currentProvider());
    this.log('密钥已删除');
    void vscode.window.showInformationMessage('当前服务商的 API Key 已删除。');
  }

  async checkApiKey(): Promise<void> {
    const id = currentProvider();
    const configured = await this.keys.has(id);
    void vscode.window.showInformationMessage(
      `${providerPreset(id)?.label} API Key ${configured ? '已配置' : '尚未配置'}。`,
    );
  }

  async selectProvider(): Promise<void> {
    const chosen = await vscode.window.showQuickPick(
      providers.map((item) => ({ label: item.label, description: item.id, id: item.id })),
      { placeHolder: '选择 AI 服务商' },
    );
    if (!chosen) return;
    await vscode.workspace
      .getConfiguration('aiGitCommit')
      .update('provider', chosen.id, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration('aiGitCommit')
      .update('model', '', vscode.ConfigurationTarget.Global);
    if (chosen.id === 'custom') {
      const url = await vscode.window.showInputBox({
        title: '自定义 API Base URL',
        prompt: '暂存代码差异将发送到此服务商。请填写 HTTPS API 根地址。',
        value: vscode.workspace.getConfiguration('aiGitCommit').get<string>('baseUrl', ''),
      });
      if (url !== undefined)
        await vscode.workspace
          .getConfiguration('aiGitCommit')
          .update('baseUrl', url.trim(), vscode.ConfigurationTarget.Global);
    }
    void vscode.window.showInformationMessage(
      `已选择 ${chosen.label}。请配置模型并设置此服务商的 API Key。`,
    );
  }

  async configureModel(): Promise<void> {
    const current = vscode.workspace.getConfiguration('aiGitCommit').get<string>('model', '');
    const value = await vscode.window.showInputBox({
      title: '设置模型 ID',
      value: current || providerPreset(currentProvider())?.model,
      prompt: '填写服务商提供的 Chat Completions 模型 ID。',
    });
    if (value === undefined) return;
    if (!value.trim()) throw new Error('模型 ID 不能为空。');
    await vscode.workspace
      .getConfiguration('aiGitCommit')
      .update('model', value.trim(), vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('模型 ID 已保存。');
  }

  async testConnection(): Promise<void> {
    const settings = readSettings();
    const key = await this.keys.get(settings.provider);
    if (!key) throw new Error('尚未配置当前服务商的 API Key。');
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'AI Git Commit：测试连接',
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const disposable = token.onCancellationRequested(() => controller.abort());
        try {
          await new AiClient().complete(
            [{ role: 'user', content: '仅回复 OK' }],
            settings,
            key,
            controller.signal,
          );
          if (!controller.signal.aborted)
            void vscode.window.showInformationMessage('AI 服务连接成功。');
        } finally {
          disposable.dispose();
        }
      },
    );
  }
}
